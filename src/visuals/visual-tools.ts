/**
 * `render_visual` (ADR 0025, decision 2).
 *
 * Visual tools are pi `AgentTool`s, mounted through the sandbox factory's `tools`
 * list (src/sandboxes/coworker-sandbox.ts) because that is the only Flue
 * path whose tool results keep image blocks for the model; `defineTool`
 * output becomes JSON text. They ignore the sandbox: `execute` runs in the
 * Coworker Durable Object and reaches Browser Run and R2 through closures.
 * Move them to `useTool` once `defineTool` can return image content.
 */
import { Type } from '@earendil-works/pi-ai';
import type { SandboxToolFactory } from '@flue/runtime';
import * as v from 'valibot';
import type { ArtifactStore } from './artifact-store.ts';
import { RenderError, VISUAL_KINDS, type RenderedVisual, type VisualKind } from './render.ts';

export type VisualTool = ReturnType<SandboxToolFactory>[number];

type ToolResult = Awaited<ReturnType<VisualTool['execute']>>;

type Content = ToolResult['content'][number];

export const MAX_SOURCE_LENGTH = 200_000;

export const MAX_TITLE_LENGTH = 200;

const renderInput = v.object({
	kind: v.picklist(VISUAL_KINDS),
	source: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SOURCE_LENGTH)),
	title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_TITLE_LENGTH)),
});

export type RenderVisual = (input: { kind: VisualKind; source: string }) => Promise<RenderedVisual>;

export function visualTools({
	conversationId,
	render,
	artifacts,
	modelSeesImages,
}: {
	conversationId: string;
	render: RenderVisual;
	artifacts: ArtifactStore;
	/** False when the conversation's model does not accept image input. */
	modelSeesImages: boolean;
}): VisualTool[] {
	const reviewNote = modelSeesImages
		? 'The attached preview is downscaled; check it for overlapping or clipped labels and unreadable text, and render again with corrected source if needed.'
		: 'This conversation’s model cannot view images, so no preview is attached; describe only what the source specifies.';

	function withPreview(text: string, preview: Uint8Array): Content[] {
		const content: Content[] = [{ type: 'text', text }];

		if (modelSeesImages) {
			content.push({ type: 'image', data: base64(preview), mimeType: 'image/jpeg' });
		}

		return content;
	}

	const renderTool: VisualTool = {
		name: 'render_visual',
		label: 'Render visual',
		description: [
			'Render a diagram, chart, or layout to an image the user can see in Slack. Prefer a native Block Kit data_visualization or data_table in reply_in_slack_thread when one fits; use this for architecture, sequence, flow, and state diagrams, charts Block Kit cannot draw, and dashboards.',
			'kind: `mermaid` (Mermaid source; the default for diagrams), `vega-lite` (a Vega-Lite JSON spec with inline `values` data), `echarts` (an ECharts option object as JSON, no functions), or `html` (a full HTML document for dashboards, report layouts, and explainer cards; CSS only, JavaScript is disabled).',
			'Nothing can be fetched while rendering: use inline data, no external URLs, fonts, or images.',
			'Returns an artifactId and a preview image for you to review. Nothing is posted until you pass the artifactId in reply_in_slack_thread `images`.',
			'A render error (for example a Mermaid parse error) comes back as an error: fix the source and call again.',
		].join(' '),
		parameters: Type.Object({
			kind: Type.Union(VISUAL_KINDS.map((kind) => Type.Literal(kind))),
			source: Type.String({ description: 'Diagram source, spec JSON, or HTML.' }),
			title: Type.String({ description: 'Short title, used as the Slack file title.' }),
		}),
		async execute(_toolCallId, params) {
			const input = v.parse(renderInput, params);
			const rendered = await renderOrExplain(render, { kind: input.kind, source: input.source });

			const artifactId = await artifacts.put({
				conversationId,
				png: rendered.png,
				title: input.title,
			});

			return {
				content: withPreview(
					[
						`Rendered ${input.kind} "${input.title}" as artifactId ${artifactId} (${rendered.width}×${rendered.height} px).`,
						reviewNote,
						`To post it, call reply_in_slack_thread with images: [{ "artifactId": "${artifactId}", "altText": "…" }].`,
					].join(' '),
					rendered.preview,
				),
				details: { artifactId, width: rendered.width, height: rendered.height },
			};
		},
	};

	return [renderTool];
}

/**
 * A render error is the model's to fix. Anything else means Browser Run
 * itself failed, and the reply falls back to Block Kit or text (decision 8).
 */
async function renderOrExplain(
	render: RenderVisual,
	input: { kind: VisualKind; source: string },
): Promise<RenderedVisual> {
	try {
		return await render(input);
	} catch (error) {
		if (error instanceof RenderError) throw error;

		const reason = error instanceof Error ? error.message : String(error);

		throw new Error(
			`Rendering is unavailable right now (${reason}). Reply with a native Block Kit chart or table, or with text plus the diagram source in a code block.`,
			{ cause: error },
		);
	}
}

function base64(bytes: Uint8Array): string {
	let binary = '';

	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}

	return btoa(binary);
}
