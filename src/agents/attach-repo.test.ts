import type { ToolDefinition } from '@flue/runtime';
import { describe, expect, test, vi } from 'vitest';
import { attachRepoTool, cachedRepoDirectory } from './attach-repo.ts';

const INSTALLED = ['acme/api', 'acme/web', 'acme/infra'];

function run(tool: ToolDefinition, repo: string) {
	return tool.run({
		data: { repo },
		toolCallId: 'attach',
		log: { info() {}, warn() {}, error() {} },
	});
}

function setup(list: () => Promise<string[]> = async () => INSTALLED) {
	const attached: string[] = [];

	const tool = attachRepoTool({
		directory: cachedRepoDirectory(list),
		attach: (repo) => {
			attached.push(repo);
		},
	});

	return { tool, attached };
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
		const { tool, attached } = setup(async () => ['Acme/API']);
		await run(tool, 'acme/api');
		expect(attached).toEqual(['https://github.com/Acme/API.git']);
	});

	test('refuses a repo the App cannot access and suggests the closest', async () => {
		const { tool, attached } = setup();
		await expect(run(tool, 'acme/apii')).rejects.toThrow(/cannot access acme\/apii.*acme\/api/);
		expect(attached).toEqual([]);
	});

	test('refuses a non-GitHub value without a lookup', async () => {
		const list = vi.fn<() => Promise<string[]>>(async () => INSTALLED);
		const { tool } = setup(list);
		await expect(run(tool, 'https://gitlab.com/acme/api')).rejects.toThrow(/github.com/);
		expect(list).not.toHaveBeenCalled();
	});

	test('surfaces a failed installation lookup as a tool error', async () => {
		const { tool } = setup(async () => {
			throw new Error('GitHub 503');
		});

		await expect(run(tool, 'acme/api')).rejects.toThrow(/GitHub 503/);
	});
});

describe('cachedRepoDirectory', () => {
	test('reuses a lookup for five minutes and does not cache a failure', async () => {
		let now = 0;

		const list = vi
			.fn<() => Promise<string[]>>()
			.mockRejectedValueOnce(new Error('down'))
			.mockResolvedValue(INSTALLED);

		const directory = cachedRepoDirectory(list, () => now);

		await expect(directory.list()).rejects.toThrow('down');
		await directory.list();
		now = 4 * 60 * 1000;
		await directory.list();
		expect(list).toHaveBeenCalledTimes(2);
		now = 6 * 60 * 1000;
		await directory.list();
		expect(list).toHaveBeenCalledTimes(3);
	});
});
