/**
 * Rendered PNGs in R2 (ADR 0025, decision 6). Keys are
 * `artifacts/<conversationId>/<artifactId>.png`; the bucket's lifecycle rule
 * deletes them after 15 days. The model names an artifact only by id, and a
 * lookup is always scoped to the caller's own conversation.
 */

// The subset of the R2 binding this module uses.
export type ArtifactBucket = {
	put(
		key: string,
		value: Uint8Array,
		options: {
			httpMetadata: { contentType: string };
			customMetadata: Record<string, string>;
		},
	): Promise<{ key: string } | null>;
	get(key: string): Promise<{
		arrayBuffer(): Promise<ArrayBuffer>;
		customMetadata?: Record<string, string>;
	} | null>;
};

export type StoredArtifact = {
	artifactId: string;
	png: Uint8Array;
	title: string;
};

export type ArtifactStore = {
	put(artifact: { conversationId: string; png: Uint8Array; title: string }): Promise<string>;
	/** Absent when the id is malformed, another conversation's, or expired. */
	get(ref: { conversationId: string; artifactId: string }): Promise<StoredArtifact | undefined>;
};

const ARTIFACT_ID = /^art_[0-9a-f]{20}$/;

export function isArtifactId(value: string): boolean {
	return ARTIFACT_ID.test(value);
}

function artifactKey(conversationId: string, artifactId: string): string {
	return `artifacts/${encodeURIComponent(conversationId)}/${artifactId}.png`;
}

function newArtifactId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(10));

	return `art_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function createArtifactStore(bucket: ArtifactBucket): ArtifactStore {
	return {
		async put({ conversationId, png, title }) {
			const artifactId = newArtifactId();

			await bucket.put(artifactKey(conversationId, artifactId), png, {
				httpMetadata: { contentType: 'image/png' },
				customMetadata: { title },
			});

			return artifactId;
		},
		async get({ conversationId, artifactId }) {
			if (!isArtifactId(artifactId)) return undefined;

			const object = await bucket.get(artifactKey(conversationId, artifactId));

			if (!object) return undefined;

			const bytes = await object.arrayBuffer();

			return {
				artifactId,
				png: new Uint8Array(bytes),
				title: object.customMetadata?.title ?? artifactId,
			};
		},
	};
}
