import { walkthroughExample, memoryBucket } from '../testing/walkthrough.ts';
import { createWalkthroughPublisher } from '../walkthroughs/publish.ts';
import { setVisualRuntime } from '../visuals/visual-runtime.ts';
import { createArtifactStore } from '../visuals/artifact-store.ts';
import type { RenderVisual } from '../visuals/visual-tools.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from '@earendil-works/pi-ai';
import { init } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
import * as v from 'valibot';
import { expect, test, vi } from 'vitest';
import { Coworker } from './coworker.ts';
import { coworkerModel } from './model-choice.ts';
import { INTEGRATION_CATALOG } from '../integrations/mcp-catalog.ts';
import { workingBranchName } from '../proxy/checkpoint.ts';
import type { DaytonaSandboxLike } from '../sandboxes/daytona.ts';
import { generateKeyPairSync } from 'node:crypto';

const external = vi.hoisted<{ files: Map<string, Buffer>; commands: string[]; creates: number }>(
	() => ({
		files: new Map<string, Buffer>(),
		commands: [],
		creates: 0,
	}),
);

// oxlint-disable-next-line anti-slop/no-module-mocking -- Replace only the external Daytona SDK; exercise the real factory, adapter, and hydration without a live container.
vi.mock('@daytona/sdk', async (importOriginal) => {
	const sdk = await importOriginal<typeof import('@daytona/sdk')>();

	const sandbox: DaytonaSandboxLike = {
		id: 'test-container',
		sandboxClass: 'container',
		state: 'started',
		async refreshData() {},
		async stop() {},
		async start() {},
		fs: {
			async downloadFile(path) {
				const content = external.files.get(path);

				if (!content) throw new sdk.DaytonaFileNotFoundError(path);

				return content;
			},
			async uploadFile(content, path) {
				external.files.set(path, content);
			},
			async getFileDetails(path) {
				if (!external.files.has(path) && !path.endsWith('/.git'))
					throw new sdk.DaytonaFileNotFoundError(path);

				return { isDir: path.endsWith('/.git'), size: 0, modifiedAt: '2026-10-14', name: path };
			},
			async listFiles() {
				return [];
			},
			async createFolder() {},
			async deleteFile() {},
		},
		process: {
			async executeCommand(command) {
				external.commands.push(command);
				let result = '';

				if (command === 'pwd') result = '/workspace/repo';

				if (command === 'git rev-parse --abbrev-ref HEAD') result = workingBranchName('attachment');

				return { exitCode: 0, result };
			},
		},
	};

	return {
		...sdk,
		Daytona: class {
			snapshot = { get: async () => ({ sandboxClass: 'container' }) };
			async get() {
				throw new sdk.DaytonaNotFoundError('not found');
			}
			async *list() {}
			async create() {
				external.creates++;

				return sandbox;
			}
		},
	};
});

const REPO = 'https://github.com/acme/api.git';

const reply = () => fauxAssistantMessage(fauxToolCall('reply_in_slack_thread', { text: 'Done' }));

function expectAttached(context: TranscriptContext, repo = REPO) {
	const names = getCurrentTools(context.messages).map((tool) => tool.name);
	expect(names).not.toContain('attach_repo');
	expect(names).toContain('bash');
	expect(names).toContain('open_pull_request');
	expect(getCurrentSystemPrompt(context.messages)).toContain(repo);
}

