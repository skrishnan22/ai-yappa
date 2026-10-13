import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { buildPackagedSkill, parseSkillMarkdown } from '@flue/runtime/internal';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		{
			// Package skills without the Cloudflare plugin so tests can render agents.
			name: 'package-test-skills',
			enforce: 'pre',
			load(id) {
				if (!id.endsWith('/SKILL.md')) return undefined;
				const content = readFileSync(id, 'utf8');

				const metadata = parseSkillMarkdown(content, {
					directoryName: basename(dirname(id)),
					path: id,
				});

				const packaged = buildPackagedSkill({
					name: metadata.name,
					description: metadata.description,
					files: [{ path: 'SKILL.md', content: new TextEncoder().encode(content) }],
				});

				return `import { createSkillReference } from '@flue/runtime/internal'; export default createSkillReference(${JSON.stringify(packaged)});`;
			},
		},
	],
	test: {
		include: ['src/**/*.test.ts'],
	},
});
