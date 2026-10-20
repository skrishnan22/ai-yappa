import { describe, expect, test } from 'vitest';
import {
	htmlKindPolicy,
	isAllowedRenderRequest,
	PREVIEW_MAX_SIDE,
	previewScale,
	renderErrorText,
} from './render.ts';

const origin = 'https://agent.example';

describe('isAllowedRenderRequest', () => {
	test.each([
		['GET', 'https://agent.example/render/mermaid.html'],
		['GET', 'https://agent.example/render/build/mermaid.js'],
		['GET', 'data:image/png;base64,AAAA'],
		['GET', 'blob:https://agent.example/1234'],
	])('allows %s %s', (method, url) => {
		expect(isAllowedRenderRequest({ method, url, origin })).toBe(true);
	});

	test.each([
		['POST', 'https://agent.example/render/mermaid.html'],
		['GET', 'https://agent.example/channels/slack/interactions'],
		['POST', 'https://agent.example/channels/slack/interactions'],
		['GET', 'https://agent.example/renderer/x.js'],
		['GET', 'https://evil.example/render/mermaid.html'],
		['GET', 'http://agent.example/render/mermaid.html'],
		['GET', 'not a url'],
	])('blocks %s %s', (method, url) => {
		expect(isAllowedRenderRequest({ method, url, origin })).toBe(false);
	});
});

test('the html kind policy allows no script and no connections', () => {
	const policy = htmlKindPolicy(origin);

	expect(policy).toContain("default-src 'none'");
	expect(policy).not.toContain('script-src');
	expect(policy).not.toContain('connect-src');
	expect(policy).toContain('https://agent.example/render/');
});

test('previews stay within the longest-side budget and never upscale', () => {
	expect(previewScale({ width: 300, height: 200 })).toBe(1);
	expect(previewScale({ width: 2000, height: 500 }) * 2000 * 2).toBeCloseTo(PREVIEW_MAX_SIDE);
	expect(previewScale({ width: 500, height: 3000 }) * 3000 * 2).toBeCloseTo(PREVIEW_MAX_SIDE);
});

test('render errors drop the evaluation prefix and page stack frames', () => {
	const message = [
		'Evaluation failed: Parse error on line 2:',
		'graph TD; A-->',
		"Expecting 'NODE_STRING', got 'EOF'",
		'Tt.parseError (https://agent.example/render/build/mermaid.js:968:33582)',
		'    at render (https://agent.example/render/build/mermaid.js:1:2)',
	].join('\n');

	expect(renderErrorText(message)).toBe(
		"Parse error on line 2:\ngraph TD; A-->\nExpecting 'NODE_STRING', got 'EOF'",
	);
});
