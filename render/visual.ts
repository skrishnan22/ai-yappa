// Shared contract between owner code (src/visuals/render.ts) and every
// template: owner code calls `window.renderVisual(source)` after the page
// loads. It resolves once `#visual` holds the finished drawing and rejects
// with a message the model can act on (a parse error, say).
import * as v from 'valibot';
import { type JsonObject, type JsonValue, jsonObjectSchema, jsonValueSchema } from '../src/json.ts';

declare global {
	interface Window {
		renderVisual(source: string): Promise<void>;
	}
}

export function visualRoot(): HTMLElement {
	const root = document.getElementById('visual');

	if (!root) throw new Error('template is missing #visual');

	return root;
}

/** Parses model-written JSON: specs and options cannot carry functions. */
export function parseJsonObject(source: string, what: string): JsonObject {
	let parsed: JsonValue;

	try {
		parsed = v.parse(jsonValueSchema, JSON.parse(source));
	} catch (error) {
		throw new Error(
			`${what} must be JSON: ${error instanceof Error ? error.message : String(error)}`,
			{
				cause: error,
			},
		);
	}

	if (Array.isArray(parsed) || !v.is(jsonObjectSchema, parsed)) {
		throw new Error(`${what} must be a JSON object.`);
	}

	return parsed;
}
