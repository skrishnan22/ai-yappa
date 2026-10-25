import type { ArtifactBucket } from '../visuals/artifact-store.ts';
import type { Walkthrough } from '../walkthroughs/format.ts';

export const walkthroughExample = {
	title: 'Slack images reach Coworker',
	repository: 'skrishnan22/ai-yappa',
	baseSha: 'a'.repeat(40),
	headSha: '799c9879ce6c7e03ab82fd5ff2817ebb41ca9fa1',
	nodes: [
		{ id: 'slack', label: 'Slack' },
		{ id: 'agent', label: 'Coworker' },
	],
	edges: [{ from: 'slack', to: 'agent' }],
	steps: [
		{
			name: 'before',
			caption: 'Only text was delivered.',
			activeNodes: ['slack'],
			code: ['dispatch(signal)'],
			highlight: 0,
		},
		{
			name: 'after',
			caption: 'Images arrive as typed attachments.',
			activeNodes: ['agent'],
			code: ['dispatch(userMessage)'],
			highlight: 0,
			source: { path: 'src/channels/slack.ts', line: 399 },
		},
	] satisfies [Walkthrough['steps'][number], Walkthrough['steps'][number]],
} satisfies Walkthrough;

// R2's object boundary is in memory; the production publisher and routes are real.
export function memoryBucket(): ArtifactBucket {
	const objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();

	return {
		async put(key, bytes, { customMetadata }) {
			objects.set(key, { bytes: bytes.slice(), metadata: customMetadata });

			return { key };
		},
		async get(key) {
			const object = objects.get(key);

			if (!object) return null;

			return {
				arrayBuffer: async () => object.bytes.slice().buffer,
				customMetadata: object.metadata,
			};
		},
	};
}
