import { expect, test, vi } from 'vitest';
import { walkthroughExample as example, memoryBucket } from '../testing/walkthrough.ts';
import { createWalkthroughPublisher } from './publish.ts';

const rendered = {
	png: new Uint8Array([1, 2]),
	preview: new Uint8Array([3, 4]),
	width: 1280,
	height: 900,
};

test('publishes an unlisted link and reuses its stored preview without rendering again', async () => {
	const render = vi.fn<() => Promise<typeof rendered>>(async () => rendered);

	const publish = createWalkthroughPublisher({
		bucket: memoryBucket(),
		origin: 'https://agent.example',
		render,
	});

	const first = await publish({ conversationId: 'one', input: example });
	const second = await publish({ conversationId: 'one', input: { ...example } });
	expect(first.url).toMatch(/^https:\/\/agent\.example\/walkthroughs\/[a-f0-9]{32}$/);
	expect(second).toEqual({ ...first, cached: true });
	expect(render).toHaveBeenCalledOnce();
	expect(first.preview).toEqual(rendered.preview);
	const separate = await publish({ conversationId: 'two', input: example });
	expect(separate.url).not.toBe(first.url);
	expect(render).toHaveBeenCalledTimes(2);
});

test.each([
	{
		...example,
		nodes: [
			{ id: 'slack', label: 'Slack' },
			{ id: 'slack', label: 'Duplicate' },
		],
	},
	{ ...example, edges: [{ from: 'slack', to: 'missing' }] },
	{ ...example, steps: [{ ...example.steps[0], activeNodes: ['missing'] }] },
	{ ...example, steps: [{ ...example.steps[0], highlight: 99 }] },
	{ ...example, steps: [{ ...example.steps[0], source: { path: '../secrets', line: 1 } }] },
	{
		...example,
		steps: Array.from({ length: 7 }, (_, i) => ({ ...example.steps[0], name: `step-${i}` })),
	},
])('refuses invalid authoring before using Browser Run', async (input) => {
	const render = vi.fn<() => Promise<typeof rendered>>(async () => rendered);

	const publish = createWalkthroughPublisher({
		bucket: memoryBucket(),
		origin: 'https://agent.example',
		render,
	});

	await expect(publish({ conversationId: 'one', input })).rejects.toThrow(/.+/);
	expect(render).not.toHaveBeenCalled();
});

test('failed rendering is retryable and changed scenes get a new link', async () => {
	const render = vi
		.fn<() => Promise<typeof rendered>>()
		.mockRejectedValueOnce(new Error('Browser unavailable'))
		.mockResolvedValue(rendered);

	const publish = createWalkthroughPublisher({
		bucket: memoryBucket(),
		origin: 'https://agent.example',
		render,
	});

	await expect(publish({ conversationId: 'one', input: example })).rejects.toThrow(
		'Browser unavailable',
	);
	const first = await publish({ conversationId: 'one', input: example });

	const changed = await publish({
		conversationId: 'one',
		input: { ...example, title: 'Revised explanation' },
	});

	expect(changed.url).not.toBe(first.url);
	expect(render).toHaveBeenCalledTimes(3);
});