test.each([
	'single attachment',
	'two attachments in one turn',
	'repeat same attachment',
	'legacy initial repo',
])('%s enables the workspace and GitHub tools and survives a runtime restart', async (scenario) => {
	vi.stubEnv('DAYTONA_API_KEY', 'test');
	vi.stubEnv('OPENCODE_API_KEY', 'test');
	vi.stubEnv('SLACK_BOT_TOKEN', '');
	const directory = await mkdtemp(join(tmpdir(), 'coworker-attachment-'));
	const database = join(directory, 'flue.db');
	const [provider, modelId] = coworkerModel(undefined, false).specifier.split('/');
	const model = fauxProvider({ provider, models: [{ id: modelId ?? 'test' }] });
	let runtime: Awaited<ReturnType<typeof start>> | undefined;
	external.files.clear();
	external.commands = [];
	external.creates = 0;
	const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	vi.stubEnv('GITHUB_APP_ID', '1');
	vi.stubEnv('GITHUB_APP_INSTALLATION_ID', '2');
	vi.stubEnv(
		'GITHUB_APP_PRIVATE_KEY',
		privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
	);

	for (const entry of INTEGRATION_CATALOG) vi.stubEnv(entry.authEnv, '');
	vi.stubEnv('EXA_API_KEY', '');
	vi.stubEnv('PARALLEL_API_KEY', '');
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async (url, options) => {
			const httpRequest = new Request(url, options);
			const address = httpRequest.url;

			if (address.endsWith('/access_tokens')) {
				const body = await httpRequest.text();

				const request = v.parse(v.object({ repositories: v.array(v.string()) }), JSON.parse(body));

				return Response.json({
					token: 'test-token',
					expires_at: '2099-01-01T00:00:00Z',
					repositories: request.repositories.map((name) => ({ full_name: `acme/${name}` })),
				});
			}

			if (address.endsWith('/installation/token')) return new Response(null, { status: 204 });
			throw new Error(`Unexpected network request: ${address}`);
		}),
	);

	try {
		model.setResponses([
			(context) => {
				const startsAttached = scenario === 'legacy initial repo';
				const names = getCurrentTools(context.messages).map((tool) => tool.name);
				expect(names.includes('attach_repo')).toBe(!startsAttached);
				expect(names.includes('bash')).toBe(startsAttached);
				expect(names.includes('open_pull_request')).toBe(startsAttached);
				expect(external.creates).toBe(startsAttached ? 1 : 0);

				if (startsAttached) return fauxAssistantMessage(fauxToolCall('bash', { command: 'pwd' }));
				const calls = [fauxToolCall('attach_repo', { repo: 'acme/api' })];

				if (scenario === 'two attachments in one turn') {
					calls.push(fauxToolCall('attach_repo', { repo: 'acme/other' }));
				}

				if (scenario === 'repeat same attachment')
					calls.push(fauxToolCall('attach_repo', { repo: 'acme/api' }));

				return fauxAssistantMessage(calls);
			},
			(context) => {
				expectAttached(context);

				const rejectedAttachment = context.messages.some(
					(message) =>
						message.role === 'toolResult' && message.toolName === 'attach_repo' && message.isError,
				);

				expect(rejectedAttachment).toBe(scenario === 'two attachments in one turn');

				return fauxAssistantMessage(fauxToolCall('bash', { command: 'pwd' }));
			},
			(context) => {
				const last = context.messages.at(-1);
				expect(last).toMatchObject({ role: 'toolResult', toolName: 'bash', isError: false });
				expect(JSON.stringify(last)).toContain('/workspace/repo');
				// The sandbox hydrates on the first file or shell call after attaching.
				expect(external.commands).toContain(`git clone --depth 1 '${REPO}' '/workspace/repo'`);

				return reply();
			},
			fauxAssistantMessage('Done'),
		]);
		runtime = await start({
			agents: [Coworker],
			db: sqlite(database),
			providers: [model.provider],
		});
		const agent = init(Coworker, { id: 'attachment' });

		const receipt = await agent.dispatch({
			message: 'Work on acme/api',
			initialData: {
				channelId: 'C1',
				threadTs: '1',
				startedAt: '2026-10-14T00:00:00.000Z',
				repo: scenario === 'legacy initial repo' ? REPO : undefined,
			},
		});

		await agent.read(receipt);
		expect(external.creates).toBe(1);
		await runtime.stop();
		runtime = undefined;

		model.setResponses([
			(context) => {
				expectAttached(context);

				return reply();
			},
			fauxAssistantMessage('Done'),
		]);
		runtime = await start({
			agents: [Coworker],
			db: sqlite(database),
			providers: [model.provider],
		});
		const reopened = init(Coworker, { id: 'attachment' });
		const continued = await reopened.dispatch('Continue');
		await reopened.read(continued);
		const marker = external.files.get('/workspace/.workspace_ready');
		expect(JSON.parse(marker?.toString() ?? '{}')).toMatchObject({ repo: REPO });
	} finally {
		await runtime?.stop();
		await rm(directory, { recursive: true, force: true });
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	}
});

