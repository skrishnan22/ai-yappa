import { describe, expect, test } from 'vitest';
import { createArtifactStore, type ArtifactBucket } from './artifact-store.ts';
import { RenderError } from './render.ts';
import { visualTools, type RenderVisual } from './visual-tools.ts';

const bucket: ArtifactBucket = {
	async put(key) {
		return { key };
	},
	async get() {
		return null;
	},
};

function tools({ render }: { render: RenderVisual }) {
	const [renderTool] = visualTools({
		conversationId: 'conv',
		render,
		artifacts: createArtifactStore(bucket),
		modelSeesImages: true,
	});

	if (!renderTool) throw new Error('expected render_visual');

	return { renderTool };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? '').join('\n');
}

describe('render_visual', () => {
	const input = { kind: 'mermaid', source: 'graph TD; A-->', title: 'Flow' };

	test('returns a render error unchanged so the model can fix its source', async () => {
		const { renderTool } = tools({
			render: () => Promise.reject(new RenderError('Parse error on line 1')),
		});

		await expect(renderTool.execute('call', input)).rejects.toThrow(/^Parse error on line 1$/);
	});

	test('turns a Browser Run failure into the Block Kit or text fallback', async () => {
		const { renderTool } = tools({ render: () => Promise.reject(new Error('429 Too Many')) });

		await expect(renderTool.execute('call', input)).rejects.toThrow(
			/unavailable right now \(429 Too Many\).*Block Kit.*code block/,
		);
	});

	test('returns the artifact id with a preview image', async () => {
		const { renderTool } = tools({
			render: async () => ({
				png: new Uint8Array([1]),
				preview: new Uint8Array([2]),
				width: 300,
				height: 200,
			}),
		});

		const result = await renderTool.execute('call', input);

		expect(text(result)).toMatch(/artifactId art_[0-9a-f]{20} \(300×200 px\)/);
		expect(result.content.at(-1)).toEqual({ type: 'image', data: 'Ag==', mimeType: 'image/jpeg' });
	});
});
