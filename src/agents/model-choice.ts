import levenshtein from 'damerau-levenshtein';
import * as v from 'valibot';
import { modelAliases } from '../config.ts';
import type { ModelRoute } from './model-route.ts';
import { openAICodexModelSpecifier } from './openai-codex-route.ts';
import { OPENCODE_GO_PREFERRED_ID, openCodeGoModelSpecifier } from './opencode-go-catalog.ts';

export type ModelAlias = keyof typeof modelAliases;

function isModelAlias(name: string): name is ModelAlias {
	return Object.hasOwn(modelAliases, name);
}

const MODEL_ALIAS_NAMES = Object.keys(modelAliases).filter(isModelAlias);

const ALIAS_BY_MODEL_ID = new Map(
	MODEL_ALIAS_NAMES.map((alias) => [modelAliases[alias].modelId, alias] as const),
);

const thinkingLevels = ['low', 'medium', 'high'] as const;

export type ThinkingLevel = (typeof thinkingLevels)[number];

const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

// Shorthands prefix matching does not already cover (`lo`, `med`, `hi` do).
const THINKING_SHORTHANDS = new Map<string, ThinkingLevel>([['mid', 'medium']]);

/**
 * Model Choice recorded in `initialData` at thread start. Holds only what the
 * user gave; a missing model keeps the deployment default route.
 */
export const modelChoiceSchema = v.object({
	model: v.optional(
		v.object({ provider: v.picklist(['chatgpt', 'opencode-go']), modelId: v.string() }),
	),
	thinkingLevel: v.optional(v.picklist(thinkingLevels)),
	correctedFrom: v.optional(
		v.object({ model: v.optional(v.string()), think: v.optional(v.string()) }),
	),
});

export type ModelChoice = v.InferOutput<typeof modelChoiceSchema>;

export type Resolution<T extends string> =
	| { kind: 'match'; value: T; corrected: boolean }
	| { kind: 'unknown' }
	| { kind: 'ambiguous'; candidates: T[] };

/** Typos allowed for a name: one edit up to four letters, two beyond. */
export function distanceLimit(name: string): number {
	return name.length <= 4 ? 1 : 2;
}

export function resolveModelAlias(input: string): Resolution<ModelAlias> {
	return resolveName(input, MODEL_ALIAS_NAMES, ALIAS_BY_MODEL_ID);
}

export function resolveThinkingLevel(input: string): Resolution<ThinkingLevel> {
	return resolveName(input, thinkingLevels, THINKING_SHORTHANDS);
}

// Exact name, then exact synonym, then unique prefix; only the last step,
// edit distance, counts as a correction the run card shows.
function resolveName<T extends string>(
	input: string,
	names: readonly T[],
	synonyms: ReadonlyMap<string, T>,
): Resolution<T> {
	const wanted = input.toLowerCase();
	const exact = names.find((name) => name === wanted) ?? synonyms.get(wanted);

	if (exact !== undefined) return { kind: 'match', value: exact, corrected: false };

	const prefixed = names.filter((name) => name.startsWith(wanted));

	if (prefixed.length > 0) return single(prefixed, false);

	const near = names.filter((name) => levenshtein(wanted, name).steps <= distanceLimit(name));

	return near.length === 0 ? { kind: 'unknown' } : single(near, true);
}

function single<T extends string>(candidates: T[], corrected: boolean): Resolution<T> {
	const [only] = candidates;

	if (candidates.length === 1 && only !== undefined)
		return { kind: 'match', value: only, corrected };

	return { kind: 'ambiguous', candidates };
}

export type ModelChoiceResult = { ok: true; choice?: ModelChoice } | { ok: false; error: string };

