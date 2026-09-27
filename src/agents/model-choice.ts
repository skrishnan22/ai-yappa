import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import levenshtein from 'damerau-levenshtein';
import * as v from 'valibot';
import { modelAliases } from '../config.ts';
import { openAICodexModelSpecifier } from './openai-codex-route.ts';
import {
	OPENCODE_GO_PREFERRED_ID,
	openCodeGoModelSpecifier,
	openCodeGoModels,
} from './opencode-go-catalog.ts';

const THINKING_LEVELS = ['low', 'medium', 'high'] as const;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * What `initialData` records at thread start: only what the user gave, plus
 * the words they typed when a typo was corrected (shown on the run card).
 */
export const modelChoiceSchema = v.object({
	model: v.optional(
		v.object({ provider: v.picklist(['chatgpt', 'opencode-go']), modelId: v.string() }),
	),
	thinkingLevel: v.optional(v.picklist(THINKING_LEVELS)),
	correctedFrom: v.optional(
		v.object({ model: v.optional(v.string()), effort: v.optional(v.string()) }),
	),
});

export type ModelChoice = v.InferOutput<typeof modelChoiceSchema>;

type Model = NonNullable<ModelChoice['model']>;

/**
 * The words one setting accepts. `names` match loosely (prefix, typo);
 * `exact` spellings, such as full model ids, match only as written.
 */
type Vocabulary<T> = {
	what: string;
	names: ReadonlyMap<string, T>;
	exact: ReadonlyMap<string, T>;
};

const MODELS: Vocabulary<Model> = {
	what: 'model',
	names: new Map(Object.entries(modelAliases)),
	exact: new Map(Object.values(modelAliases).map((model) => [model.modelId, model])),
};

const EFFORT: Vocabulary<ThinkingLevel> = {
	what: 'effort',
	names: new Map(THINKING_LEVELS.map((level) => [level, level])),
	exact: new Map([['mid', 'medium']]),
};

/** Typos allowed for a name: one edit up to four letters, two beyond. */
export function typoLimit(name: string): number {
	return name.length <= 4 ? 1 : 2;
}

type LookUp<T> = { value: T; corrected: boolean } | { error: string };

/**
 * Case-insensitive, in order: an exact name or spelling, then the names the
 * input starts, then names within `typoLimit` edits. Only a typo match counts
 * as a correction. More than one candidate is an error, never a guess.
 */
function lookUp<T>(input: string, vocabulary: Vocabulary<T>): LookUp<T> {
	const typed = input.toLowerCase();
	const exact = vocabulary.names.get(typed) ?? vocabulary.exact.get(typed);

	if (exact !== undefined) return { value: exact, corrected: false };

	const entries = [...vocabulary.names];
	const byPrefix = entries.filter(([name]) => name.startsWith(typed));
	const corrected = byPrefix.length === 0;

	const candidates = corrected
		? entries.filter(([name]) => levenshtein(typed, name).steps <= typoLimit(name))
		: byPrefix;

	const [only, ...others] = candidates;

	if (only === undefined) return { error: `Unknown ${vocabulary.what} \`${input}\`.` };

	if (others.length > 0) {
		const names = candidates.map(([name]) => code(name)).join(', ');

		return { error: `\`${input}\` could be any of ${names}.` };
	}

	return { value: only[1], corrected };
}

export type ModelChoiceResult = { ok: true; choice?: ModelChoice } | { ok: false; error: string };

/** Turns raw `$model:` / `$effort:` values into the choice `initialData` records. */
export function resolveModelChoice(args: { model?: string; effort?: string }): ModelChoiceResult {
	const choice: ModelChoice = {};

	if (args.model !== undefined) {
		const found = lookUp(args.model, MODELS);

		if ('error' in found) return { ok: false, error: found.error };
		choice.model = { provider: found.value.provider, modelId: found.value.modelId };

		if (found.corrected) choice.correctedFrom = { model: args.model };
	}

	if (args.effort !== undefined) {
		const found = lookUp(args.effort, EFFORT);

		if ('error' in found) return { ok: false, error: found.error };
		choice.thinkingLevel = found.value;

		if (found.corrected) choice.correctedFrom = { ...choice.correctedFrom, effort: args.effort };
	}

	return { ok: true, choice: Object.keys(choice).length > 0 ? choice : undefined };
}

// Specifiers the registered providers can serve. A thread's recorded choice
// outlives the deploy that recorded it, and pi upgrades can drop models.
const SERVABLE = new Set([
	...openaiCodexProvider()
		.getModels()
		.map((model) => `openai-codex/${model.id}`),
	...openCodeGoModels.map((model) => `opencode-go/${model.id}`),
]);

export type CoworkerModel = {
	/** For `useModel`. */
	specifier: string;
	thinkingLevel: ThinkingLevel;
	/** For the run card: the model, plus any fallback or typo correction. */
	label: string;
	thinkingLabel: string;
	/** No model was picked, so the card hints at `$model:`. */
	isDefault: boolean;
};

/**
 * No choice: the deployment default, ChatGPT while it is usable, else
 * OpenCode Go. A choice runs as picked, unless it is a ChatGPT model and
 * ChatGPT is not usable now, or the catalog no longer has it; then the
 * default runs and the card says why, so a thread in progress keeps working.
 */
export function coworkerModel(
	choice: ModelChoice | undefined,
	chatgptUsable: boolean,
): CoworkerModel {
	const thinkingLevel = choice?.thinkingLevel ?? 'medium';
	const thinkingLabel = withTypo(thinkingLevel, choice?.correctedFrom?.effort);
	const fallback = chatgptUsable ? openAICodexModelSpecifier : openCodeGoModelSpecifier;
	const picked = choice?.model;

	if (picked === undefined) {
		return { specifier: fallback, label: fallback, thinkingLevel, thinkingLabel, isDefault: true };
	}

	const specifier = modelSpecifier(picked);
	const runnable = SERVABLE.has(specifier) && (picked.provider !== 'chatgpt' || chatgptUsable);

	return {
		specifier: runnable ? specifier : fallback,
		label: runnable
			? withTypo(specifier, choice?.correctedFrom?.model)
			: `${picked.modelId} unavailable → ${fallback}`,
		thinkingLevel,
		thinkingLabel,
		isDefault: false,
	};
}

export function modelSpecifier(model: Model): string {
	if (model.provider === 'chatgpt') return `openai-codex/${model.modelId}`;

	// The preferred DeepSeek id may have resolved to the bundled fallback.
	if (model.modelId === OPENCODE_GO_PREFERRED_ID) return openCodeGoModelSpecifier;

	return `opencode-go/${model.modelId}`;
}

function withTypo(value: string, typed: string | undefined): string {
	return typed === undefined ? value : `${value} (from "${typed}")`;
}

/** Slack mrkdwn shared by argument errors and the ChatGPT refusal. */
export function modelHelpText(): string {
	const aliases = (provider: Model['provider']) =>
		Object.entries(modelAliases)
			.filter(([, model]) => model.provider === provider)
			.map(([alias]) => code(alias))
			.join(' · ');

	return [
		`Pick a model with \`$model:&lt;name&gt;\` and effort with \`$effort:${THINKING_LEVELS.join('|')}\`.`,
		`ChatGPT: ${aliases('chatgpt')} — OpenCode Go: ${aliases('opencode-go')}`,
	].join('\n');
}

function code(text: string): string {
	return `\`${text}\``;
}
