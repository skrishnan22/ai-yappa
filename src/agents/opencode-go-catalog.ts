/**
 * Live OpenCode Go model list from models.dev.
 *
 * Flue/pi-ai resolve `useModel('opencode-go/…')` against `provider.getModels()`,
 * which is a static snapshot. This module fetches the combined models.dev
 * catalog (the JSON behind https://models.dev/providers/opencode-go/) and
 * overlays it onto the bundled provider so new IDs such as
 * `deepseek-v4.1-flash` resolve without waiting for a pi-ai release.
 *
 * Wire protocol (`api` / `baseUrl` / `compat`) stays with a bundled sibling
 * when one exists; models.dev does not publish OpenCode's completions vs
 * messages vs responses split.
 */
import type { Api, Model } from '@earendil-works/pi-ai';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';

export const MODELS_DEV_CATALOG_URL = 'https://models.dev/api.json';
export const MODELS_DEV_PROVIDER_ID = 'opencode-go';

const OPENCODE_GO_COMPLETIONS_URL = 'https://opencode.ai/zen/go/v1';
const OPENCODE_GO_MESSAGES_URL = 'https://opencode.ai/zen/go';

const bundled = opencodeGoProvider().getModels();

export async function loadOpenCodeGoCatalog(args: {
	bundled?: readonly Model<Api>[];
	fetch?: typeof fetch;
	url?: string;
	timeoutMs?: number;
}): Promise<readonly Model<Api>[]> {
	const baseline = args.bundled ?? bundled;
	const fetchImpl = args.fetch ?? globalThis.fetch;
	const url = args.url ?? MODELS_DEV_CATALOG_URL;
	const timeoutMs = args.timeoutMs ?? 8_000;

	try {
		const response = await fetchImpl(url, modelsDevRequest(timeoutMs));
		if (!response.ok) {
			warnUnavailable(`http ${response.status}`);
			return baseline;
		}
		const payload: unknown = await response.json();
		const mapped = overlayModelsDevCatalog(baseline, payload);
		if (mapped.length === 0) {
			warnUnavailable('no models');
			return baseline;
		}
		console.info(`[opencode-go] loaded ${mapped.length} models from models.dev`);
		return mapped;
	} catch {
		warnUnavailable('fetch failed');
		return baseline;
	}
}

export function overlayModelsDevCatalog(
	baseline: readonly Model<Api>[],
	payload: unknown,
): Model<Api>[] {
	const provider = readProvider(payload);
	if (provider === undefined) return [];

	const byId = new Map(baseline.map((model) => [model.id, model]));
	const mapped: Model<Api>[] = [];

	for (const [key, row] of Object.entries(provider.models)) {
		const rowId = asString(row.id);
		const existing = byId.get(key) ?? (rowId === undefined ? undefined : byId.get(rowId));
		const model = toPiModel(key, row, provider.npm, existing);
		if (model !== undefined) mapped.push(model);
	}
	return mapped;
}

type ModelsDevProvider = {
	npm: string | undefined;
	models: Record<string, Record<string, unknown>>;
};

function readProvider(payload: unknown): ModelsDevProvider | undefined {
	if (!isRecord(payload)) return undefined;
	const provider = payload[MODELS_DEV_PROVIDER_ID];
	if (!isRecord(provider)) return undefined;
	const modelsRaw = provider.models;
	if (!isRecord(modelsRaw)) return undefined;
	const models: Record<string, Record<string, unknown>> = {};
	for (const [key, row] of Object.entries(modelsRaw)) {
		if (isRecord(row)) models[key] = row;
	}
	if (Object.keys(models).length === 0) return undefined;
	return {
		npm: typeof provider.npm === 'string' ? provider.npm : undefined,
		models,
	};
}

function toPiModel(
	recordId: string,
	row: Record<string, unknown>,
	providerNpm: string | undefined,
	existing: Model<Api> | undefined,
): Model<Api> | undefined {
	const id = asNonEmpty(row.id) ?? asNonEmpty(recordId);
	if (id === undefined) return undefined;

	const name = asNonEmpty(row.name) ?? existing?.name ?? id;
	const reasoning = asBoolean(row.reasoning) ?? existing?.reasoning ?? false;
	const input = modalitiesToInput(row) ?? existing?.input ?? ['text'];
	const cost = costFromRow(row) ?? existing?.cost ?? zeroCost();
	const contextWindow = limitNumber(row, 'context') ?? existing?.contextWindow ?? 128_000;
	const maxTokens = limitNumber(row, 'output') ?? existing?.maxTokens ?? 8_192;
	const thinkingLevelMap = thinkingLevelMapFromRow(row) ?? existing?.thinkingLevelMap;

	const modelNpm = nestedNpm(row) ?? providerNpm;
	const api = existing?.api ?? inferApi(id, modelNpm);
	const baseUrl = existing?.baseUrl ?? baseUrlForApi(api);
	const compat = existing?.compat ?? inferCompat(id, row, api);

	return {
		...existing,
		id,
		name,
		api,
		provider: 'opencode-go',
		baseUrl,
		reasoning,
		input,
		cost,
		contextWindow,
		maxTokens,
		...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
		...(compat !== undefined ? { compat } : {}),
	};
}

