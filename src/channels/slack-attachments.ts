import type { DeliveredAttachment } from '@flue/runtime';
import { slackFetch } from './slack-reply.ts';

const MAX_ATTACHMENT_BASE64_LENGTH = 14 * 1024 * 1024;

const MAX_IMAGE_BYTES = Math.floor((MAX_ATTACHMENT_BASE64_LENGTH / 4) * 3);

const DOWNLOAD_TIMEOUT_MS = 5_000;

export type SlackImageFile = {
	id?: string | null;
	name?: string | null;
	title?: string | null;
	mimetype?: string | null;
	size?: number | null;
	url_private?: string | null;
	url_private_download?: string | null;
};

export function base64FromBytes(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;

	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}

	return btoa(binary);
}

function downloadUrlFor(file: SlackImageFile): string | undefined {
	const url = file.url_private_download ?? file.url_private;

	if (!url) return undefined;

	try {
		const parsed = new URL(url);

		if (parsed.protocol !== 'https:') return undefined;

		return parsed.toString();
	} catch {
		return undefined;
	}
}

export async function downloadSlackImages(
	files: SlackImageFile[],
	token: string,
): Promise<DeliveredAttachment[]> {
	const attachments: DeliveredAttachment[] = [];
	const seen = new Set<string>();

	for (const file of files) {
		if (file.id && seen.has(file.id)) continue;

		if (file.id) seen.add(file.id);

		const mimeType = file.mimetype?.toLowerCase();
		const url = downloadUrlFor(file);

		if (!mimeType?.startsWith('image/') || !url) continue;

		if (file.size && file.size > MAX_IMAGE_BYTES) continue;

		try {
			const response = await slackFetch(url, {
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
			});

			if (!response.ok) continue;

			const responseMimeType = response.headers
				.get('content-type')
				?.split(';', 1)[0]
				?.toLowerCase();

			if (responseMimeType && !responseMimeType.startsWith('image/')) continue;

			const buffer = await response.arrayBuffer();
			const bytes = new Uint8Array(buffer);

			if (bytes.byteLength > MAX_IMAGE_BYTES) continue;

			const data = base64FromBytes(bytes);

			if (data.length > MAX_ATTACHMENT_BASE64_LENGTH) continue;

			attachments.push({
				type: 'image',
				data,
				mimeType,
				filename: file.name ?? file.title ?? undefined,
			});
		} catch (error) {
			console.warn(
				`[slack] image download failed${file.id ? ` for ${file.id}` : ''}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return attachments;
}
