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

/** What `initialData` records at thread start: only what the user gave. */
export const modelChoiceSchema = v.object({
	model: v.optional(
		v.object({ provider: v.picklist(['chatgpt', 'opencode-go']), modelId: v.string() }),
	),
	thinkingLevel: v.optional(v.picklist(THINKING_LEVELS)),
});

export type ModelChoice = v.InferOutput<typeof modelChoiceSchema>;

type Model = NonNullable<ModelChoice['model']>;

const MODELS = new Map<string, Model>(Object.entries(modelAliases));

const EFFORTS = new Map<string, ThinkingLevel>(THINKING_LEVELS.map((level) => [level, level]));

/** Typos allowed for a name: one edit up to four letters, two beyond. */
export function typoLimit(name: string): number {
	return name.length <= 4 ? 1 : 2;
}

type Found<T> = { value: T } | { error: string };

/**
 * The one name `input` means, case-insensitively: the exact name, else the
 * names it starts (`ki` → `kimi`), else names within `typoLimit` edits
 * (`lnua` → `luna`). None or several is an error, never a guess.
 */
function lookUp<T>(input: string, names: ReadonlyMap<string, T>, what: string): Found<T> {
	const typed = input.toLowerCase();
	const exact = names.get(typed);

	if (exact !== undefined) return { value: exact };

	const entries = [...names];
	const byPrefix = entries.filter(([name]) => name.startsWith(typed));

	const candidates =
		byPrefix.length > 0
			? byPrefix
			: entries.filter(([name]) => levenshtein(typed, name).steps <= typoLimit(name));

	const [only, ...others] = candidates;

	if (!only) return { error: `Unknown ${what} \`${input}\`.` };

	if (others.length > 0) {
		const listed = candidates.map(([name]) => `\`${name}\``).join(', ');

		return { error: `\`${input}\` could be any of ${listed}.` };
	}

	return { value: only[1] };
}

export type ModelChoiceResult = { ok: true; choice?: ModelChoice } | { ok: false; error: string };

/** Turns raw `$model:` / `$effort:` values into the choice `initialData` records. */
export function resolveModelChoice(args: { model?: string; effort?: string }): ModelChoiceResult {
	const choice: ModelChoice = {};

	if (args.model) {
		const found = lookUp(args.model, MODELS, 'model');

		if ('error' in found) return { ok: false, error: found.error };
		choice.model = { provider: found.value.provider, modelId: found.value.modelId };
	}

	if (args.effort) {
		const found = lookUp(args.effort, EFFORTS, 'effort');

		if ('error' in found) return { ok: false, error: found.error };
		choice.thinkingLevel = found.value;
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
	/** For the run card: the model, or why the default runs instead. */
	label: string;
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
	const thinkingLevel = choice?.thinkingLevel ?? 'high';
	const fallback = chatgptUsable ? openAICodexModelSpecifier : openCodeGoModelSpecifier;
	const picked = choice?.model;

	if (!picked) {
		return { specifier: fallback, label: fallback, thinkingLevel, isDefault: true };
	}

	const specifier = modelSpecifier(picked);
	const runnable = SERVABLE.has(specifier) && (picked.provider !== 'chatgpt' || chatgptUsable);

	if (!runnable) {
		const label = `${picked.modelId} unavailable → ${fallback}`;

		return { specifier: fallback, label, thinkingLevel, isDefault: false };
	}

	return { specifier, label: specifier, thinkingLevel, isDefault: false };
}

export function modelSpecifier(model: Model): string {
	if (model.provider === 'chatgpt') return `openai-codex/${model.modelId}`;

	// The preferred DeepSeek id may have resolved to the bundled fallback.
	if (model.modelId === OPENCODE_GO_PREFERRED_ID) return openCodeGoModelSpecifier;

	return `opencode-go/${model.modelId}`;
}

/** Slack mrkdwn shared by argument errors and the ChatGPT refusal. */
export function modelHelpText(): string {
	const aliases = (provider: Model['provider']) =>
		Object.entries(modelAliases)
			.filter(([, model]) => model.provider === provider)
			.map(([alias]) => `\`${alias}\``)
			.join(' · ');

	return [
		`Pick a model with \`$model:&lt;name&gt;\` and effort with \`$effort:${THINKING_LEVELS.join('|')}\`.`,
		`ChatGPT: ${aliases('chatgpt')} — OpenCode Go: ${aliases('opencode-go')}`,
	].join('\n');
}
