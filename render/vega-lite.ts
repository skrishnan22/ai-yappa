import { parse, View } from 'vega';
import { expressionInterpreter } from 'vega-interpreter';
import { compile, type TopLevelSpec } from 'vega-lite';
import { parseJsonObject, visualRoot } from './visual.ts';

window.renderVisual = async (source) => {
	parseJsonObject(source, 'A Vega-Lite spec');

	// vega-lite's compile validates the spec and lifts nested data sources.
	const spec: TopLevelSpec = JSON.parse(source);
	const compiled = compile(spec).spec;

	if (compiled.data?.some((data) => 'url' in data)) {
		throw new Error('Data must be inline (`values`); the renderer cannot fetch URLs.');
	}

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
