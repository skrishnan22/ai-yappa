import type { SlackSlashCommandPayload } from '@flue/slack';
import * as v from 'valibot';
import { modelSpecifier } from '../agents/model-choice.ts';
import { openAICodexModelSpecifier } from '../agents/openai-codex-route.ts';
import { openCodeGoModelSpecifier } from '../agents/opencode-go-catalog.ts';
import { isAllowedInvoker, isCodexAdmin, modelAliases } from '../config.ts';
import type {
	CodexAuthControl,
	CodexAuthStatus,
	CodexConnectResult,
	CodexDisconnectResult,
} from '../integrations/codex-auth/codex-auth.ts';
import { errorMessage } from '../json.ts';

export const SLASH_COMMAND = '/aiyappa';

const USAGE = 'Usage: `/aiyappa openai connect|status|disconnect` or `/aiyappa models`';

const subcommandSchema = v.picklist(['connect', 'status', 'disconnect']);

// Verified ingress already authenticated the payload; this keeps `CodexAuth`
// from posting anywhere but Slack.
const responseUrlSchema = v.pipe(v.string(), v.url(), v.startsWith('https://hooks.slack.com/'));

export type SlashCommandReply = { response_type: 'ephemeral'; text: string };

/**
 * `/aiyappa models` lists the Model Choice aliases (ADR 0021).
 *
 * `/aiyappa openai connect|status|disconnect` (ADR 0020). Every reply is
 * ephemeral, and only the connect reply carries the device code: whoever
 * enters it binds the deployment to their ChatGPT account.
 *
 * Connect and disconnect need a Codex admin. Status is also open to the
 * invoker allowlist; it shows the account id, the token expiry, and which
 * route Coworker uses, nothing an invoker could act on.
 */
export async function handleSlashCommand(
	payload: SlackSlashCommandPayload,
	codexAuth: () => CodexAuthControl,
): Promise<SlashCommandReply> {
	if (payload.command !== SLASH_COMMAND) return reply(`Unknown command ${payload.command}.`);
	const [provider, action, ...extra] = payload.text.trim().split(/\s+/);

	if (provider === 'models' && action === undefined) {
		if (!isCodexAdmin(payload.user_id) && !isAllowedInvoker(payload.user_id)) {
			return reply('You are not on the invoker allowlist for this deployment.');
		}

		// An unreachable CodexAuth routes like a disconnected one.
		const status = await codexAuth()
			.status()
			.catch(() => undefined);

		return reply(modelsText(status?.state === 'connected'));
	}

	const subcommand = v.safeParse(subcommandSchema, action);

	if (provider !== 'openai' || !subcommand.success || extra.length > 0) return reply(USAGE);

	const command = subcommand.output;

	switch (command) {
		case 'status': {
			if (!isCodexAdmin(payload.user_id) && !isAllowedInvoker(payload.user_id)) {
				return reply('You are not on the invoker allowlist for this deployment.');
			}

			return replyOrError('status', async () => {
				const status = await codexAuth().status();

				return statusText(status);
			});
		}

		case 'connect': {
			if (!isCodexAdmin(payload.user_id)) return reply(adminOnly('connect'));
			const responseUrl = v.safeParse(responseUrlSchema, payload.response_url);

			if (!responseUrl.success) return reply('Slack sent no usable response URL.');

			return replyOrError('connect', async () => {
				const result = await codexAuth().startLogin(responseUrl.output);

				return connectText(result);
			});
		}

		case 'disconnect': {
			if (!isCodexAdmin(payload.user_id)) return reply(adminOnly('disconnect'));

			return replyOrError('disconnect', async () => {
				const result = await codexAuth().disconnect();

				return disconnectText(result);
			});
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

async function replyOrError(
	action: string,
	run: () => Promise<string>,
): Promise<SlashCommandReply> {
	try {
		const text = await run();

		return reply(text);
	} catch (error) {
		return reply(`ChatGPT ${action} failed: ${errorMessage(error)}`);
	}
}

function statusText(status: CodexAuthStatus): string {
	switch (status.state) {
		case 'connected':
			return `ChatGPT is connected as account \`${status.accountId}\`; Coworker uses \`${openAICodexModelSpecifier}\` unless a thread picks another model. The current access token expires ${slackDate(status.expires)} and refreshes automatically.`;
		case 'pending_login':
			return `A ChatGPT login is waiting for approval until ${slackDate(status.expires)}. Until then Coworker uses \`${openCodeGoModelSpecifier}\` by default.`;
		case 'disconnected':
			return `ChatGPT is not connected; Coworker uses \`${openCodeGoModelSpecifier}\` by default. A Codex admin can run \`/aiyappa openai connect\`.`;
		default: {
			const _exhaustive: never = status;

			return _exhaustive;
		}
	}
}

function modelsText(chatgptConnected: boolean): string {
	const lines = Object.entries(modelAliases).map(([alias, model]) => {
		const unavailable = model.provider === 'chatgpt' && !chatgptConnected ? ' (unavailable)' : '';

		return `• \`${alias}\` — \`${modelSpecifier(model)}\`${unavailable}`;
	});

	const fallback = chatgptConnected
		? `Without \`$model:\`, Coworker uses \`${openAICodexModelSpecifier}\`.`
		: `ChatGPT is not connected, so ChatGPT models are unavailable. Without \`$model:\`, Coworker uses \`${openCodeGoModelSpecifier}\`.`;

	return [
		'Start a thread with `$model:&lt;name&gt;` and `$effort:low|medium|high` anywhere in the mention:',
		...lines,
		fallback,
	].join('\n');
}

function connectText(result: CodexConnectResult): string {
	if (result.state === 'connected') {
		return `ChatGPT is already connected as account \`${result.accountId}\`. Run \`/aiyappa openai disconnect\` first to switch accounts.`;
	}

	return [
		'*Connect Coworker to a ChatGPT subscription*',
		`1. Open ${result.verificationUrl} and sign in with the ChatGPT account Coworker should use.`,
		`2. Enter the code \`${result.userCode}\` before ${slackDate(result.expires)}.`,
		'Only you can see this code. Whoever enters it connects the whole deployment to their account. The account needs "Device code authorization for Codex" enabled in ChatGPT security settings. This message updates when the login finishes.',
	].join('\n');
}

function disconnectText(result: CodexDisconnectResult): string {
	const route = `Coworker uses \`${openCodeGoModelSpecifier}\` by default.`;

	switch (result.revocation) {
		case 'revoked':
			return `Disconnected ChatGPT and revoked its refresh token. ${route}`;
		case 'failed':
			return `Disconnected ChatGPT, but OpenAI did not confirm the token revocation. Sign the session out from ChatGPT's security settings. ${route}`;
		case 'unreadable':
			return `Deleted a stored ChatGPT credential that no longer decrypts (was \`CODEX_CREDENTIAL_KEY\` changed?), so its token was not revoked. Sign the session out from ChatGPT's security settings. ${route}`;
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