test('an attached Coworker can publish a walkthrough and receive its image through Flue', async () => {
	vi.stubEnv('DAYTONA_API_KEY', 'test');
	vi.stubEnv('OPENCODE_API_KEY', 'test');
	vi.stubEnv('SLACK_BOT_TOKEN', '');

	for (const entry of INTEGRATION_CATALOG) vi.stubEnv(entry.authEnv, '');
	vi.stubEnv('EXA_API_KEY', '');
	vi.stubEnv('PARALLEL_API_KEY', '');
	external.files.clear();
	external.files.set(
		'/workspace/.workspace_ready',
		Buffer.from(JSON.stringify({ version: 1, repo: REPO, lockfile: null, lockfileSha256: null })),
	);
	vi.stubGlobal('fetch', async () => {
		throw new Error('Unexpected network request');
	});
	const RENDER_PREVIEW = new Uint8Array([2]);
	const PNG = new Uint8Array([1]);
	const bucket = memoryBucket();

	const render: RenderVisual = async () => ({
		png: PNG,
		preview: RENDER_PREVIEW,
		width: 1280,
		height: 900,
	});

	setVisualRuntime({
		render,
		browser: {
			fetch,
			quickAction: async () => {
				throw new Error('unused');
			},
		},
		artifacts: createArtifactStore(bucket),
		publishWalkthrough: createWalkthroughPublisher({
			bucket,
			origin: 'https://agent.example',
			render: () => render({ kind: 'html', source: '' }),
		}),
	});
	const [provider] = coworkerModel(undefined, false).specifier.split('/');
	const model = fauxProvider({ provider, models: [{ id: 'kimi-k3', input: ['text', 'image'] }] });
	const { repository: _repository, ...input } = walkthroughExample;
	model.setResponses([
		(context) => {
			expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain(
				'render_walkthrough',
			);

			return fauxAssistantMessage(fauxToolCall('render_walkthrough', input));
		},
		(context) => {
			const result = context.messages.at(-1);

			if (result?.role !== 'toolResult') throw new Error('Expected a walkthrough tool result');
			expect(result.isError).toBe(false);
			expect(result.content).toEqual(
				expect.arrayContaining([
					{
						type: 'image',
						data: Buffer.from(RENDER_PREVIEW).toString('base64'),
						mimeType: 'image/jpeg',
					},
				]),
			);
			expect(result.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: 'text',
						text: expect.stringContaining('https://agent.example/walkthroughs/'),
					}),
				]),
			);

			return fauxAssistantMessage(
				fauxToolCall('reply_in_slack_thread', { text: 'Walkthrough ready.' }),
			);
		},
		() => fauxAssistantMessage('Done'),
	]);
	const directory = await mkdtemp(join(tmpdir(), 'coworker-walkthrough-'));

	const runtime = await start({
		agents: [Coworker],
		db: sqlite(join(directory, 'flue.db')),
		providers: [model.provider],
	});

	try {
		const agent = init(Coworker, { id: 'attachment' });

		const receipt = await agent.dispatch({
			message: 'Generate the PR walkthrough.',
			initialData: {
				channelId: 'C1',
				threadTs: '1',
				startedAt: '2026-10-24T00:00:00.000Z',
				repo: REPO,
				modelChoice: { model: { provider: 'opencode-go', modelId: 'kimi-k3' } },
			},
		});

		await agent.read(receipt);
	} finally {
		setVisualRuntime(undefined);
		await runtime.stop();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		await rm(directory, { recursive: true, force: true });
	}
});
