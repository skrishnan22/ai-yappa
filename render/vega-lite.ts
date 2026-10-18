import { parse, View } from 'vega';
import { expressionInterpreter } from 'vega-interpreter';
import { compile, type TopLevelSpec } from 'vega-lite';
import * as v from 'valibot';
import { type JsonValue, jsonObjectSchema } from '../src/json.ts';
import { parseJsonObject, visualRoot } from './visual.ts';

window.renderVisual = async (source) => {
	const checked = parseJsonObject(source, 'A Vega-Lite spec');

	if (hasRemoteData(checked)) {
		throw new Error('Data must be inline (`values`); the renderer cannot fetch URLs.');
	}

	// vega-lite's compile validates the spec itself and throws on a bad one.
	const spec: TopLevelSpec = JSON.parse(source);
	const compiled = compile(spec).spec;

	// The interpreter evaluates expressions without `eval`, so the page CSP
	// can forbid it. Data must be inline: the CSP blocks every fetch.
	const view = new View(parse(compiled, undefined, { ast: true }), {
		expr: expressionInterpreter,
		renderer: 'svg',
		container: visualRoot(),
		hover: false,
	});

	await view.runAsync();
};

// A `url` anywhere in a spec is a data source the CSP would silently block,
// leaving an empty chart. Say so instead.
function hasRemoteData(value: JsonValue): boolean {
	if (Array.isArray(value)) return value.some(hasRemoteData);

	if (!v.is(jsonObjectSchema, value)) return false;

	return Object.entries(value).some(([key, child]) => key === 'url' || hasRemoteData(child));
}
