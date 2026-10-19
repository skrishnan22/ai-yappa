/**
 * Renders model-written diagram source to PNG in Cloudflare Browser Run
 * (ADR 0025, decisions 1, 2, and 5).
 *
 * Every render launches its own Chromium over the `browser` binding and
 * closes it in `finally`, so nothing stays open between renders. The page
 * loads an application-owned template from this Worker's `/render/` assets;
 * owner code then hands the source to the template's `renderVisual` as a
 * `page.evaluate` argument. The rendered page reaches nothing but `/render/`.
 */
import { launch, type BrowserWorker, type HTTPRequest, type Page } from '@cloudflare/puppeteer';

export const VISUAL_KINDS = ['mermaid', 'vega-lite', 'echarts', 'html'] as const;

export type VisualKind = (typeof VISUAL_KINDS)[number];

/** A render failure the model can fix by changing its source. */
export class RenderError extends Error {
	override name = 'RenderError';
}

export type VisualSize = { width: number; height: number };

export type RenderedVisual = {
	png: Uint8Array;
	/** Downscaled JPEG the model reviews; the PNG is what Slack gets. */
	preview: Uint8Array;
	width: number;
	height: number;
};

const VIEWPORT_WIDTH = 1280;

const DEVICE_SCALE_FACTOR = 2;

// Longest side of a rendered visual in CSS pixels. Larger drawings are
// unreadable in Slack anyway; the model should split them.
export const MAX_VISUAL_SIDE = 4000;

// Application budget for each PNG delivered to Slack (decision 7).
export const MAX_PNG_BYTES = 10 * 1024 * 1024;

// Decision 2's image budget for what the model sees.
export const PREVIEW_MAX_SIDE = 1568;

export const PREVIEW_MAX_BYTES = 300 * 1024;

const PREVIEW_QUALITIES = [80, 60, 40];

const LOAD_TIMEOUT_MS = 15_000;

const RENDER_TIMEOUT_MS = 20_000;

const MAX_ERROR_LENGTH = 2_000;

/**
 * The only requests a render page may make: `GET` under this origin's
 * `/render/`, plus `data:` and `blob:` URLs. Model-written HTML runs on the
 * Worker's origin, so the whole origin would expose routes like
 * `/channels/slack/interactions`.
 */
export function isAllowedRenderRequest({
	method,
	url,
	origin,
}: {
	method: string;
	url: string;
	origin: string;
}): boolean {
	if (url.startsWith('data:') || url.startsWith('blob:')) return true;

	if (method !== 'GET') return false;

	try {
		const target = new URL(url);

		return target.origin === new URL(origin).origin && target.pathname.startsWith('/render/');
	} catch {
		return false;
	}
}

/** The CSP for the `html` kind, which owner code serves itself: no script at all. */
export function htmlKindPolicy(origin: string): string {
	const assets = `${new URL(origin).origin}/render/`;

	return [
		"default-src 'none'",
		`style-src 'unsafe-inline' ${assets}`,
		`img-src data: ${assets}`,
		`font-src data: ${assets}`,
		"base-uri 'none'",
		"form-action 'none'",
	].join('; ');
}

/** Scale that brings a `width`×`height` CSS-pixel clip within the preview side. */
export function previewScale({ width, height }: { width: number; height: number }): number {
	return Math.min(1, PREVIEW_MAX_SIDE / (Math.max(width, height) * DEVICE_SCALE_FACTOR));
}

export async function renderVisual({
	browser: binding,
	origin,
	kind,
	source,
}: {
	browser: BrowserWorker;
	origin: string;
	kind: VisualKind;
	source: string;
}): Promise<RenderedVisual> {
	const base = new URL(origin);
	const templateUrl = new URL(`/render/${kind}.html`, base).href;

	const browser = await launch(binding, {
		// Network-level backstop to request interception.
		guardrails: { allowedDomains: [base.hostname] },
	});

	try {
		const page = await browser.newPage();
		await page.setViewport({
			width: VIEWPORT_WIDTH,
			// `html` screenshots the full page, so a short viewport avoids padding.
			height: kind === 'html' ? 100 : 800,
			deviceScaleFactor: DEVICE_SCALE_FACTOR,
		});

		// The `html` kind exists for CSS layout; charts come from the chart kinds.
		if (kind === 'html') await page.setJavaScriptEnabled(false);

		await page.setRequestInterception(true);
		page.on('request', (request) => {
			void routeRequest({ request, kind, source, templateUrl, origin: base.origin });
		});

		await withTimeout(
			page.goto(templateUrl, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS }),
			LOAD_TIMEOUT_MS,
			'The render template did not load.',
		);

		if (kind === 'html') return await captureFullPage(page);

		return await captureTemplate(page, source);
	} finally {
		await browser.close();
	}
}

