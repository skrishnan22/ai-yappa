import type { SlackSlashCommandPayload } from '@flue/slack';
import * as v from 'valibot';
import { openAICodexModelSpecifier } from '../agents/openai-codex-route.ts';
import { openCodeGoModelSpecifier } from '../agents/opencode-go-catalog.ts';
import { isAllowedInvoker, isCodexAdmin } from '../config.ts';
import type {
	CodexAuthControl,
	CodexAuthStatus,
	CodexConnectResult,
	CodexDisconnectResult,
} from '../integrations/codex-auth/codex-auth.ts';
import { errorMessage } from '../json.ts';

export const COWORKER_COMMAND = '/coworker';

const USAGE = 'Usage: `/coworker openai connect|status|disconnect`';

const subcommandSchema = v.picklist(['connect', 'status', 'disconnect']);

// Verified ingress already authenticated the payload; this keeps `CodexAuth`
// from posting anywhere but Slack.
const responseUrlSchema = v.pipe(v.string(), v.url(), v.startsWith('https://hooks.slack.com/'));

export type SlashCommandReply = { response_type: 'ephemeral'; text: string };

/**
 * `/coworker openai connect|status|disconnect` (ADR 0020). Every reply is
 * ephemeral, and only the connect reply carries the device code: whoever
 * enters it binds the deployment to their ChatGPT account.
 *
 * Connect and disconnect need a Codex admin. Status is also open to the
 * invoker allowlist; it shows the account id, the token expiry, and which
 * route Coworker uses, nothing an invoker could act on.
 */
export async function handleCoworkerCommand(
	payload: SlackSlashCommandPayload,
	codexAuth: () => CodexAuthControl,
): Promise<SlashCommandReply> {
	if (payload.command !== COWORKER_COMMAND) return reply(`Unknown command ${payload.command}.`);
	const [provider, action, ...extra] = payload.text.trim().split(/\s+/);
	const subcommand = v.safeParse(subcommandSchema, action);

	if (provider !== 'openai' || !subcommand.success || extra.length > 0) return reply(USAGE);

	const command = subcommand.output;

	switch (command) {
		case 'status': {
			if (!isCodexAdmin(payload.user_id) && !isAllowedInvoker(payload.user_id)) {
				return reply('You are not on the invoker allowlist for this deployment.');
			}

			return runReply('status', async () => statusText(await codexAuth().status()));
		}

		case 'connect': {
			if (!isCodexAdmin(payload.user_id)) return reply(adminOnly('connect'));
			const responseUrl = v.safeParse(responseUrlSchema, payload.response_url);

			if (!responseUrl.success) return reply('Slack sent no usable response URL.');

			return runReply('connect', async () =>
				connectText(await codexAuth().startLogin(responseUrl.output)),
			);
		}

		case 'disconnect': {
			if (!isCodexAdmin(payload.user_id)) return reply(adminOnly('disconnect'));

			return runReply('disconnect', async () => disconnectText(await codexAuth().disconnect()));
		}

		default: {
			const _exhaustive: never = command;

			return _exhaustive;
		}
	}
}

function reply(text: string): SlashCommandReply {
	return { response_type: 'ephemeral', text };
}

function adminOnly(action: string): string {
	return `Only Codex admins can ${action} the ChatGPT subscription. Ask for your Slack user id to be added to \`codexAdminIds\` in \`src/config.ts\`.`;
}

async function runReply(action: string, run: () => Promise<string>): Promise<SlashCommandReply> {
	try {
		return reply(await run());
	} catch (error) {
		return reply(`ChatGPT ${action} failed: ${errorMessage(error)}`);
	}
}

function statusText(status: CodexAuthStatus): string {
	switch (status.state) {
		case 'connected':
			return `ChatGPT is connected as account \`${status.accountId}\`; Coworker uses \`${openAICodexModelSpecifier}\`. The current access token expires ${slackDate(status.expires)} and refreshes automatically.`;
		case 'pending_login':
			return `A ChatGPT login is waiting for approval until ${slackDate(status.expires)}. Until then Coworker uses \`${openCodeGoModelSpecifier}\`.`;
		case 'disconnected':
			return `ChatGPT is not connected; Coworker uses \`${openCodeGoModelSpecifier}\`. A Codex admin can run \`/coworker openai connect\`.`;
		default: {
			const _exhaustive: never = status;

			return _exhaustive;
		}
	}
}

function connectText(result: CodexConnectResult): string {
	if (result.state === 'connected') {
		return `ChatGPT is already connected as account \`${result.accountId}\`. Run \`/coworker openai disconnect\` first to switch accounts.`;
	}

	return [
		'*Connect Coworker to a ChatGPT subscription*',
		`1. Open ${result.verificationUrl} and sign in with the ChatGPT account Coworker should use.`,
		`2. Enter the code \`${result.userCode}\` before ${slackDate(result.expires)}.`,
		'Only you can see this code. Whoever enters it connects the whole deployment to their account. The account needs "Device code authorization for Codex" enabled in ChatGPT security settings. This message updates when the login finishes.',
	].join('\n');
}

function disconnectText(result: CodexDisconnectResult): string {
	const route = `Coworker uses \`${openCodeGoModelSpecifier}\`.`;

	switch (result.revocation) {
		case 'revoked':
			return `Disconnected ChatGPT and revoked its refresh token. ${route}`;
		case 'failed':
			return `Disconnected ChatGPT, but OpenAI did not confirm the token revocation. Sign the session out from ChatGPT's security settings. ${route}`;
		case 'none':
			return result.cancelledLogin
				? `Cancelled the pending ChatGPT login. ${route}`
				: `ChatGPT was not connected. ${route}`;
		default: {
			const _exhaustive: never = result.revocation;

			return _exhaustive;
		}
	}
}

// Rendered in the viewer's time zone; the fallback is for clients without it.
function slackDate(ms: number): string {
	return `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} at {time}|${new Date(ms).toISOString()}>`;
}
