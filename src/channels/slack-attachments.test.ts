import { afterEach, describe, expect, test, vi } from 'vitest';
import { base64FromBytes, downloadSlackImages } from './slack-attachments.ts';

const token = 'xoxb-test';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('Slack image attachments', () => {
	test('encodes bytes as base64', () => {
		expect(base64FromBytes(new Uint8Array([72, 105]))).toBe('SGk=');
	});

	test('downloads image files with the bot token', async () => {
		const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
			const url = input instanceof Request ? input.url : input.toString();

			expect(url).toBe('https://files.slack.com/files-pri/F1/download');
			expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);

			return new Response(new Uint8Array([137, 80, 78, 71]), {
				status: 200,
				headers: { 'content-type': 'image/png' },
			});
		});

		vi.stubGlobal('fetch', fetchMock);

		await expect(
			downloadSlackImages(
				[
					{
						id: 'F1',
						name: 'screen.png',
						mimetype: 'image/png',
						url_private_download: 'https://files.slack.com/files-pri/F1/download',
					},
				],
				token,
			),
		).resolves.toEqual([
			{
				type: 'image',
				data: 'iVBORw==',
				mimeType: 'image/png',
				filename: 'screen.png',
			},
		]);
	});

	test('ignores non-images, unsafe URLs, and duplicate files', async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => new Response('not used'));

		vi.stubGlobal('fetch', fetchMock);

		await expect(
			downloadSlackImages(
				[
					{ id: 'F1', mimetype: 'text/plain', url_private: 'https://files.slack.com/F1' },
					{ id: 'F2', mimetype: 'image/png', url_private: 'http://files.slack.com/F2' },
					{ id: 'F3', mimetype: 'image/png', url_private: 'https://files.slack.com/F3' },
					{ id: 'F3', mimetype: 'image/png', url_private: 'https://files.slack.com/F3' },
				],
				token,
			),
		).resolves.toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
