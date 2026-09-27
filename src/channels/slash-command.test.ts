import type { SlackSlashCommandPayload } from '@flue/slack';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { codexAdminIds } from '../config.ts';
import { type CodexAuthControl, CodexAuthService } from '../integrations/codex-auth/codex-auth.ts';
import { memoryStorage } from '../integrations/codex-auth/memory-storage.ts';
import { handleSlashCommand } from './slash-command.ts';

const ADMIN = 'U_TEST_CODEX_ADMIN';

const STRANGER = 'U_TEST_STRANGER';

const USER_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';

const REVOKE_URL = 'https://auth.openai.com/oauth/revoke';

const RESPONSE_URL = 'https://hooks.slack.com/commands/T1/1/abc';

const credentialKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

function command(
	text: string,
	userId: string,
	responseUrl = RESPONSE_URL,
): SlackSlashCommandPayload {
	return {
		command: '/aiyappa',
		text,
		response_url: responseUrl,
		trigger_id: 'trigger-1',
		user_id: userId,
		team_id: 'T1',
		channel_id: 'C1',
		api_app_id: 'A1',
	};
}

// Replaces the network only; `CodexAuthService` runs for real.
function stubFetch(routes: Map<string, () => Response>): string[] {
	const urls: string[] = [];

	vi.stubGlobal('fetch', async (input: string | URL) => {
		const url = String(input);
		const respond = routes.get(url);

		urls.push(url);

		if (respond === undefined) throw new Error(`Unexpected request to ${url}`);

		return respond();
	});

	return urls;
}

function userCodeResponse(): Response {
	return Response.json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 5 });
}

beforeEach(() => {
	codexAdminIds.add(ADMIN);
});

afterEach(() => {
	codexAdminIds.delete(ADMIN);
	vi.unstubAllGlobals();
});

describe('/aiyappa openai', () => {
	test('shows usage for anything but openai connect|status|disconnect or models', async () => {
		const service = new CodexAuthService(memoryStorage(), credentialKey);

		for (const text of [
			'',
			'openai',
			'openai login',
			'anthropic status',
			'openai status now',
			'models all',
		]) {
			await expect(handleSlashCommand(command(text, ADMIN), () => service)).resolves.toEqual({
				response_type: 'ephemeral',
				text: 'Usage: `/aiyappa openai connect|status|disconnect` or `/aiyappa models`',
			});
		}
	});

	test('refuses connect, disconnect, and status to users on neither list without asking CodexAuth', async () => {
		const reach = vi.fn<() => CodexAuthControl>(
			() => new CodexAuthService(memoryStorage(), credentialKey),
		);

		for (const action of ['connect', 'disconnect']) {
			const reply = await handleSlashCommand(command(`openai ${action}`, STRANGER), reach);

			expect(reply.text).toContain('Only Codex admins');
		}

		const status = await handleSlashCommand(command('openai status', STRANGER), reach);

		expect(status.text).toContain('not on the invoker allowlist');
		expect(reach).not.toHaveBeenCalled();
	});

	test('connect replies ephemerally with the device code, and status never shows it', async () => {
		stubFetch(new Map([[USER_CODE_URL, userCodeResponse]]));
		const storage = memoryStorage();
		const service = new CodexAuthService(storage, credentialKey);

		const reply = await handleSlashCommand(command('openai connect', ADMIN), () => service);

		expect(reply.response_type).toBe('ephemeral');
		expect(reply.text).toContain('`ABCD-EFGH`');
		expect(reply.text).toContain('https://auth.openai.com/codex/device');
		expect(storage.pendingLogin.get()?.responseUrl).toBe(RESPONSE_URL);

		const status = await handleSlashCommand(command('openai status', ADMIN), () => service);

		expect(status.text).toContain('waiting for approval');
		expect(status.text).not.toContain('ABCD-EFGH');
	});

	test('connect refuses a response URL outside Slack', async () => {
		const urls = stubFetch(new Map([[USER_CODE_URL, userCodeResponse]]));
		const service = new CodexAuthService(memoryStorage(), credentialKey);

		const reply = await handleSlashCommand(
			command('openai connect', ADMIN, 'https://attacker.example/hook'),
			() => service,
		);

		expect(reply.text).toContain('no usable response URL');
		expect(urls).toHaveLength(0);
	});

	test('reports a failed connect instead of throwing', async () => {
		stubFetch(new Map([[USER_CODE_URL, () => new Response(null, { status: 404 })]]));
		const service = new CodexAuthService(memoryStorage(), credentialKey);

		const reply = await handleSlashCommand(command('openai connect', ADMIN), () => service);

		expect(reply.text).toMatch(/^ChatGPT connect failed: .*not enabled device code login/);
	});

	test('status and disconnect describe the connection and the fallback route', async () => {
		stubFetch(new Map([[REVOKE_URL, () => new Response(null, { status: 200 })]]));
		const service = new CodexAuthService(memoryStorage(), credentialKey);

		await service.seed({
			access: 'access-1',
			refresh: 'refresh-1',
			expires: Date.now() + 60 * 60 * 1000,
			accountId: 'account-1',
		});

		const status = await handleSlashCommand(command('openai status', ADMIN), () => service);

		expect(status.text).toContain('connected as account `account-1`');
		expect(status.text).toContain('openai-codex/');

		const disconnect = await handleSlashCommand(command('openai disconnect', ADMIN), () => service);

		expect(disconnect.text).toContain('revoked its refresh token');

		const after = await handleSlashCommand(command('openai status', ADMIN), () => service);

		expect(after.text).toContain('not connected');
	});
});

describe('/aiyappa models', () => {
	test('lists aliases and marks ChatGPT ones unavailable while disconnected', async () => {
		const service = new CodexAuthService(memoryStorage(), credentialKey);

		const disconnected = await handleSlashCommand(command('models', ADMIN), () => service);

		expect(disconnected.response_type).toBe('ephemeral');
		expect(disconnected.text).toContain('`luna` — `openai-codex/gpt-5.6-luna` (unavailable)');
		expect(disconnected.text).toContain('`kimi` — `opencode-go/kimi-k3`\n');

		await service.seed({
			access: 'access-1',
			refresh: 'refresh-1',
			expires: Date.now() + 60 * 60 * 1000,
			accountId: 'account-1',
		});

		const connected = await handleSlashCommand(command('models', ADMIN), () => service);

		expect(connected.text).toContain('`luna` — `openai-codex/gpt-5.6-luna`\n');
	});

	test('treats an unreachable CodexAuth as disconnected', async () => {
		const service = new CodexAuthService(memoryStorage(), credentialKey);

		vi.spyOn(service, 'status').mockRejectedValue(new Error('boom'));

		const reply = await handleSlashCommand(command('models', ADMIN), () => service);

		expect(reply.text).toContain('(unavailable)');
	});

	test('refuses users on neither list', async () => {
		const reply = await handleSlashCommand(command('models', STRANGER), () => {
			throw new Error('CodexAuth should not be asked');
		});

		expect(reply.text).toBe('You are not on the invoker allowlist for this deployment.');
	});
});
