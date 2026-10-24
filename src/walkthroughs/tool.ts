import { Buffer } from 'node:buffer';
import { Type } from '@earendil-works/pi-ai';
import * as v from 'valibot';
import { canonicalRepo } from '../proxy/policy.ts';
import type { VisualTool } from '../visuals/visual-tools.ts';
import type { PublishWalkthrough } from './publish.ts';
import { walkthroughFieldsSchema } from './format.ts';

const toolInput = v.omit(walkthroughFieldsSchema, ['repository']);

export function walkthroughTool({
	conversationId,
	repo,
	publish,
	modelSeesImages,
}: {
	conversationId: string;
	repo: string;
	publish: PublishWalkthrough;
	modelSeesImages: boolean;
}): VisualTool {
	return {
		name: 'render_walkthrough',
		label: 'Render PR walkthrough',
		description: [
			'Generate and publish an animated Lantern explanation of your code change, using your existing implementation context. Call after checkpoint_working_branch, review the contact-sheet preview, then include the returned interactive URL in open_pull_request body.',
			'Use 1–4 short-labeled components and 1–6 named steps: previous behavior, the change, a concrete example, and relevant fallback behavior. Layout and timing are automatic; do not supply HTML, JavaScript, animation coordinates, or secrets.',
			'baseSha and headSha must be full lowercase 40-character commit SHAs from git. Source paths are relative to the attached repository and refer to headSha; highlight is a zero-based index into that step’s code lines. Label shortened code excerpts honestly in the caption.',
			'Example: nodes:[{id:"handler",label:"Handler"},{id:"db",label:"Database"}], edges:[{from:"handler",to:"db"}], steps:[{name:"before",caption:"Every request reads the database.",activeNodes:["db"],code:["return db.read(key)"],highlight:0,source:{path:"src/handler.ts",line:10}}].',
			'The URL and preview are unlisted public bearer links: anyone with the URL can view them, including code excerpts. Publishing happens immediately. Identical content in this conversation reuses its cached link and preview.',
		].join(' '),
		parameters: Type.Object({
			title: Type.String({ maxLength: 120 }),
			baseSha: Type.String(),
			headSha: Type.String(),
			nodes: Type.Array(Type.Object({ id: Type.String(), label: Type.String({ maxLength: 24 }) }), {
				minItems: 1,
				maxItems: 4,
			}),
			edges: Type.Array(Type.Object({ from: Type.String(), to: Type.String() }), { maxItems: 6 }),
			steps: Type.Array(
				Type.Object({
					name: Type.String(),
					caption: Type.String({ maxLength: 600 }),
					activeNodes: Type.Array(Type.String(), { maxItems: 4 }),
					code: Type.Array(Type.String({ maxLength: 100 }), { minItems: 1, maxItems: 8 }),
					highlight: Type.Optional(Type.Integer({ minimum: 0 })),
					source: Type.Optional(
						Type.Object({ path: Type.String(), line: Type.Integer({ minimum: 1 }) }),
					),
				}),
				{ minItems: 1, maxItems: 6 },
			),
		}),
		async execute(_toolCallId, params) {
			const input = v.parse(toolInput, params);

			const result = await publish({
				conversationId,
				input: { ...input, repository: canonicalRepo(repo) },
			});

			const content: Awaited<ReturnType<VisualTool['execute']>>['content'] = [
				{
					type: 'text',
					text: [
						`Published walkthrough: ${result.url}`,
						`Contact sheet: ${result.previewUrl} (${result.width}×${result.height} px). Cache: ${result.cached ? 'hit; no browser session' : 'miss'}.`,
						modelSeesImages
							? 'Review every step in the preview for accuracy, clipping and readability. Revise and render again if needed.'
							: 'This model cannot view images. Do not claim to have visually reviewed the walkthrough.',
						'Include the interactive URL in the PR body. This is an authored explanation, not proof of execution.',
					].join('\n'),
				},
			];

			if (modelSeesImages)
				content.push({
					type: 'image',
					data: Buffer.from(result.preview).toString('base64'),
					mimeType: 'image/jpeg',
				});

			return {
				content,
				details: { url: result.url, previewUrl: result.previewUrl, cached: result.cached },
			};
		},
	};
}
