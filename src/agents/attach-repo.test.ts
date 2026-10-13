import type { ToolDefinition } from '@flue/runtime';
import { describe, expect, test, vi } from 'vitest';
import { attachRepoTool } from './attach-repo.ts';

const INSTALLED = ['acme/api', 'acme/web', 'acme/infra'];

function run(tool: ToolDefinition, repo: string) {
	return tool.run({
		data: { repo },
		toolCallId: 'attach',
		log: { info() {}, warn() {}, error() {} },
	});
}

function setup(installed: string[] = INSTALLED) {
	const attached: string[] = [];

	// Like the GitHub mint: an exact, case-insensitive check returning the installation's spelling.
	const find = vi.fn<(repo: string) => Promise<string | undefined>>(async (repo) =>
		installed.find((name) => name.toLowerCase() === repo),
	);

	const list = vi.fn<() => Promise<string[]>>(async () => installed);

	const tool = attachRepoTool({
		directory: { find, list },
		attach: (repo) => {
			attached.push(repo);
		},
	});

	return { tool, attached, find, list };
}

describe('attach_repo', () => {
	test('attaches an installed repo given as owner/name or URL, as a clone URL', async () => {
		for (const input of [
			'acme/api',
			'https://github.com/acme/api',
			'https://github.com/acme/api.git',
		]) {
			const { tool, attached } = setup();
			await run(tool, input);
			expect(attached).toEqual(['https://github.com/acme/api.git']);
		}
	});

	test('uses the installation spelling when case differs', async () => {
		const { tool, attached } = setup(['Acme/API']);
		await run(tool, 'acme/api');
		expect(attached).toEqual(['https://github.com/Acme/API.git']);
	});

	test('refuses a repo the App cannot access and suggests the closest', async () => {
		const { tool, attached } = setup();
		await expect(run(tool, 'acme/apii')).rejects.toThrow(/cannot access acme\/apii.*acme\/api/);
		expect(attached).toEqual([]);
	});

	test('suggests nothing when no accessible repo is close', async () => {
		const { tool } = setup();

		await expect(run(tool, 'someone/billing-service')).rejects.toThrow(
			'The GitHub App cannot access someone/billing-service, and no repository it can access has a similar name.',
		);
	});

	test('suggests a repo with the same name under another owner', async () => {
		const { tool } = setup(['acme-inc/api', 'acme/web']);

		await expect(run(tool, 'acme/api')).rejects.toThrow(/Closest it can access: acme-inc\/api\.$/);
	});

	test('checks a hit without listing the installation', async () => {
		const { tool, attached, list } = setup();

		await run(tool, 'acme/web');
		expect(attached).toEqual(['https://github.com/acme/web.git']);
		expect(list).not.toHaveBeenCalled();
	});

	test('refuses a non-GitHub value without a lookup', async () => {
		const { tool, find } = setup();
		await expect(run(tool, 'https://gitlab.com/acme/api')).rejects.toThrow(/github.com/);
		expect(find).not.toHaveBeenCalled();
	});

	test('surfaces a failed installation lookup as a tool error', async () => {
		const { tool, find } = setup();
		find.mockRejectedValue(new Error('GitHub 503'));

		await expect(run(tool, 'acme/api')).rejects.toThrow(/GitHub 503/);
	});
});
