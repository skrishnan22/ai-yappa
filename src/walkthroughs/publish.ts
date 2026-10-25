import * as v from 'valibot';
import type { ArtifactBucket } from '../visuals/artifact-store.ts';
import type { RenderedVisual } from '../visuals/render.ts';
import { walkthroughSchema, type Walkthrough } from './format.ts';

const cacheEntry = v.object({
	id: v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/)),
	width: v.number(),
	height: v.number(),
});

const encoder = new TextEncoder();

export type PublishedWalkthrough = {
	url: string;
	previewUrl: string;
	preview: Uint8Array;
	width: number;
	height: number;
	cached: boolean;
};

export type PublishWalkthrough = ReturnType<typeof createWalkthroughPublisher>;

export function createWalkthroughPublisher({
	bucket,
	origin,
	render,
}: {
	bucket: ArtifactBucket;
	origin: string;
	render: (input: {
		source: string;
		conversationId: string;
		headSha: string;
	}) => Promise<RenderedVisual>;
}) {
	return async ({
		conversationId,
		input,
	}: {
		conversationId: string;
		input: Walkthrough;
	}): Promise<PublishedWalkthrough> => {
		const doc = v.parse(walkthroughSchema, input);
		const source = JSON.stringify(doc);

		// Bump the version when scene layout or preview rendering changes.
		const digest = await crypto.subtle.digest(
			'SHA-256',
			encoder.encode(JSON.stringify([1, conversationId, doc])),
		);

		const hash = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, '0'),
		).join('');

		const cacheKey = `walkthrough-cache/${hash}.json`;
		const cached = await bucket.get(cacheKey);

		if (cached) {
			const bytes = await cached.arrayBuffer();
			const entry = v.parse(cacheEntry, JSON.parse(new TextDecoder().decode(bytes)));
			const preview = await bucket.get(`walkthroughs/${entry.id}.jpg`);

			if (preview) {
				const previewBytes = await preview.arrayBuffer();

				return published({ ...entry, preview: new Uint8Array(previewBytes), cached: true, origin });
			}
		}

		const rendered = await render({ source, conversationId, headSha: doc.headSha });
		const id = crypto.randomUUID().replaceAll('-', '');
		const prefix = `walkthroughs/${id}`;
		await put({ key: `${prefix}.png`, bytes: rendered.png, contentType: 'image/png' });
		await put({ key: `${prefix}.jpg`, bytes: rendered.preview, contentType: 'image/jpeg' });
		await put({
			key: `${prefix}.json`,
			bytes: encoder.encode(source),
			contentType: 'application/json',
		});
		const entry = { id, width: rendered.width, height: rendered.height };
		await put({
			key: cacheKey,
			bytes: encoder.encode(JSON.stringify(entry)),
			contentType: 'application/json',
		});

		return published({ ...entry, preview: rendered.preview, cached: false, origin });
	};

	async function put({
		key,
		bytes,
		contentType,
	}: {
		key: string;
		bytes: Uint8Array;
		contentType: string;
	}): Promise<void> {
		await bucket.put(key, bytes, { httpMetadata: { contentType }, customMetadata: {} });
	}
}

function published({
	id,
	preview,
	width,
	height,
	cached,
	origin,
}: {
	id: string;
	preview: Uint8Array;
	width: number;
	height: number;
	cached: boolean;
	origin: string;
}): PublishedWalkthrough {
	const url = new URL(`/walkthroughs/${id}`, origin).href;

	return { url, previewUrl: `${url}/preview.png`, preview, width, height, cached };
}
