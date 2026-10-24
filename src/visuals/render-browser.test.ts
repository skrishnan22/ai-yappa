import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve as resolvePath } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PuppeteerNode } from '@cloudflare/puppeteer/internal/node/PuppeteerNode.js';
import { Page } from '@cloudflare/puppeteer/internal/api/Page.js';
import * as v from 'valibot';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { pageScreenshot } from './browse.ts';
import { MAX_PNG_BYTES, PREVIEW_MAX_BYTES, renderVisual } from './render.ts';
import { walkthroughExample } from '../testing/walkthrough.ts';
import { memoryBucket } from '../testing/walkthrough.ts';
import { walkthroughRoutes } from '../walkthroughs/routes.ts';
import { launch } from '@cloudflare/puppeteer';

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

const walkthroughId = '1'.repeat(32);

const walkthroughBucket = memoryBucket();

const walkthroughApp = walkthroughRoutes();

beforeAll(async () => {
	await promisify(execFile)('pnpm', ['run', 'build:render']);
	await walkthroughBucket.put(
		`walkthroughs/${walkthroughId}.json`,
		new TextEncoder().encode(JSON.stringify(walkthroughExample)),
		{ httpMetadata: { contentType: 'application/json' }, customMetadata: {} },
	);
	const headers = await readFile('public/_headers', 'utf8');

	const policy = headers
		.split('\n')
		.find((line) => line.trim().startsWith('Content-Security-Policy:'));

	if (!policy) throw new Error('Missing render asset CSP');
	server = createServer(async (request, response) => {
		const path = new URL(request.url ?? '/', 'http://localhost').pathname;

		if (path.startsWith('/walkthroughs/')) {
			const served = await walkthroughApp.request(
				(request.url ?? '/').replace('/walkthroughs', ''),
				{},
				{ ARTIFACTS: walkthroughBucket },
			);

			response.writeHead(served.status, Object.fromEntries(served.headers));
			const body = await served.text();
			response.end(body);

			return;
		}

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

test('renders every walkthrough step in one navigation and records the browser duration', async () => {
	const goto = vi.spyOn(Page.prototype, 'goto');
	const log = vi.spyOn(console, 'info');

	const input = {
		...walkthroughExample,
		nodes: [
			...walkthroughExample.nodes,
			{ id: 'cache', label: 'Cache' },
			{ id: 'database', label: 'Database' },
		],
		steps: Array.from({ length: 4 }, (_, index) => ({
			...walkthroughExample.steps[0],
			name: `step-${index}`,
		})),
	};

	const result = await render('walkthrough', JSON.stringify(input));
	expect(goto).toHaveBeenCalledOnce();
	expect(result.height).toBeGreaterThan(900);
	expect(pngSize(result.png)).toEqual({ width: result.width * 2, height: result.height * 2 });
	expect(result.preview.byteLength).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
	expect(log).toHaveBeenCalledWith(
		expect.objectContaining({
			event: 'visual_browser_session',
			kind: 'walkthrough',
			outcome: 'success',
			durationMs: expect.any(Number),
		}),
	);
}, 30_000);

test('captures a page PNG and JPEG preview after one navigation', async () => {
	const goto = vi.spyOn(Page.prototype, 'goto');

	const shot = await pageScreenshot(
		{
			fetch,
			quickAction: async () => {
				throw new Error('Unexpected Quick Action');
			},
		},
		`${origin}/render/html.html`,
	);

	expect(goto).toHaveBeenCalledOnce();
	expect(pngSize(shot.png)).toEqual({ width: 1280, height: 800 });
	expect(shot.preview.subarray(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]));
}, 30_000);

test('the published player honors step links, updates source links and supports play/pause', async () => {
	const browser = await launch({ fetch });

	try {
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.goto(`${origin}/walkthroughs/${walkthroughId}?step=after`, { waitUntil: 'load' });
		await page.waitForSelector('.stage svg', { timeout: 5000 });
		const initialCaption = await page.$eval('.caption', (node) => node.textContent);
		expect(initialCaption).toBe('Images arrive as typed attachments.');
		const initialSource = await page.$eval('.source', (node) => node.getAttribute('href'));
		expect(initialSource).toContain(
			`/blob/${walkthroughExample.headSha}/src/channels/slack.ts#L399`,
		);
		await page.click('.steps button:first-child');
		await page.waitForSelector('.steps button[aria-current="step"]:first-child', { timeout: 5000 });
		expect(new URL(page.url()).search).toBe('?step=before');
		const previousCaption = await page.$eval('.caption', (node) => node.textContent);
		expect(previousCaption).toBe('Only text was delivered.');
		await page.click('.controls button:nth-child(2)');
		await page.waitForSelector('text/Pause', { timeout: 5000 });
		await page.click('.controls button:nth-child(2)');

		const pausedLabel = await page.$eval(
			'.controls button:nth-child(2)',
			(node) => node.textContent,
		);

		expect(pausedLabel).toBe('Play');
		expect(errors).toEqual([]);
	} finally {
		await browser.close();
	}
}, 30_000);