/** Resolves raw `model:` / `think:` values into the choice `initialData` records. */
export function resolveModelChoice(args: { model?: string; think?: string }): ModelChoiceResult {
	const choice: ModelChoice = {};
	const correctedFrom: NonNullable<ModelChoice['correctedFrom']> = {};

	if (args.model !== undefined) {
		const resolved = resolveModelAlias(args.model);

		if (resolved.kind !== 'match')
			return { ok: false, error: failure('model', args.model, resolved) };
		const { provider, modelId } = modelAliases[resolved.value];

		choice.model = { provider, modelId };

		if (resolved.corrected) correctedFrom.model = args.model;
	}

	if (args.think !== undefined) {
		const resolved = resolveThinkingLevel(args.think);

		if (resolved.kind !== 'match') {
			return { ok: false, error: failure('thinking level', args.think, resolved) };
		}

		choice.thinkingLevel = resolved.value;

		if (resolved.corrected) correctedFrom.think = args.think;
	}

	if (Object.keys(correctedFrom).length > 0) choice.correctedFrom = correctedFrom;

	return { ok: true, choice: Object.keys(choice).length > 0 ? choice : undefined };
}

function failure(
	what: string,
	input: string,
	resolved: Exclude<Resolution<string>, { kind: 'match' }>,
): string {
	if (resolved.kind === 'unknown') return `Unknown ${what} \`${input}\`.`;

	return `\`${input}\` could be any of ${resolved.candidates.map((name) => `\`${name}\``).join(', ')}.`;
}

export type CoworkerModel = {
	specifier: string;
	thinkingLevel: ThinkingLevel;
	/** Run card text for the model, with any fallback or correction. */
	label: string;
	thinkingLabel: string;
	/** No model was picked; the deployment default route applies. */
	isDefault: boolean;
};

/**
 * The model a submission runs on. A ChatGPT choice needs ChatGPT usable for
 * this event (`route`); otherwise it falls back to the OpenCode Go default so
 * a thread already in progress keeps working.
 */
export function coworkerModel(
	choice: ModelChoice | undefined,
	route: ModelRoute | undefined,
): CoworkerModel {
	const thinkingLevel = choice?.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	const thinkingLabel = withCorrection(thinkingLevel, choice?.correctedFrom?.think);
	const picked = choice?.model;

	if (picked === undefined) {
		const specifier = route === 'chatgpt' ? openAICodexModelSpecifier : openCodeGoModelSpecifier;

		return { specifier, thinkingLevel, label: specifier, thinkingLabel, isDefault: true };
	}

	if (picked.provider === 'chatgpt' && route !== 'chatgpt') {
		return {
			specifier: openCodeGoModelSpecifier,
			thinkingLevel,
			label: `${picked.modelId} unavailable → ${openCodeGoModelSpecifier}`,
			thinkingLabel,
			isDefault: false,
		};
	}

	const specifier = modelSpecifier(picked);

	return {
		specifier,
		thinkingLevel,
		label: withCorrection(specifier, choice?.correctedFrom?.model),
		thinkingLabel,
		isDefault: false,
	};
}

export function modelSpecifier(model: NonNullable<ModelChoice['model']>): string {
	if (model.provider === 'chatgpt') return `openai-codex/${model.modelId}`;

	// The preferred DeepSeek id may have resolved to the bundled fallback.
	if (model.modelId === OPENCODE_GO_PREFERRED_ID) return openCodeGoModelSpecifier;

	return `opencode-go/${model.modelId}`;
}

function withCorrection(value: string, from: string | undefined): string {
	return from === undefined ? value : `${value} (from "${from}")`;
}

/** Slack mrkdwn shared by argument errors and the ChatGPT refusal. */
export function modelHelpText(): string {
	const byProvider = (provider: 'chatgpt' | 'opencode-go') =>
		Object.entries(modelAliases)
			.filter(([, model]) => model.provider === provider)
			.map(([alias]) => `\`${alias}\``)
			.join(' · ');

	return [
		`Pick a model with \`model:&lt;name&gt;\` and effort with \`think:${thinkingLevels.join('|')}\`.`,
		`ChatGPT: ${byProvider('chatgpt')} — OpenCode Go: ${byProvider('opencode-go')}`,
	].join('\n');
}
