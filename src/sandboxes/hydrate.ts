import { DaytonaFileNotFoundError, DaytonaNotFoundError } from '@daytona/sdk';
import type { DaytonaSandboxLike } from './daytona.ts';

export const WORKSPACE_REPO_DIR = '/workspace/repo';
export const WORKSPACE_READY_PATH = '/workspace/.workspace_ready';

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock'] as const;

export type HydrateExec = (
	command: string,
	options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type HydrateIo = {
	exec: HydrateExec;
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	exists(path: string): Promise<boolean>;
};

export type GitAuthor = { name: string; email: string };

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function installCommandForLockfile(lockfileName: string): string | undefined {
	switch (lockfileName) {
		case 'pnpm-lock.yaml':
			return 'corepack pnpm install --frozen-lockfile';
		case 'package-lock.json':
			return 'npm ci';
		case 'yarn.lock':
			return 'corepack yarn install --immutable';
		case 'bun.lock':
			return 'bun install --frozen-lockfile';
		default:
			return undefined;
	}
}

export function workingBranchName(conversationId: string): string {
	const slug = conversationId
		.replace(/[^a-zA-Z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return `agent/${slug || 'conversation'}`;
}

export function coworkerInstructions(repo: string): string {
	return [
		'You are a Slack-native engineering coworker.',
		`This conversation is bound to one Slack thread and the repository ${repo}.`,
		`The workspace is already cloned and dependencies are installed at ${WORKSPACE_REPO_DIR}.`,
		'Treat the Slack message as the task.',
		'Inspect, edit, and test with sandbox tools in that directory.',
		'Do not clone the repository or treat listing the tree as the job.',
		'Do not merge or deploy. Do not choose a different Slack channel or thread.',
		'Reply with the reply_in_slack_thread tool.',
	].join(' ');
}

export function markerMatchesRepo(contents: string, repo: string): boolean {
	try {
		const parsed: unknown = JSON.parse(contents);
		return (
			typeof parsed === 'object' &&
			parsed !== null &&
			(parsed as { version?: unknown }).version === 1 &&
			(parsed as { repo?: unknown }).repo === repo
		);
	} catch {
		return false;
	}
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function mustExec(
	io: HydrateIo,
	command: string,
	options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<void> {
	const result = await io.exec(command, options);
	if (result.exitCode !== 0) {
		throw new Error(
			`[slack-agent] hydration failed: ${command}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
		);
	}
}

export async function detectLockfile(io: HydrateIo, repoDir: string): Promise<string | undefined> {
	for (const name of LOCKFILES) {
		if (await io.exists(`${repoDir}/${name}`)) return name;
	}
	return undefined;
}

export async function hydrateWorkspace(
	io: HydrateIo,
	args: { repo: string; conversationId: string; git?: GitAuthor },
): Promise<{ cwd: string; skipped: boolean; durationMs: number; lockfile?: string }> {
	const started = Date.now();
	if (await io.exists(WORKSPACE_READY_PATH)) {
		const raw = await io.readFile(WORKSPACE_READY_PATH);
		if (markerMatchesRepo(raw, args.repo)) {
			return {
				cwd: WORKSPACE_REPO_DIR,
				skipped: true,
				durationMs: Date.now() - started,
			};
		}
	}

	await mustExec(io, `rm -rf ${shellQuote(WORKSPACE_REPO_DIR)}`);
	await mustExec(io, `git clone --depth 1 ${shellQuote(args.repo)} ${shellQuote(WORKSPACE_REPO_DIR)}`, {
		timeoutMs: 600_000,
	});

	const lockfile = await detectLockfile(io, WORKSPACE_REPO_DIR);
	const install = lockfile ? installCommandForLockfile(lockfile) : undefined;
	if (install) {
		await mustExec(io, install, { cwd: WORKSPACE_REPO_DIR, timeoutMs: 600_000 });
	}

	await mustExec(io, `git checkout -B ${shellQuote(workingBranchName(args.conversationId))}`, {
		cwd: WORKSPACE_REPO_DIR,
	});

	if (args.git) {
		await mustExec(io, `git config user.name ${shellQuote(args.git.name)}`, {
			cwd: WORKSPACE_REPO_DIR,
		});
		await mustExec(io, `git config user.email ${shellQuote(args.git.email)}`, {
			cwd: WORKSPACE_REPO_DIR,
		});
	}

	let lockfileSha256: string | null = null;
	if (lockfile) {
		lockfileSha256 = await sha256Hex(await io.readFile(`${WORKSPACE_REPO_DIR}/${lockfile}`));
	}

	await io.writeFile(
		WORKSPACE_READY_PATH,
		JSON.stringify({
			version: 1,
			repo: args.repo,
			lockfile: lockfile ?? null,
			lockfileSha256,
			hydratedAt: new Date().toISOString(),
		}),
	);

	return {
		cwd: WORKSPACE_REPO_DIR,
		skipped: false,
		durationMs: Date.now() - started,
		lockfile,
	};
}

export function hydrateIoFromDaytona(sandbox: DaytonaSandboxLike): HydrateIo {
	return {
		async exec(command, options) {
			const timeoutSeconds =
				typeof options?.timeoutMs === 'number' ? Math.ceil(options.timeoutMs / 1000) : 600;
			const response = await sandbox.process.executeCommand(
				command,
				options?.cwd,
				options?.env,
				timeoutSeconds,
			);
			return { stdout: response.result, stderr: '', exitCode: response.exitCode };
		},
		async readFile(path) {
			return (await sandbox.fs.downloadFile(path)).toString('utf8');
		},
		async writeFile(path, content) {
			await sandbox.fs.uploadFile(Buffer.from(content, 'utf8'), path);
		},
		async exists(path) {
			try {
				await sandbox.fs.getFileDetails(path);
				return true;
			} catch (error) {
				if (error instanceof DaytonaNotFoundError || error instanceof DaytonaFileNotFoundError) {
					return false;
				}
				throw error;
			}
		},
	};
}