async function routeRequest({
	request,
	kind,
	source,
	templateUrl,
	origin,
}: {
	request: HTTPRequest;
	kind: VisualKind;
	source: string;
	templateUrl: string;
	origin: string;
}): Promise<void> {
	if (request.isInterceptResolutionHandled()) return;

	// The `html` kind's page is the model's HTML, served by owner code with a
	// script-free CSP. It is never fetched, so `/render/html.html` holds nothing.
	if (kind === 'html' && request.url() === templateUrl && request.method() === 'GET') {
		await request.respond({
			status: 200,
			contentType: 'text/html; charset=utf-8',
			headers: { 'Content-Security-Policy': htmlKindPolicy(origin) },
			body: source,
		});

		return;
	}

	if (isAllowedRenderRequest({ method: request.method(), url: request.url(), origin })) {
		await request.continue();

		return;
	}

	await request.abort('blockedbyclient');
}

async function captureTemplate(page: Page, source: string): Promise<RenderedVisual> {
	try {
		await withTimeout(
			page.evaluate((text) => {
				if (!globalThis.renderVisual) throw new Error('The render template did not load.');

				return globalThis.renderVisual(text);
			}, source),
			RENDER_TIMEOUT_MS,
			'Rendering took too long. Simplify the source.',
		);
	} catch (error) {
		if (error instanceof RenderError) throw error;

		throw new RenderError(renderErrorText(error instanceof Error ? error.message : String(error)), {
			cause: error,
		});
	}

	const element = await page.$('#visual');
	const box = await element?.boundingBox();

	if (!box || box.width < 1 || box.height < 1) {
		throw new RenderError('The source rendered nothing.');
	}

	const clip = {
		x: Math.floor(box.x),
		y: Math.floor(box.y),
		width: Math.ceil(box.width),
		height: Math.ceil(box.height),
	};

	return capture(page, clip);
}

async function captureFullPage(page: Page): Promise<RenderedVisual> {
	const png = await page.screenshot({ type: 'png', fullPage: true });
	const size = pngSize(png);

	const clip = {
		x: 0,
		y: 0,
		width: Math.round(size.width / DEVICE_SCALE_FACTOR),
		height: Math.round(size.height / DEVICE_SCALE_FACTOR),
	};

	return capture(page, clip, new Uint8Array(png));
}

async function capture(
	page: Page,
	clip: { x: number; y: number; width: number; height: number },
	png?: Uint8Array,
): Promise<RenderedVisual> {
	if (Math.max(clip.width, clip.height) > MAX_VISUAL_SIDE) {
		throw new RenderError(
			`The visual is ${clip.width}×${clip.height} px; the limit is ${MAX_VISUAL_SIDE} px on each side. Simplify it or split it into several visuals.`,
		);
	}

	if (!png) {
		const shot = await page.screenshot({ type: 'png', clip, captureBeyondViewport: true });
		png = new Uint8Array(shot);
	}

	if (png.byteLength > MAX_PNG_BYTES) {
		throw new RenderError('The rendered image is over 10 MiB. Simplify it or split it.');
	}

	const scale = previewScale(clip);
	let preview: Uint8Array | undefined;

	for (const quality of PREVIEW_QUALITIES) {
		const jpeg = await page.screenshot({
			type: 'jpeg',
			quality,
			clip: { ...clip, scale },
			captureBeyondViewport: true,
		});

		preview = new Uint8Array(jpeg);

		if (preview.byteLength <= PREVIEW_MAX_BYTES) break;
	}

	if (!preview) throw new Error('[visuals] no preview quality configured');

	return { png, preview, width: clip.width, height: clip.height };
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Uint8Array): VisualSize {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);

	return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The page's error for the model: no `Evaluation failed:` prefix or stack frames. */
export function renderErrorText(message: string): string {
	return message
		.replace(/^Evaluation failed: /, '')
		.split('\n')
		.filter((line) => !/^\s*at\s/.test(line) && !/\(https?:\/\/[^)]*:\d+:\d+\)\s*$/.test(line))
		.join('\n')
		.trim()
		.slice(0, MAX_ERROR_LENGTH);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new RenderError(message)), ms);
	});

	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Defined by every chart template (render/visual.ts); runs in the page.
declare global {
	var renderVisual: ((source: string) => Promise<void>) | undefined;
}
