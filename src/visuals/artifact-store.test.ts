import { expect, test } from 'vitest';
import { createArtifactStore, isArtifactId, type ArtifactBucket } from './artifact-store.ts';

function memoryBucket(): ArtifactBucket & { keys(): string[] } {
	const objects = new Map<string, { value: Uint8Array; customMetadata: Record<string, string> }>();

	return {
		keys: () => [...objects.keys()],
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

test('stores a PNG under its conversation and reads it back only there', async () => {
	const bucket = memoryBucket();
	const store = createArtifactStore(bucket);
	const png = new Uint8Array([1, 2, 3]);

	const artifactId = await store.put({ conversationId: 'conv/1', png, title: 'Flow' });

	expect(isArtifactId(artifactId)).toBe(true);
	expect(bucket.keys()).toEqual([`artifacts/conv%2F1/${artifactId}.png`]);
	await expect(store.get({ conversationId: 'conv/1', artifactId })).resolves.toEqual({
		artifactId,
		png,
		title: 'Flow',
	});
	await expect(store.get({ conversationId: 'conv-2', artifactId })).resolves.toBeUndefined();
});

test.each(['../conv/1/x', 'art_123', 'art_ZZZZZZZZZZZZZZZZZZZZ'])(
	'refuses a malformed artifact id: %s',
	async (artifactId) => {
		const store = createArtifactStore(memoryBucket());

		await expect(store.get({ conversationId: 'conv', artifactId })).resolves.toBeUndefined();
	},
);
