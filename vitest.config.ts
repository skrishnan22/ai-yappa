import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		{
			// Flue's Vite plugin packages `SKILL.md` imports, but it needs the
			// Cloudflare plugin and cannot run under Vitest. Tests never render an
			// agent, so a stand-in module is enough; `pnpm run build` checks the
			// real packaging.
			name: 'stub-markdown-imports',
			enforce: 'pre',
			load(id) {
				if (!id.endsWith('.md')) return undefined;

				return `export default ${JSON.stringify({ stubbedMarkdown: id })};`;
			},
		},
	],
	test: {
		include: ['src/**/*.test.ts'],
	},
});
