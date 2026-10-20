/**
 * Owner-chosen image uploads into the bound thread (ADR 0025, decision 7):
 * `files.getUploadURLExternal`, POST the bytes, then one
 * `files.completeUploadExternal` that shares every image as a thread reply.
 */
import type { SlackBotClient } from './slack-reply.ts';

export type ThreadImage = {
	filename: string;
	title: string;
	altText: string;
	png: Uint8Array;
};

export type UploadedImages = { fileIds: string[] };

/**
 * `completeUploadExternal` can be called only once per upload, so a failed
 * completion starts new uploads instead of retrying it.
 */
const COMPLETION_ATTEMPTS = 2;

export async function uploadThreadImages({
	client,
	channelId,
	threadTs,
	images,
}: {
	client: Pick<SlackBotClient, 'files'>;
	channelId: string;
	threadTs: string;
	images: readonly ThreadImage[];
}): Promise<UploadedImages> {
	let lastError: unknown;

	for (let attempt = 0; attempt < COMPLETION_ATTEMPTS; attempt++) {
		const files = [];

		for (const image of images) {
			files.push({ id: await uploadBytes({ client, image }), title: image.title });
		}

		const [first, ...rest] = files;

		if (!first) return { fileIds: [] };

		try {
			await client.files.completeUploadExternal({
				files: [first, ...rest],
				channel_id: channelId,
				thread_ts: threadTs,
			});

			return { fileIds: files.map((file) => file.id) };
		} catch (error) {
			lastError = error;
		}
	}

	throw lastError;
}

async function uploadBytes({
	client,
	image,
}: {
	client: Pick<SlackBotClient, 'files'>;
	image: ThreadImage;
}): Promise<string> {
	// Slack expects alt_txt; the SDK currently declares it as alt_text.
	const request = {
		filename: image.filename,
		length: image.png.byteLength,
		alt_txt: image.altText,
	};

	const target = await client.files.getUploadURLExternal(request);

	if (!target.upload_url || !target.file_id) {
		throw new Error('Slack did not return an upload URL.');
	}

	const response = await fetch(target.upload_url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/octet-stream' },
		body: image.png,
	});

	if (!response.ok) {
		throw new Error(`Slack rejected the image upload (HTTP ${response.status}).`);
	}

	return target.file_id;
}
