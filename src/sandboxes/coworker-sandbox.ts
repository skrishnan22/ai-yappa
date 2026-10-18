/**
 * The one sandbox factory the Coworker mounts, in every conversation.
 *
 * Without a repository the sandbox is empty and its tool list holds no file
 * or shell tools, so a chat-only conversation gets no container. ADR 0025's
 * visual tools need a sandbox in every conversation: sandbox-factory tools
 * are the Flue path whose results keep image blocks.
 *
 * The factory stays mounted for the conversation's life, and Flue only
 * swaps environments when `useSandbox` presence flips. So instead of
 * replacing the empty sandbox when `attach_repo` succeeds mid-run, the
 * sandbox delegates: once `repo()` returns a repository, the next file or
 * shell operation creates (or reattaches) the Daytona sandbox, and the
 * tool list, which Flue rebuilds every turn, gains the standard tools.
 */
import {
	createBashTool,
	createEditTool,
	createGlobTool,
	createGrepTool,
	createReadTool,
	createWriteTool,
	sandboxFromDriver,
	type FileStat,
	type Sandbox,
	type SandboxDriver,
	type SandboxFactory,
} from '@flue/runtime';

const NO_REPOSITORY =
	'No repository is attached to this conversation. Call attach_repo before working with files or the shell.';

export function coworkerSandbox({
	cwd,
	repo,
	createRepoSandbox,
}: {
	cwd: string;
	/** The conversation's attached repository, read live. */
	repo: () => string | undefined;
	createRepoSandbox: (options: { id: string }) => Promise<Sandbox>;
}): SandboxFactory {
	return {
		async createSandbox(options) {
			let repoSandbox: Promise<Sandbox> | undefined;
			const empty = sandboxFromDriver(emptyDriver, cwd);

			const target = async (): Promise<Sandbox> => {
				if (!repo()) return empty;

				if (!repoSandbox) {
					repoSandbox = createRepoSandbox(options);
					// A failed creation is not cached: the next operation tries again.
					repoSandbox.catch(() => {
						repoSandbox = undefined;
					});
				}

				return repoSandbox;
			};

			return sandboxFromDriver(delegatingDriver(target), cwd);
		},
		tools(sandbox) {
			if (!repo()) return [];

			return [
				createReadTool(sandbox),
				createWriteTool(sandbox),
				createEditTool(sandbox),
				createBashTool(sandbox),
				createGrepTool(sandbox),
				createGlobTool(sandbox),
			];
		},
	};
}

function delegatingDriver(target: () => Promise<Sandbox>): SandboxDriver {
	return {
		readFile: async (path) => (await target()).readFile(path),
		readFileBuffer: async (path) => (await target()).readFileBuffer(path),
		writeFile: async (path, content) => (await target()).writeFile(path, content),
		stat: async (path) => (await target()).stat(path),
		readdir: async (path) => (await target()).readdir(path),
		exists: async (path) => (await target()).exists(path),
		mkdir: async (path, options) => (await target()).mkdir(path, options),
		rm: async (path, options) => (await target()).rm(path, options),
		exec: async (command, options) => (await target()).exec(command, options),
	};
}

/** No files and no shell. Flue's discovery reads see an empty tree. */
const emptyDriver: SandboxDriver = {
	async readFile(path) {
		throw missing(path);
	},
	async readFileBuffer(path) {
		throw missing(path);
	},
	async writeFile() {
		throw new Error(NO_REPOSITORY);
	},
	async stat(path): Promise<FileStat> {
		throw missing(path);
	},
	async readdir() {
		return [];
	},
	async exists() {
		return false;
	},
	async mkdir() {
		throw new Error(NO_REPOSITORY);
	},
	async rm() {
		throw new Error(NO_REPOSITORY);
	},
	async exec() {
		return { stdout: '', stderr: NO_REPOSITORY, exitCode: 1 };
	},
};

function missing(path: string): Error {
	return Object.assign(new Error(`ENOENT: ${path} (${NO_REPOSITORY})`), { code: 'ENOENT' });
}
