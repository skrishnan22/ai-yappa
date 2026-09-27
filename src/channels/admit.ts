import { type ModelChoice, modelHelpText, resolveModelChoice } from '../agents/model-choice.ts';
import { parseInvocationArgs } from './invocation-args.ts';

export type SlackSignal = 'slack.app_mention' | 'slack.message';

type SlackAuthorization = {
	user_id: string;
	is_bot: boolean;
};

export type AdmitDecision =
	| { kind: 'refuse-invoker' }
	| { kind: 'no-repo' }
	| { kind: 'drop-untracked' }
	| { kind: 'dispatch'; repo: string };

export function decideAdmit(args: {
	signalType: SlackSignal;
	allowed: boolean;
	repo: string | undefined;
	conversationExists: boolean;
}): AdmitDecision {
	if (args.signalType === 'slack.message' && !args.conversationExists) {
		return { kind: 'drop-untracked' };
	}

	if (!args.allowed) return { kind: 'refuse-invoker' };

	if (args.repo === undefined) return { kind: 'no-repo' };

	return { kind: 'dispatch', repo: args.repo };
}

export type InvocationDecision =
	| { kind: 'bad-args'; reply: string }
	| { kind: 'model-unavailable'; reply: string }
	| { kind: 'proceed'; body: string; modelChoice?: ModelChoice };

/**
 * Inline `$model:` / `$effort:` arguments on a mention that creates a
 * conversation. Replies and later mentions are plain text: the thread's
 * choice is already recorded and they could not change it. A ChatGPT model
 * is refused while ChatGPT is not usable, so asking for Luna never silently
 * gets DeepSeek.
 */
export function decideInvocation(args: {
	signalType: SlackSignal;
	text: string;
	chatgptConnected: boolean;
	conversationExists: boolean;
}): InvocationDecision {
	if (args.signalType !== 'slack.app_mention' || args.conversationExists) {
		return { kind: 'proceed', body: args.text };
	}

	const parsed = parseInvocationArgs(args.text);

	if (!parsed.ok) return { kind: 'bad-args', reply: `${parsed.error}\n${modelHelpText()}` };

	const resolved = resolveModelChoice(parsed.args);

	if (!resolved.ok) return { kind: 'bad-args', reply: `${resolved.error}\n${modelHelpText()}` };

	const { choice } = resolved;

	if (choice?.model?.provider === 'chatgpt' && !args.chatgptConnected) {
		return {
			kind: 'model-unavailable',
			reply: `ChatGPT isn't connected, so \`${choice.model.modelId}\` isn't available. Pick an OpenCode Go model, or ask a Codex admin to run \`/aiyappa openai connect\`.\n${modelHelpText()}`,
		};
	}

	return { kind: 'proceed', body: parsed.args.body, modelChoice: choice };
}

/**
 * Slack redelivers an event it gave up waiting for with reason
 * `http_timeout`. The first delivery is still running and posts its own
 * refusal, so a retry must not post another. Dispatch dedupes on event id.
 */
export function isTimeoutRetry(headers: Headers): boolean {
	return headers.get('x-slack-retry-reason') === 'http_timeout';
}

export function mentionsAuthorizedBot(
	text: string,
	authorizations: SlackAuthorization[] | undefined,
): boolean {
	const botUserId = authorizations?.find((authorization) => authorization.is_bot)?.user_id;

	return botUserId !== undefined && text.includes(`<@${botUserId}>`);
}
