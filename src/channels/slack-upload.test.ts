import { expect, test, vi } from 'vitest';
import type { SlackBotClient } from './slack-reply.ts';
import { uploadThreadImages, type ThreadImage } from './slack-upload.ts';

const image: ThreadImage = {
	filename: 'art_1.png',
	title: 'Flow',
	altText: 'A flow diagram.',
	png: new Uint8Array([1, 2, 3]),
};

function fakeFiles({ failCompletions }: { failCompletions: number }) {
	let uploads = 0;
	let failures = failCompletions;

	return {
		getUploadURLExternal: vi.fn<SlackBotClient['files']['getUploadURLExternal']>(async () => {
			uploads++;

			return {
				ok: true,
				upload_url: `https://files.example/upload/${uploads}`,
				file_id: `F${uploads}`,
			};
		}),
		completeUploadExternal: vi.fn<SlackBotClient['files']['completeUploadExternal']>(async () => {
			if (failures > 0) {
				failures--;
				throw new Error('An API error occurred: internal_error');
			}

			return { ok: true };
		}),
	};
}

test('uploads every image and shares them in the thread with one completion', async () => {
	const posted: string[] = [];
	vi.stubGlobal('fetch', async (url: string) => {
		posted.push(url);

		return new Response('OK');
	});
	const files = fakeFiles({ failCompletions: 0 });

	try {
		const result = await uploadThreadImages({
			client: { files },
			channelId: 'C1',
			threadTs: '1.2',
			images: [image, { ...image, filename: 'art_2.png', title: 'Chart' }],
		});

		expect(result).toEqual({ fileIds: ['F1', 'F2'] });
		expect(posted).toEqual(['https://files.example/upload/1', 'https://files.example/upload/2']);
		expect(files.getUploadURLExternal).toHaveBeenCalledWith({
			filename: 'art_1.png',
			length: 3,
			alt_txt: 'A flow diagram.',
		});
		expect(files.completeUploadExternal).toHaveBeenCalledOnce();
		expect(files.completeUploadExternal).toHaveBeenCalledWith({
			files: [
				{ id: 'F1', title: 'Flow' },
				{ id: 'F2', title: 'Chart' },
			],
			channel_id: 'C1',
			thread_ts: '1.2',
		});
	} finally {
		vi.unstubAllGlobals();
	}
});

test('a failed completion starts a fresh upload instead of completing the same file twice', async () => {
	vi.stubGlobal('fetch', async () => new Response('OK'));
	const files = fakeFiles({ failCompletions: 1 });

	try {
		const result = await uploadThreadImages({
			client: { files },
			channelId: 'C1',
			threadTs: '1.2',
			images: [image],
		});

		expect(result).toEqual({ fileIds: ['F2'] });
		expect(files.completeUploadExternal.mock.calls.map(([args]) => args.files)).toEqual([
			[{ id: 'F1', title: 'Flow' }],
			[{ id: 'F2', title: 'Flow' }],
		]);
	} finally {
		vi.unstubAllGlobals();
	}
});
