import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import app from './app.ts';

const executionContext = {
	waitUntil(_promise: Promise<unknown>) {},
	passThroughOnException() {},
	props: {},
};

const body = JSON.stringify({ type: 'url_verification', challenge: 'test-challenge' });

function env(signingSecret: string) {
	return {
		SLACK_SIGNING_SECRET: signingSecret,
		SLACK_BOT_TOKEN: 'xoxb-test',
		DAYTONA_API_KEY: 'dtn-test',
		OPENCODE_API_KEY: 'sk-test',
	};
}

function signedRequest(secret: string, timestamp: string): Request {
	const base = `v0:${timestamp}:${body}`;
	const signature = `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;

	return new Request('https://example.test/channels/slack/events', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-slack-request-timestamp': timestamp,
			'x-slack-signature': signature,
		},
		body,
	});
}

describe('Slack HTTP boundary', () => {
	test('validates bindings and uses the current signing secret per request', async () => {
		const timestamp = Math.floor(Date.now() / 1000).toString();

		const first = await app.fetch(
			signedRequest('first-secret', timestamp),
			env('first-secret'),
			executionContext,
		);

		expect(first.status).toBe(200);

		const second = await app.fetch(
			signedRequest('second-secret', timestamp),
			env('second-secret'),
			executionContext,
		);

		expect(second.status).toBe(200);

		const oldSignature = await app.fetch(
			signedRequest('first-secret', timestamp),
			env('second-secret'),
			executionContext,
		);

		expect(oldSignature.status).toBe(401);
	});
});
