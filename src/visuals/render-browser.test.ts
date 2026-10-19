import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve as resolvePath } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PuppeteerNode } from '@cloudflare/puppeteer/internal/node/PuppeteerNode.js';
import { Page } from '@cloudflare/puppeteer/internal/api/Page.js';
import * as v from 'valibot';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { MAX_PNG_BYTES, PREVIEW_MAX_BYTES, renderVisual } from './render.ts';

// Only the Cloudflare launch transport is replaced; rendering uses real Chromium.
// oxlint-disable-next-line anti-slop/no-module-mocking -- Browser Run's external launch transport is unavailable in local Chromium.
vi.mock('@cloudflare/puppeteer', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@cloudflare/puppeteer')>();

	return {
		...actual,
		launch: () =>
			new PuppeteerNode({ isPuppeteerCore: true }).launch({
				channel: 'chrome',
				headless: true,
				args: ['--no-sandbox'],
			}),
	};
});

let server: Server;

let origin: string;

beforeAll(async () => {
	await promisify(execFile)('pnpm', ['run', 'build:render']);
	const headers = await readFile('public/_headers', 'utf8');

	const policy = headers
		.split('\n')
		.find((line) => line.trim().startsWith('Content-Security-Policy:'));

	if (!policy) throw new Error('Missing render asset CSP');
	server = createServer(async (request, response) => {
		const path = new URL(request.url ?? '/', 'http://localhost').pathname;

		if (!path.startsWith('/render/')) {
			response.writeHead(404).end();

			return;
		}

		try {
			const content = await readFile(resolvePath('public', `.${path}`));

			const types = new Map([
				['.html', 'text/html'],
				['.js', 'text/javascript'],
				['.css', 'text/css'],
			]);

			response.writeHead(200, {
				'Content-Type': types.get(extname(path)) ?? 'application/octet-stream',
				'Content-Security-Policy': policy.trim().slice('Content-Security-Policy:'.length).trim(),
				'X-Content-Type-Options': 'nosniff',
			});
			response.end(content);
		} catch {
			response.writeHead(404).end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = v.parse(v.object({ port: v.number() }), server.address());
	origin = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
	if (server)
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
});

function render(kind: Parameters<typeof renderVisual>[0]['kind'], source: string) {
	return renderVisual({ browser: { fetch }, origin, kind, source });
}

const inlineChart = {
	data: { values: [{ url: '/docs', count: 3 }] },
	mark: 'bar',
	encoding: { x: { field: 'url', type: 'nominal' }, y: { field: 'count', type: 'quantitative' } },
};

test.each([
	['mermaid', 'flowchart LR; Slack --> Coworker'],
	['vega-lite', JSON.stringify(inlineChart)],
	[
		'echarts',
		JSON.stringify({ xAxis: { data: ['A'] }, yAxis: {}, series: [{ type: 'bar', data: [3] }] }),
	],
	['html', '<html><body><h1>Healthy</h1><p>All services ready</p></body></html>'],
] as const)(
	'renders %s with built assets and deployed CSP',
	async (kind, source) => {
		const result = await render(kind, source);
		expect(result.width).toBeGreaterThan(1);
		expect(result.height).toBeGreaterThan(1);
		expect(pngSize(result.png)).toEqual({ width: result.width * 2, height: result.height * 2 });
		expect(result.png.byteLength).toBeGreaterThan(100);
		expect(result.png.byteLength).toBeLessThanOrEqual(MAX_PNG_BYTES);
		expect(result.preview.subarray(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]));
		expect(result.preview.byteLength).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
	},
	30_000,
);

test('rejects remote Vega data while allowing inline url fields', async () => {
	const source = JSON.stringify({ ...inlineChart, data: { url: 'https://example.com/data.json' } });
	await expect(render('vega-lite', source)).rejects.toThrow('Data must be inline');
}, 30_000);

test('rejects oversized HTML before any screenshot', async () => {
	const screenshot = vi.spyOn(Page.prototype, 'screenshot');
	await expect(render('html', '<div style="height:100000px">Too tall</div>')).rejects.toThrow(
		'limit is 4000',
	);
	expect(screenshot).not.toHaveBeenCalled();
}, 30_000);

test('rejects previews that exceed the byte budget at every quality', async () => {
	vi.spyOn(Page.prototype, 'screenshot').mockResolvedValue(Buffer.alloc(PREVIEW_MAX_BYTES + 1));
	await expect(render('mermaid', 'flowchart LR; A --> B')).rejects.toThrow('preview');
}, 30_000);

function pngSize(png: Uint8Array) {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);

	return { width: view.getUint32(16), height: view.getUint32(20) };
}
