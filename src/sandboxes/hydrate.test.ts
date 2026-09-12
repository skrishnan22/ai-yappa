import { describe, expect, test } from 'vitest';
import {
	coworkerInstructions,
	hydrateWorkspace,
	installCommandForLockfile,
	markerMatchesRepo,
	WORKSPACE_READY_PATH,
	WORKSPACE_REPO_DIR,
	workingBranchName,
	type HydrateIo,
} from './hydrate.ts';

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function memoryIo(seed?: {
	files?: Map<string, string>;
	head?: string;
}): HydrateIo & { commands: string[] } {
	const files = seed?.files ?? new Map<string, string>();
	const commands: string[] = [];
	const io: HydrateIo & { commands: string[] } = {
		commands,
		async exec(command, options) {
			commands.push([options?.cwd, command].filter(Boolean).join(' '));
			if (command === 'git rev-parse --abbrev-ref HEAD') {
				return { exitCode: 0, stdout: seed?.head ?? '', stderr: '' };
			}
			return { exitCode: 0, stdout: '', stderr: '' };
		},
		async readFile(path) {
			const content = files.get(path);
			if (content === undefined) throw new Error(`missing ${path}`);
			return content;
		},
		async writeFile(path, content) {
			files.set(path, content);
		},
		async exists(path) {
			return files.has(path);
		},
	};
	return io;
}

describe('installCommandForLockfile', () => {
	test('maps pnpm and npm lockfiles', () => {
		expect(installCommandForLockfile('pnpm-lock.yaml')).toBe(
			'corepack pnpm install --frozen-lockfile',
		);
		expect(installCommandForLockfile('package-lock.json')).toBe('npm ci');
		expect(installCommandForLockfile('yarn.lock')).toBe('corepack yarn install --immutable');
		expect(installCommandForLockfile('missing')).toBeUndefined();
	});

	test('fails closed on bun.lock because the toolchain image has no bun', () => {
		expect(() => installCommandForLockfile('bun.lock')).toThrow(/bun is not on the image/);
	});
});

