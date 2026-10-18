/**
 * Read-only browsing through Browser Run Quick Actions on Chromium
 * (ADR 0025, decision 9). Quick Actions bill browser time only; each call
 * opens a fresh browser with no cookies or credentials.
 */
import * as v from 'valibot';
import { type JsonValue, jsonValueSchema } from '../json.ts';

// The Quick Action subset of the `browser` binding this module uses.
export type QuickActions = {
	quickAction(
		action: 'markdown' | 'accessibilityTree' | 'screenshot',
		options: QuickActionOptions,
	): Promise<Response>;
};

type QuickActionOptions = {
	url: string;
	gotoOptions?: { timeout?: number; waitUntil?: 'load' | 'networkidle2' };
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	screenshotOptions?: { type?: 'png' | 'jpeg'; quality?: number };
};

export const BROWSE_MODES = ['markdown', 'snapshot', 'screenshot'] as const;

export type BrowseMode = (typeof BROWSE_MODES)[number];

/** Most text a browse result hands the model. */
export const MAX_BROWSE_TEXT = 60_000;

const GOTO = { timeout: 20_000, waitUntil: 'networkidle2' } as const;

// 1280 wide fits the model's preview budget (longest side 1568) at scale 1.
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };

const PREVIEW_QUALITY = 60;

const metaSchema = v.object({
	title: v.optional(v.string()),
	finalUrl: v.optional(v.string()),
	status: v.optional(v.number()),
});

const errorSchema = v.object({
	errors: v.array(v.object({ message: v.string() })),
});

type AccessibilityNode = {
	role: string;
	name?: string;
	value?: string | number;
	children?: AccessibilityNode[];
};

const accessibilityNodeSchema: v.GenericSchema<AccessibilityNode> = v.object({
	role: v.string(),
	name: v.optional(v.string()),
	value: v.optional(v.union([v.string(), v.number()])),
	children: v.optional(v.array(v.lazy(() => accessibilityNodeSchema))),
});

export type PageText = { url: string; title: string; text: string };

export type PageScreenshot = { url: string; png: Uint8Array; preview: Uint8Array };

export async function pageMarkdown(browser: QuickActions, url: string): Promise<PageText> {
	const body = await quickJson(browser, 'markdown', { url, gotoOptions: GOTO });
	const parsed = v.parse(v.object({ result: v.string(), meta: v.optional(metaSchema) }), body);

	return {
		url: parsed.meta?.finalUrl ?? url,
		title: parsed.meta?.title ?? '',
		text: truncate(parsed.result),
	};
}

export async function pageSnapshot(browser: QuickActions, url: string): Promise<PageText> {
	const body = await quickJson(browser, 'accessibilityTree', { url, gotoOptions: GOTO });

	const parsed = v.parse(
		v.object({
			result: v.object({ accessibilityTree: v.nullable(accessibilityNodeSchema) }),
			meta: v.optional(metaSchema),
		}),
		body,
	);

	const tree = parsed.result.accessibilityTree;

	return {
		url: parsed.meta?.finalUrl ?? url,
		title: parsed.meta?.title ?? '',
		text: tree ? truncate(accessibilityText(tree)) : '(empty accessibility tree)',
	};
}

export async function pageScreenshot(browser: QuickActions, url: string): Promise<PageScreenshot> {
	const [png, preview] = await Promise.all([
		quickBytes(browser, { url, gotoOptions: GOTO, viewport: VIEWPORT }),
		quickBytes(browser, {
			url,
			gotoOptions: GOTO,
			viewport: VIEWPORT,
			screenshotOptions: { type: 'jpeg', quality: PREVIEW_QUALITY },
		}),
	]);

	return { url, png, preview };
}

/** One line per node: `role "name"`, indented by depth. */
export function accessibilityText(node: AccessibilityNode, depth = 0): string {
	const label = [node.role, node.name ? JSON.stringify(node.name) : '', valueText(node.value)]
		.filter(Boolean)
		.join(' ');

	const lines = [`${'  '.repeat(depth)}${label}`];

	for (const child of node.children ?? []) lines.push(accessibilityText(child, depth + 1));

	return lines.join('\n');
}

function valueText(value: string | number | undefined): string {
	return value === undefined || value === '' ? '' : `= ${JSON.stringify(value)}`;
}

function truncate(text: string): string {
	return text.length > MAX_BROWSE_TEXT
		? `${text.slice(0, MAX_BROWSE_TEXT)}\n\n[truncated at ${MAX_BROWSE_TEXT} characters]`
		: text;
}

async function quickJson(
	browser: QuickActions,
	action: 'markdown' | 'accessibilityTree',
	options: QuickActionOptions,
): Promise<JsonValue> {
	const response = await browser.quickAction(action, options);

	if (!response.ok) {
		const message = await failureMessage(response);

		throw new Error(message);
	}

	const body = await response.json();

	return v.parse(jsonValueSchema, body);
}

async function quickBytes(browser: QuickActions, options: QuickActionOptions): Promise<Uint8Array> {
	const response = await browser.quickAction('screenshot', options);

	if (!response.ok) {
		const message = await failureMessage(response);

		throw new Error(message);
	}

	const bytes = await response.arrayBuffer();

	return new Uint8Array(bytes);
}

async function failureMessage(response: Response): Promise<string> {
	const text = await response.text();

	try {
		const parsed = v.safeParse(errorSchema, JSON.parse(text));

		if (parsed.success && parsed.output.errors.length > 0) {
			return `Browser Run failed (HTTP ${response.status}): ${parsed.output.errors.map((error) => error.message).join('; ')}`;
		}
	} catch {
		// Not JSON; fall through to the status line.
	}

	return `Browser Run failed (HTTP ${response.status}).`;
}
