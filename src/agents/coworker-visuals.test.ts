import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
	type TranscriptContext,
} from '@earendil-works/pi-ai';
import { init } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
import { afterEach, expect, test, vi } from 'vitest';
import { INTEGRATION_CATALOG } from '../integrations/mcp-catalog.ts';
import { createArtifactStore, type ArtifactBucket } from '../visuals/artifact-store.ts';
import { setVisualRuntime } from '../visuals/visual-runtime.ts';
import type { RenderVisual } from '../visuals/visual-tools.ts';
import { Coworker } from './coworker.ts';
import { coworkerModel } from './model-choice.ts';

const { screenshot } = vi.hoisted(() => ({
	screenshot: vi.fn<(options: { type: string }) => Promise<Uint8Array>>(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- Browser Run transport is external to this agent integration test.
vi.mock('@cloudflare/puppeteer', async (importOriginal) => ({
	...(await importOriginal<typeof import('@cloudflare/puppeteer')>()),
	launch: async () => ({
		newPage: async () => ({
			setViewport: async () => {},
			goto: async () => {},
			screenshot,
		}),
		close: async () => {},
	}),
}));

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

const JPEG = new Uint8Array([255, 216, 255, 224, 4, 5, 6]);

const RENDER_PREVIEW = new Uint8Array([255, 216, 255, 224, 7, 8, 9]);

function memoryBucket(): ArtifactBucket {
	const objects = new Map<string, { value: Uint8Array; customMetadata: Record<string, string> }>();

	return {
		async put(key, value, options) {
			objects.set(key, { value, customMetadata: options.customMetadata });

			return { key };
		},
		async get(key) {
			const object = objects.get(key);

			if (!object) return null;

			return {
				arrayBuffer: async () => object.value.slice().buffer,
				customMetadata: object.customMetadata,
			};
		},
	};
}

function lastToolResult(context: TranscriptContext) {
	const last = context.messages.at(-1);

	if (last?.role !== 'toolResult') throw new Error('expected a tool result');

	return last;
}

/**
 * Checks that the last tool result carried its preview to the model, or a
 * note instead for a text-only model, and returns its artifact id.
 */
function reviewedArtifact({
	context,
	preview,
	seesImages,
}: {
	context: TranscriptContext;
	preview: Uint8Array;
	seesImages: boolean;
}): string {
	const result = lastToolResult(context);
	expect(result.isError).toBe(false);

	const text = result.content
		.flatMap((block) => (block.type === 'text' ? [block.text] : []))
		.join(' ');

	const images = result.content.filter((block) => block.type === 'image');

	const image = {
		type: 'image',
		mimeType: 'image/jpeg',
		data: Buffer.from(preview).toString('base64'),
	};

	expect(images).toEqual(seesImages ? [image] : []);
	expect(/cannot view images/.test(text)).toBe(!seesImages);

	const artifactId = /art_[0-9a-f]{20}/.exec(text)?.[0];

	if (!artifactId) throw new Error(`no artifact id in: ${text}`);

	return artifactId;
}

afterEach(() => {
	vi.clearAllMocks();
	setVisualRuntime(undefined);
	vi.unstubAllEnvs();
});

test.each([
	{ name: 'an image-capable model', modelId: 'kimi-k3', seesImages: true },
	{ name: 'a text-only model', modelId: undefined, seesImages: false },
])(
	'a render and a page screenshot reach $name and can be attached to the reply',
	async ({ modelId, seesImages }) => {
		vi.stubEnv('DAYTONA_API_KEY', 'test');
		vi.stubEnv('OPENCODE_API_KEY', 'test');
		vi.stubEnv('SLACK_BOT_TOKEN', '');

		for (const entry of INTEGRATION_CATALOG) vi.stubEnv(entry.authEnv, '');
		vi.stubEnv('EXA_API_KEY', '');
		vi.stubEnv('PARALLEL_API_KEY', '');

		const render = vi.fn<RenderVisual>(async () => ({
			png: PNG,
			preview: RENDER_PREVIEW,
			width: 300,
			height: 200,
		}));

		screenshot.mockImplementation(async ({ type }) => (type === 'jpeg' ? JPEG : PNG));

		setVisualRuntime({
			render,
			browser: {
				fetch,
				quickAction: async () => {
					throw new Error('unused');
				},
			},
			artifacts: createArtifactStore(memoryBucket()),
		});

		const choice = modelId ? { model: { provider: 'opencode-go' as const, modelId } } : undefined;

		const [provider, defaultId] = coworkerModel(undefined, false).specifier.split('/');

		const model = fauxProvider({
			provider,
			models: [
				{ id: modelId ?? defaultId ?? 'test', input: seesImages ? ['text', 'image'] : ['text'] },
			],
		});

		const directory = await mkdtemp(join(tmpdir(), 'coworker-visuals-'));
		let runtime: Awaited<ReturnType<typeof start>> | undefined;
		const artifacts: string[] = [];

		try {
			model.setResponses([
				(context) => {
					const names = getCurrentTools(context.messages).map((tool) => tool.name);
					expect(names).toEqual(expect.arrayContaining(['render_visual', 'browse_page']));
					expect(names).not.toContain('bash');

					return fauxAssistantMessage(
						fauxToolCall('render_visual', {
							kind: 'mermaid',
							source: 'graph LR; A-->B',
							title: 'Flow',
						}),
					);
				},
				(context) => {
					artifacts.push(reviewedArtifact({ context, preview: RENDER_PREVIEW, seesImages }));

					return fauxAssistantMessage(
						fauxToolCall('browse_page', { url: 'https://example.com', mode: 'screenshot' }),
					);
				},
				(context) => {
					artifacts.push(reviewedArtifact({ context, preview: JPEG, seesImages }));

					return fauxAssistantMessage(
						fauxToolCall('reply_in_slack_thread', {
							text: 'Here is the flow and the page.',
							images: artifacts.map((artifactId) => ({ artifactId, altText: 'A visual.' })),
						}),
					);
				},
				(context) => {
					expect(lastToolResult(context)).toMatchObject({
						toolName: 'reply_in_slack_thread',
						isError: false,
					});

					return fauxAssistantMessage('Done');
				},
			]);

			runtime = await start({
				agents: [Coworker],
				db: sqlite(join(directory, 'flue.db')),
				providers: [model.provider],
			});
			const agent = init(Coworker, { id: `visuals-${modelId ?? 'default'}` });

			const receipt = await agent.dispatch({
				message: 'Draw the flow and show me example.com',
				initialData: {
					channelId: 'C1',
					threadTs: '1',
					startedAt: '2026-10-18T00:00:00.000Z',
					modelChoice: choice,
				},
			});

			await agent.read(receipt);
			expect(render).toHaveBeenCalledWith({ kind: 'mermaid', source: 'graph LR; A-->B' });
			expect(screenshot).toHaveBeenCalledTimes(2);
		} finally {
			await runtime?.stop();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