describe('hydrateWorkspace', () => {
	test('clones, frozen-installs pnpm, writes a marker, and uses the repo root as cwd', async () => {
		const files = new Map<string, string>([[`${WORKSPACE_REPO_DIR}/pnpm-lock.yaml`, 'lock: 1\n']]);
		const io = memoryIo({ files });

		const result = await hydrateWorkspace(io, {
			repo: 'https://github.com/skrishnan22/codevil.git',
			conversationId: 'T1/C1/123.456',
			git: { name: 'ai-yappa[bot]', email: '1+ai-yappa[bot]@users.noreply.github.com' },
		});

		expect(result.skipped).toBe(false);
		expect(result.cwd).toBe(WORKSPACE_REPO_DIR);
		expect(result.lockfile).toBe('pnpm-lock.yaml');
		expect(io.commands[0]).toMatch(/^rm -rf '\/workspace\/repo'$/);
		expect(io.commands[1]).toContain(
			"git clone --depth 1 'https://github.com/skrishnan22/codevil.git'",
		);
		expect(io.commands).toContain(`${WORKSPACE_REPO_DIR} corepack pnpm install --frozen-lockfile`);
		expect(io.commands).toContain(
			`${WORKSPACE_REPO_DIR} git checkout -B '${workingBranchName('T1/C1/123.456')}'`,
		);
		expect(io.commands).toContain(`${WORKSPACE_REPO_DIR} git config user.name 'ai-yappa[bot]'`);

		const marker = JSON.parse(await io.readFile(WORKSPACE_READY_PATH)) as {
			version: number;
			repo: string;
			lockfile: string;
		};
		expect(marker.version).toBe(1);
		expect(marker.repo).toBe('https://github.com/skrishnan22/codevil.git');
		expect(marker.lockfile).toBe('pnpm-lock.yaml');
	});

	test('uses npm ci when package-lock.json is the root lockfile', async () => {
		const files = new Map<string, string>([[`${WORKSPACE_REPO_DIR}/package-lock.json`, '{}']]);
		const io = memoryIo({ files });

		const result = await hydrateWorkspace(io, {
			repo: 'https://github.com/org/npm-app.git',
			conversationId: 'c1',
		});

		expect(result.lockfile).toBe('package-lock.json');
		expect(io.commands).toContain(`${WORKSPACE_REPO_DIR} npm ci`);
		expect(io.commands.some((command) => command.includes('pnpm'))).toBe(false);
	});

	test('skips clone and install when the marker and workspace fingerprint still match', async () => {
		const lock = 'lock: 1\n';
		const repo = 'https://github.com/skrishnan22/codevil.git';
		const conversationId = 'c1';
		const files = new Map<string, string>([
			[
				WORKSPACE_READY_PATH,
				JSON.stringify({
					version: 1,
					repo,
					lockfile: 'pnpm-lock.yaml',
					lockfileSha256: await sha256Hex(lock),
				}),
			],
			[`${WORKSPACE_REPO_DIR}/pnpm-lock.yaml`, lock],
			[`${WORKSPACE_REPO_DIR}/.git`, ''],
		]);
		const io = memoryIo({ files, head: workingBranchName(conversationId) });

		const result = await hydrateWorkspace(io, { repo, conversationId });

		expect(result.skipped).toBe(true);
		expect(result.cwd).toBe(WORKSPACE_REPO_DIR);
		expect(io.commands.some((command) => command.includes('git clone'))).toBe(false);
		expect(io.commands.some((command) => command.includes('pnpm install'))).toBe(false);
	});

	test('rehydrates when the lockfile hash no longer matches the marker', async () => {
		const repo = 'https://github.com/skrishnan22/codevil.git';
		const files = new Map<string, string>([
			[
				WORKSPACE_READY_PATH,
				JSON.stringify({
					version: 1,
					repo,
					lockfile: 'pnpm-lock.yaml',
					lockfileSha256: await sha256Hex('old\n'),
				}),
			],
			[`${WORKSPACE_REPO_DIR}/pnpm-lock.yaml`, 'new\n'],
			[`${WORKSPACE_REPO_DIR}/.git`, ''],
		]);
		const io = memoryIo({ files, head: workingBranchName('c1') });

		const result = await hydrateWorkspace(io, { repo, conversationId: 'c1' });

		expect(result.skipped).toBe(false);
		expect(io.commands.some((command) => command.includes('git clone'))).toBe(true);
	});

	test('rehydrates when the marker is for a different repo', async () => {
		const files = new Map<string, string>([
			[
				WORKSPACE_READY_PATH,
				JSON.stringify({ version: 1, repo: 'https://github.com/other/repo.git' }),
			],
			[`${WORKSPACE_REPO_DIR}/pnpm-lock.yaml`, 'lock: 1\n'],
		]);
		const io = memoryIo({ files });

		const result = await hydrateWorkspace(io, {
			repo: 'https://github.com/skrishnan22/codevil.git',
			conversationId: 'c1',
		});

		expect(result.skipped).toBe(false);
		expect(io.commands.some((command) => command.includes('git clone'))).toBe(true);
	});
});

describe('markerMatchesRepo', () => {
	test('rejects invalid JSON and other repos', () => {
		expect(markerMatchesRepo('nope', 'https://github.com/a/b.git')).toBe(false);
		expect(
			markerMatchesRepo(
				JSON.stringify({ version: 1, repo: 'https://github.com/a/b.git' }),
				'https://github.com/a/c.git',
			),
		).toBe(false);
	});
});

describe('coworkerInstructions', () => {
	test('names the workspace path and treats Slack text as the task', () => {
		const prompt = coworkerInstructions('https://github.com/skrishnan22/codevil.git');
		expect(prompt).toContain(WORKSPACE_REPO_DIR);
		expect(prompt).toMatch(/Slack message as the task/i);
		expect(prompt).toContain('checkpoint_working_branch');
		expect(prompt.toLowerCase()).not.toContain('clone that repo');
		expect(prompt).not.toMatch(/\bls\b/);
	});
});
