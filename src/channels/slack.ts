// flue-blueprint: channel/slack@1
import { dispatch, getAgentInstance } from '@flue/runtime';
import { createSlackChannel, type SlackThreadRef } from '@flue/slack';
import { Coworker } from '../agents/coworker.ts';
import { type ModelRoute, modelRouteFor } from '../agents/model-route.ts';
import { isAllowedInvoker, repoForChannel } from '../config.ts';
import type { CodexAuthControl } from '../integrations/codex-auth/codex-auth.ts';
import { errorMessage } from '../json.ts';
import { emitSemanticEvent } from '../observability.ts';
import { decideAdmit, decideInvocation, isTimeoutRetry, mentionsAuthorizedBot } from './admit.ts';
import type { SlackSignal } from './admit.ts';
import { handleSlashCommand } from './slash-command.ts';
import { getSlackClient } from './slack-reply.ts';
import { loadThreadContext } from './thread-context.ts';
import type { ServerEnv } from '../env.ts';

async function conversationExistsInThread(id: string): Promise<boolean> {
	const existing = await getAgentInstance(Coworker, id);

	return existing !== null;
}

// Falls back to OpenCode Go when `CodexAuth` cannot answer, so a broken
// ChatGPT connection never blocks Slack.
async function modelRouteForDispatch(codexAuth: () => CodexAuthControl): Promise<ModelRoute> {
	try {
		const status = await codexAuth().status();

		return modelRouteFor(status);
	} catch (error) {
		console.warn(`[slack] CodexAuth status failed; routing to OpenCode Go: ${errorMessage(error)}`);

		return 'opencode-go';
	}
}

export function createSlackChannelForEnv(env: ServerEnv, codexAuth: () => CodexAuthControl) {
	const channel = createSlackChannel({
		signingSecret: env.SLACK_SIGNING_SECRET,

		commands({ payload }) {
			return handleSlashCommand(payload, codexAuth);
		},

		async events({ c, payload }) {
			if (payload.type !== 'event_callback') return;
			const timeoutRetry = isTimeoutRetry(c.req.raw.headers);

			switch (payload.event.type) {
				case 'app_mention': {
					const event = payload.event;
					await admitThread({
						channel,
						env,
						codexAuth,
						thread: {
							teamId: payload.team_id,
							channelId: event.channel,
							threadTs: event.thread_ts ?? event.ts,
						},
						userId: event.user,
						eventId: payload.event_id,
						text: event.text,
						signalType: 'slack.app_mention',
						timeoutRetry,
					});

					return;
				}

				case 'message': {
					const event = payload.event;

					if (event.subtype !== undefined) return;

					if (event.bot_id !== undefined) return;

					if (event.thread_ts === undefined) return;

					if (mentionsAuthorizedBot(event.text ?? '', payload.authorizations)) return;
					await admitThread({
						channel,
						env,
						codexAuth,
						thread: {
							teamId: payload.team_id,
							channelId: event.channel,
							threadTs: event.thread_ts,
						},
						userId: event.user,
						eventId: payload.event_id,
						text: event.text ?? '',
						signalType: 'slack.message',
						timeoutRetry,
					});

					return;
				}

				default:
					return;
			}
		},
	});

	return channel;
}

async function admitThread({
	channel,
	env,
	codexAuth,
	thread,
	userId,
	eventId,
	text,
	signalType,
	timeoutRetry,
}: {
	channel: ReturnType<typeof createSlackChannel>;
	env: ServerEnv;
	codexAuth: () => CodexAuthControl;
	thread: SlackThreadRef;
	userId: string | undefined;
	eventId: string;
	text: string;
	signalType: SlackSignal;
	timeoutRetry: boolean;
}): Promise<void> {
	const id = channel.instanceId(thread);
	const allowed = isAllowedInvoker(userId);
	const repo = repoForChannel(thread.channelId);

	// Mentions check too: only the mention that creates a conversation reads
	// `model:` / `think:`.
	const conversationExists = await conversationExistsInThread(id);

	async function refuse(
		kind: 'refuse-invoker' | 'no-repo' | 'bad-args' | 'model-unavailable',
		reply: string,
	): Promise<void> {
		emitSemanticEvent({
			event_name: 'slack_admission',
			outcome: 'refused',
			conversation_id: id,
			slack_event_id: eventId,
			signal_type: signalType,
			decision: kind,
		});

		if (timeoutRetry) return;
		await getSlackClient(env.SLACK_BOT_TOKEN).chat.postMessage({
			channel: thread.channelId,
			thread_ts: thread.threadTs,
			text: reply,
		});
	}

	const decision = decideAdmit({
		signalType,
		allowed,
		repo,
		conversationExists,
	});

	switch (decision.kind) {
		case 'refuse-invoker':
			await refuse(decision.kind, 'You are not on the invoker allowlist for this deployment.');

			return;
		case 'no-repo':
			await refuse(
				decision.kind,
				'This channel has no default repo. Add it to `src/config.ts` (or pass `repo:` once that override exists).',
			);

			return;
		case 'drop-untracked':
			emitSemanticEvent({
				event_name: 'slack_admission',
				outcome: 'dropped',
				conversation_id: id,
				slack_event_id: eventId,
				signal_type: signalType,
				decision: decision.kind,
			});

			return;
		case 'dispatch': {
			const modelRoute = await modelRouteForDispatch(codexAuth);
			const invocation = decideInvocation({ signalType, text, modelRoute, conversationExists });

			if (invocation.kind !== 'proceed') {
				await refuse(invocation.kind, invocation.reply);

				return;
			}

			let threadContext: string | undefined;

			try {
				threadContext = await loadThreadContext(getSlackClient(env.SLACK_BOT_TOKEN), thread);
			} catch {
				// Thread history is context for the agent, not a dispatch requirement.
			}

			type SignalAttributes = { eventId: string; modelRoute: ModelRoute; threadContext?: string };

			const attributes: SignalAttributes = { eventId, modelRoute };

			if (threadContext !== undefined) attributes.threadContext = threadContext;

			try {
				const receipt = await dispatch(Coworker, {
					id,
					idempotencyKey: eventId,
					initialData: {
						channelId: thread.channelId,
						threadTs: thread.threadTs,
						startedBy: userId,
						startedAt: new Date().toISOString(),
						repo: decision.repo,
						// Flue records this only when the dispatch creates the conversation.
						modelChoice: invocation.modelChoice,
					},
					message: {
						kind: 'signal',
						type: signalType,
						body: invocation.body,
						attributes,
					},
				});

				emitSemanticEvent({
					event_name: 'slack_admission',
					outcome: receipt.deduplicated ? 'deduplicated' : 'dispatched',
					conversation_id: id,
					slack_event_id: eventId,
					signal_type: signalType,
					decision: decision.kind,
					submission_id: receipt.submissionId,
					agent_uid: receipt.uid,
				});
			} catch (error) {
				emitSemanticEvent({
					event_name: 'slack_admission',
					outcome: 'failed',
					conversation_id: id,
					slack_event_id: eventId,
					signal_type: signalType,
					decision: decision.kind,
				});
				throw error;
			}

			return;
		}

		default: {
			const _exhaustive: never = decision;

			return _exhaustive;
		}
	}
}
