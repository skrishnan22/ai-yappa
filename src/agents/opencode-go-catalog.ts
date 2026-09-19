import type { Api, Model } from '@earendil-works/pi-ai';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';

export const MODELS_DEV_CATALOG_URL = 'https://models.dev/api.json';
export const OPENCODE_GO_PREFERRED_ID = 'deepseek-v4.1-flash';
export const OPENCODE_GO_BUNDLED_ID = 'deepseek-v4-flash';

const bundled = opencodeGoProvider().getModels();

export async function resolveOpenCodeGoModel(args?: {
	bundled?: readonly Model<Api>[];
	fetch?: typeof fetch;
}): Promise<{ models: readonly Model<Api>[]; modelId: string }> {
	const models = args?.bundled ?? bundled;
	const fetchImpl = args?.fetch ?? globalThis.fetch;

	try {
		const response = await fetchImpl(MODELS_DEV_CATALOG_URL, {
			method: 'GET',
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(8_000),
		});
		if (!response.ok) throw new Error(`http ${response.status}`);
		const catalog = (await response.json()) as {
			'opencode-go'?: { models?: Record<string, unknown> };
		};
		if (catalog['opencode-go']?.models?.[OPENCODE_GO_PREFERRED_ID]) {
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

// useModel() looks up this id in getModels(). Clone the bundled fallback's
// wire settings when pi-ai does not yet ship the preferred id.
function withPreferredId(models: readonly Model<Api>[]): readonly Model<Api>[] {
	if (models.some((model) => model.id === OPENCODE_GO_PREFERRED_ID)) return models;
	const template = models.find((model) => model.id === OPENCODE_GO_BUNDLED_ID);
	if (template === undefined) return models;
	return [{ ...template, id: OPENCODE_GO_PREFERRED_ID, name: OPENCODE_GO_PREFERRED_ID }, ...models];
}

let resolved: { models: readonly Model<Api>[]; modelId: string };
if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
	resolved = { models: bundled, modelId: OPENCODE_GO_BUNDLED_ID };
} else {
	resolved = await resolveOpenCodeGoModel();
}
export const openCodeGoModels = resolved.models;
export const openCodeGoModelSpecifier = `opencode-go/${resolved.modelId}`;