function inferApi(id: string, npm: string | undefined): Api {
	if (npm === '@ai-sdk/anthropic') return 'anthropic-messages';
	if (npm === '@ai-sdk/openai') return 'openai-responses';
	if (id.startsWith('minimax-') || id.startsWith('qwen')) return 'anthropic-messages';
	if (id.startsWith('gpt-') || id.startsWith('grok-') || id.startsWith('muse-spark-')) {
		return 'openai-responses';
	}
	return 'openai-completions';
}

function baseUrlForApi(api: Api): string {
	return api === 'anthropic-messages' ? OPENCODE_GO_MESSAGES_URL : OPENCODE_GO_COMPLETIONS_URL;
}

function inferCompat(id: string, row: Record<string, unknown>, api: Api): Model<Api>['compat'] {
	if (api === 'openai-responses') {
		return { sessionAffinityFormat: 'openai-nosession' };
	}
	if (api !== 'openai-completions') return undefined;
	if (!id.includes('deepseek') && !hasReasoningContent(row)) return undefined;
	return {
		supportsStore: false,
		supportsDeveloperRole: false,
		maxTokensField: 'max_tokens',
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: 'deepseek',
	};
}

function thinkingLevelMapFromRow(
	row: Record<string, unknown>,
): Model<Api>['thinkingLevelMap'] | undefined {
	const options = row.reasoning_options;
	if (!Array.isArray(options)) return undefined;
	const effort = options.find((entry) => isRecord(entry) && entry.type === 'effort');
	if (!isRecord(effort) || !Array.isArray(effort.values)) return undefined;
	const allowed = new Set(
		effort.values.filter((value): value is string => typeof value === 'string'),
	);
	if (allowed.size === 0) return undefined;
	return {
		off: allowed.has('none') ? 'none' : allowed.has('off') ? 'off' : null,
		minimal: allowed.has('minimal') ? 'minimal' : null,
		low: allowed.has('low') ? 'low' : null,
		medium: allowed.has('medium') ? 'medium' : null,
		high: allowed.has('high') ? 'high' : null,
		xhigh: allowed.has('xhigh') ? 'xhigh' : null,
		max: allowed.has('max') ? 'max' : null,
	};
}

function modalitiesToInput(row: Record<string, unknown>): Model<Api>['input'] | undefined {
	if (!isRecord(row.modalities) || !Array.isArray(row.modalities.input)) return undefined;
	const input = row.modalities.input.filter(
		(value): value is 'text' | 'image' => value === 'text' || value === 'image',
	);
	return input.length > 0 ? input : undefined;
}

function costFromRow(row: Record<string, unknown>): Model<Api>['cost'] | undefined {
	if (!isRecord(row.cost)) return undefined;
	return {
		input: asFiniteNumber(row.cost.input) ?? 0,
		output: asFiniteNumber(row.cost.output) ?? 0,
		cacheRead: asFiniteNumber(row.cost.cache_read) ?? 0,
		cacheWrite: asFiniteNumber(row.cost.cache_write) ?? 0,
	};
}

function limitNumber(row: Record<string, unknown>, key: 'context' | 'output'): number | undefined {
	if (!isRecord(row.limit)) return undefined;
	return asPositiveInt(row.limit[key]);
}

function nestedNpm(row: Record<string, unknown>): string | undefined {
	if (!isRecord(row.provider)) return undefined;
	return asNonEmpty(row.provider.npm);
}

function hasReasoningContent(row: Record<string, unknown>): boolean {
	return isRecord(row.interleaved) && row.interleaved.field === 'reasoning_content';
}

function zeroCost(): Model<Api>['cost'] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function modelsDevRequest(timeoutMs: number): RequestInit {
	return {
		method: 'GET',
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(timeoutMs),
	};
}

function warnUnavailable(reason: string): void {
	console.warn(
		`[opencode-go] models.dev catalog unavailable (${reason}); using bundled pi-ai models`,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function asNonEmpty(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
	const n = asFiniteNumber(value);
	if (n === undefined || n <= 0 || !Number.isInteger(n)) return undefined;
	return n;
}

function skipNetworkCatalog(): boolean {
	return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
}

let openCodeGoModels: readonly Model<Api>[];
if (skipNetworkCatalog()) {
	openCodeGoModels = bundled;
} else {
	openCodeGoModels = await loadOpenCodeGoCatalog({ bundled });
}
export { openCodeGoModels };
