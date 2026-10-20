import { afterEach, expect, test, vi } from 'vitest';
import { pageScreenshot } from './browse.ts';

const { close, screenshot } = vi.hoisted(() => ({
	close: vi.fn<() => Promise<void>>(async () => {}),
	screenshot: vi.fn<() => Promise<Uint8Array>>(async () => new Uint8Array([3])),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- Browser Run is an external service; each page represents a distinct capture.
vi.mock('@cloudflare/puppeteer', () => ({
	launch: async () => ({
		newPage: async () => ({
			setViewport: async () => {},
			goto: async () => {},
			screenshot,
		}),
		close,
	}),
}));

afterEach(() => vi.clearAllMocks());

test('the attachment and preview use one loaded page, which closes after capture', async () => {
	let loads = 0;

	const shot = await pageScreenshot(
		{
			fetch,
			quickAction: async () => new Response(new Uint8Array([++loads])),
		},
		'https://example.com',
	);

	expect(shot.png).toEqual(shot.preview);
	expect(close).toHaveBeenCalledOnce();
});

test('closes the browser when screenshot capture fails', async () => {
	screenshot.mockRejectedValueOnce(new Error('Capture failed'));

	await expect(
		pageScreenshot({ fetch, quickAction: async () => new Response() }, 'https://example.com'),
	).rejects.toThrow('Capture failed');

	expect(close).toHaveBeenCalledOnce();
});
