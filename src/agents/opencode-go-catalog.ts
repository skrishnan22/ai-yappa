import type { Api, Model } from '@earendil-works/pi-ai';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';
import { setProvider } from '@flue/runtime';
import * as v from 'valibot';
import { jsonObjectSchema, jsonValueSchema, type JsonValue } from '../json.ts';

export const MODELS_DEV_CATALOG_URL = 'https://models.dev/api.json';

export const OPENCODE_GO_PREFERRED_ID = 'deepseek-v4.1-flash';

export const OPENCODE_GO_BUNDLED_ID = 'deepseek-v4-flash';

const bundled = opencodeGoProvider().getModels();

export type OpenCodeGoResolution = {
	models: readonly Model<Api>[];
	modelId: string;
};

export async function resolveOpenCodeGoModel(args?: {
	bundled?: readonly Model<Api>[];
	fetch?: typeof fetch;
}): Promise<OpenCodeGoResolution> {
	const models = args?.bundled ?? bundled;
	const fetchImpl = args?.fetch ?? globalThis.fetch;

	try {
		const response = await fetchImpl(MODELS_DEV_CATALOG_URL, {
			method: 'GET',
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(8_000),
		});

		if (!response.ok) throw new Error(`http ${response.status}`);

		const payload = await response.json();

		if (v.is(jsonValueSchema, payload) && catalogLists(payload, OPENCODE_GO_PREFERRED_ID)) {
			return {
				models: withPreferredId(models),
				modelId: OPENCODE_GO_PREFERRED_ID,
			};
		}
	} catch {
		// keep bundled fallback
	}

	console.warn(
		`[opencode-go] ${OPENCODE_GO_PREFERRED_ID} unavailable; using ${OPENCODE_GO_BUNDLED_ID}`,
	);

	return { models, modelId: OPENCODE_GO_BUNDLED_ID };
}

function catalogLists(payload: JsonValue, modelId: string): boolean {
	if (!v.is(jsonObjectSchema, payload)) return false;
	const provider = payload['opencode-go'];

	if (!v.is(jsonObjectSchema, provider)) return false;
	const models = provider.models;

	if (!v.is(jsonObjectSchema, models)) return false;

	return Object.hasOwn(models, modelId);
}

// useModel() looks up this id in getModels(). Clone the bundled fallback's
// wire settings when pi-ai does not yet ship the preferred id.
function withPreferredId(models: readonly Model<Api>[]): readonly Model<Api>[] {
	if (models.some((model) => model.id === OPENCODE_GO_PREFERRED_ID)) return models;
	const template = models.find((model) => model.id === OPENCODE_GO_BUNDLED_ID);

	if (template === undefined) return models;

	return [{ ...template, id: OPENCODE_GO_PREFERRED_ID, name: OPENCODE_GO_PREFERRED_ID }, ...models];
}

// ponytail: OpenCode Go often closes SSE without finish_reason. pi-ai ≥0.86
// honors compat.supportsFinishReason=false (earendil-works/pi#7062); drop when
// upstream sets this on opencode-go models.
export function withMissingFinishReasonCompat(
	models: readonly Model<Api>[],
): readonly Model<Api>[] {
	return models.map((model) => {
		if (model.api !== 'openai-completions') return model;

		return {
			...model,
			compat: { ...model.compat, supportsFinishReason: false },
		};
	});
}

let resolved: OpenCodeGoResolution;

if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
	resolved = { models: bundled, modelId: OPENCODE_GO_BUNDLED_ID };
} else {
	resolved = await resolveOpenCodeGoModel();
}

export const openCodeGoModels = withMissingFinishReasonCompat(resolved.models);

export const openCodeGoModelSpecifier = `opencode-go/${resolved.modelId}`;

const inner = opencodeGoProvider();

// Flue resolves useModel() after the first render, but docs require setProvider
// at module load so flue run / harness init never see the bundled snapshot.
setProvider({
	...inner,
	getModels: () => openCodeGoModels,
});
