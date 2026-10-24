// Bundles each render template's script (render/<kind>.ts) with its pinned
// library into public/render/build/<kind>.js, served as a Worker static asset
// (ADR 0025, decision 3). Library versions come from the lockfile, so an
// upgrade is a reviewed change. Run before `vite dev` and `vite build`.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const KINDS = ['mermaid', 'vega-lite', 'echarts', 'walkthrough', 'walkthrough-player'];

for (const kind of KINDS) {
	await build({
		configFile: false,
		root,
		logLevel: 'warn',
		publicDir: false,
		// Library-mode builds leave `process.env.NODE_ENV` in place; ECharts reads it.
		define: { 'process.env.NODE_ENV': JSON.stringify('production') },
		build: {
			outDir: join(root, 'public/render/build'),
			emptyOutDir: false,
			minify: true,
			sourcemap: false,
			lib: {
				entry: join(root, 'render', `${kind}.ts`),
				formats: ['iife'],
				name: `render_${kind.replace('-', '_')}`,
				fileName: () => `${kind}.js`,
			},
		},
	});
}
