import { expect, test } from 'vitest';
import { memoryBucket, walkthroughExample } from '../testing/walkthrough.ts';
import { createWalkthroughPublisher } from './publish.ts';
import { walkthroughTool } from './tool.ts';

test.each([true, false])(
	'returns a published PR link and gates image previews by model capability (%s)',
	async (modelSeesImages) => {
		const publish = createWalkthroughPublisher({
			bucket: memoryBucket(),
			origin: 'https://agent.example',
			render: async () => ({
				png: new Uint8Array([1]),
				preview: new Uint8Array([2]),
				width: 1280,
				height: 900,
			}),
		});

		const tool = walkthroughTool({
			conversationId: 'one',
			repo: 'https://github.com/skrishnan22/ai-yappa.git',
			publish,
			modelSeesImages,
		});

		const { repository: _repository, ...input } = walkthroughExample;
		const result = await tool.execute('call', input);
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('https://agent.example/walkthroughs/'),
		});
		expect(result.content.some((content) => content.type === 'image')).toBe(modelSeesImages);
		expect(result.content.filter((content) => content.type === 'image')).toEqual(
			modelSeesImages ? [{ type: 'image', data: 'Ag==', mimeType: 'image/jpeg' }] : [],
		);
	},
);
