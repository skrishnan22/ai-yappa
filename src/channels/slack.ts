// flue-blueprint: channel/slack@1
import { dispatch, getAgentInstance } from '@flue/runtime';
import type { DeliveredMessage } from '@flue/runtime';
import { WebClient } from '@slack/web-api';
import type { Context, ExecutionContext } from 'hono';
import * as v from 'valibot';
import {
	createSlackChannel,
	type SlackChannel,
	type SlackEventCallbackPayload,
	type SlackThreadRef,
} from '@flue/slack';
import { Coworker } from '../agents/coworker.ts';
import { slackUserDeliveryBody, type ModelRoute } from '../agents/model-route.ts';
import { repoForChannel } from '../config.ts';
import type { CodexAuthControl } from '../integrations/codex-auth/codex-auth.ts';
import { errorMessage } from '../json.ts';
import { emitSemanticEvent } from '../observability.ts';
import type { PlanningStore } from '../planning/decision-log.ts';
import {
	decideAdmit,
	decideInvocation,
	isAddressed,
	isExternalSender,
	isTimeoutRetry,
	mentionsAuthorizedBot,
} from './admit.ts';
import type { SlackSignal } from './admit.ts';
import { downloadSlackImages, type SlackImageFile } from './slack-attachments.ts';
import { handlePlanningInteraction, type PlanningContinuation } from './planning-interactions.ts';
import { handleSlashCommand } from './slash-command.ts';
import { getSlackClient, slackFetch, type SlackBotClient } from './slack-reply.ts';
import { loadThreadContext } from './thread-context.ts';
import { buildSignalAttributes, type SignalAttributes } from './signal-attributes.ts';
import type { ServerEnv } from '../env.ts';
import {
	type ConversationRuntime,
	modelRouteForDispatch,
	startConversation,
} from '../conversations/start.ts';

export type SlackRuntime = ConversationRuntime & {
	getAgentInstance: typeof getAgentInstance;
};

const defaultSlackRuntime: SlackRuntime = { dispatch, getAgentInstance };

const eventOrganizationSchema = v.object({
	team: v.optional(v.string()),
	user_team: v.optional(v.string()),
});

// The sender's organization. In a Slack Connect channel only `user_team`
// counts, so a missing field fails closed; elsewhere every sender is a member
// and plain messages may carry only `team` (`@slack/types` omits `user_team`).
function eventOrganization(event: SlackEventCallbackPayload['event']): {
	team?: string;
	user_team?: string;
} {
	const parsed = v.safeParse(eventOrganizationSchema, event);

	return parsed.success ? parsed.output : {};
}

function isExternalEvent(
	payload: SlackEventCallbackPayload,
	event: { team?: string; user_team?: string },
): boolean {
	const sharedExternally = payload.is_ext_shared_channel === true;

	return isExternalSender({
		senderTeam: sharedExternally ? event.user_team : (event.user_team ?? event.team),
		workspaceTeam: payload.team_id,
		sharedExternally,
	});
}

async function conversationExistsInThread(runtime: SlackRuntime, id: string): Promise<boolean> {
	const existing = await runtime.getAgentInstance(Coworker, id);

	return existing !== null;
}

// Thread history is context for the agent, not a dispatch requirement.
async function dispatchAttributes(
	slack: SlackBotClient,
	thread: SlackThreadRef,
	eventId: string,
	userId: string | undefined,
	modelRoute: ModelRoute,
): Promise<SignalAttributes & { modelRoute: ModelRoute }> {
	let threadContext: string | undefined;

	try {
		threadContext = await loadThreadContext(slack, thread);
	} catch {
		// Dispatch without it.
	}

	return { ...buildSignalAttributes(eventId, userId, threadContext), modelRoute };
}

// A shared deadline bounds every page of history; rate limits must not pause dispatch.
function planningSlackClient(token: string): SlackBotClient {
	const signal = AbortSignal.timeout(2000);

	return new WebClient(token, {
		fetch: (url, init) => slackFetch(url, { ...init, signal }),
		retryConfig: { retries: 0 },
		rejectRateLimitedCalls: true,
	});
}

// A card decision continues an existing Coworker. No initialData: a
// continuation must never create a conversation.
async function continuePlanning({
	channel,
	env,
	codexAuth,
	runtime,
	continuation,
}: {
	channel: SlackChannel;
	env: ServerEnv;
	codexAuth: () => CodexAuthControl;
	runtime: SlackRuntime;
	continuation: PlanningContinuation;
}): Promise<void> {
	const { conversationId, eventId, userId, type, body } = continuation;

	// Usually runs under waitUntil, where a rejection is otherwise invisible.
	try {
		const thread = channel.parseInstanceId(conversationId);
		const modelRoute = await modelRouteForDispatch(codexAuth);

		const attributes = await dispatchAttributes(
			planningSlackClient(env.SLACK_BOT_TOKEN),
			thread,
			eventId,
			userId,
			modelRoute,
		);

		await runtime.dispatch(Coworker, {
			id: conversationId,
			idempotencyKey: eventId,
			message: { kind: 'signal', type, body, attributes },
		});
	} catch (error) {
		console.error(`[planning] Continuation ${eventId} failed: ${errorMessage(error)}`);

		throw error;
	}
}

// Hono throws when there is no execution context (Node, Vitest, `flue run`).
export function executionContextOf(c: Context): ExecutionContext | undefined {
	try {
		return c.executionCtx;
	} catch {
		return undefined;
	}
}

/** Without `planning` there is no interactions route and no planning silence. */
export function createSlackChannelForEnv(
	env: ServerEnv,
	codexAuth: () => CodexAuthControl,
	runtime: SlackRuntime = defaultSlackRuntime,
	planning?: PlanningStore,
) {
	// Annotated: the interactions handler refers back to `channel`.
	const channel: SlackChannel = createSlackChannel({
		signingSecret: env.SLACK_SIGNING_SECRET,

		commands({ payload }) {
			return handleSlashCommand(payload, codexAuth);
		},

		interactions: planning
			? ({ c, payload }) =>
					handlePlanningInteraction(payload, {
						store: planning,
						slack: planningSlackClient(env.SLACK_BOT_TOKEN),
						workspaceTeamOf: (id) => channel.parseInstanceId(id).teamId,
						continueConversation: (continuation) =>
							continuePlanning({ channel, env, codexAuth, runtime, continuation }),
						defer: (work) => {
							const executionCtx = executionContextOf(c);

							if (!executionCtx) return work;
							executionCtx.waitUntil(work);

							return Promise.resolve();
						},
						now: () => new Date(),
					})
			: undefined,

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
						runtime,
						planning,
						thread: {
							teamId: payload.team_id,
							channelId: event.channel,
							threadTs: event.thread_ts ?? event.ts,
						},
						userId: event.user,
						external: isExternalEvent(payload, eventOrganization(event)),
						eventId: payload.event_id,
						text: event.text,
						files: event.files,
						signalType: 'slack.app_mention',
						timeoutRetry,
					});

					return;
				}

				case 'message': {
					const event = payload.event;

					if (event.subtype !== undefined && event.subtype !== 'file_share') return;

					if ('bot_id' in event && event.bot_id !== undefined) return;

					// Every DM is addressed to Yappa; a top-level DM starts its own thread.
					const direct = event.channel_type === 'im';

					if (!direct && event.thread_ts === undefined) return;

					// app_mention handles mentions in channels; it does not fire in DMs.
					if (!direct && mentionsAuthorizedBot(event.text ?? '', payload.authorizations)) return;
					await admitThread({
						channel,
						env,
						codexAuth,
						runtime,
						planning,
						thread: {
							teamId: payload.team_id,
							channelId: event.channel,
							threadTs: event.thread_ts ?? event.ts,
						},
						userId: event.user,
						external: isExternalEvent(payload, eventOrganization(event)),
						eventId: payload.event_id,
						text: event.text ?? '',
						files: event.files,
						signalType: direct ? 'slack.direct_message' : 'slack.message',
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
	runtime,
	planning,
	thread,
	userId,
	external,
	eventId,
	text,
	files,
	signalType,
	timeoutRetry,
}: {
	channel: SlackChannel;
	env: ServerEnv;
	codexAuth: () => CodexAuthControl;
	runtime: SlackRuntime;
	planning: PlanningStore | undefined;
	thread: SlackThreadRef;
	userId: string | undefined;
	external: boolean;
	eventId: string;
	text: string;
	files?: SlackImageFile[];
	signalType: SlackSignal;
	timeoutRetry: boolean;
}): Promise<void> {
	const id = channel.instanceId(thread);
	const repo = repoForChannel(thread.channelId);

	// Mentions check too: only the mention that creates a conversation reads
	// `$model:` / `$effort:`.
	const conversationExists = await conversationExistsInThread(runtime, id);

	async function refuse(
		kind: 'refuse-external' | 'bad-args' | 'model-unavailable',
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

	// Read only for a reply that could otherwise continue the conversation.
	// An unreadable flag (D1 error, missing migration) counts as inactive:
	// one reply leaking into a session beats silencing every thread.
	let planningActive = false;

	if (!isAddressed(signalType) && conversationExists && planning) {
		try {
			planningActive = await planning.sessions.isActive(id);
		} catch (error) {
			console.error(`[planning] Session read failed for ${id}: ${errorMessage(error)}`);
		}
	}

	const decision = decideAdmit({
		signalType,
		external,
		repo,
		conversationExists,
		planningActive,
	});

	switch (decision.kind) {
		case 'refuse-external':
			await refuse(decision.kind, 'Yappa only works for members of this workspace.');

			return;
		case 'drop-untracked':
		case 'drop-planning':
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

			const invocation = decideInvocation({
				signalType,
				text,
				chatgptConnected: modelRoute === 'chatgpt',
				conversationExists,
			});

			if (invocation.kind !== 'proceed') {
				await refuse(invocation.kind, invocation.reply);

				return;
			}

			const attributes = await dispatchAttributes(
				getSlackClient(env.SLACK_BOT_TOKEN),
				thread,
				eventId,
				userId,
				modelRoute,
			);

			const attachments = await downloadSlackImages(files ?? [], env.SLACK_BOT_TOKEN);

			const message: DeliveredMessage = attachments.length
				? {
						kind: 'user',
						body: slackUserDeliveryBody(invocation.body, attributes),
						attachments,
					}
				: { kind: 'signal', type: signalType, body: invocation.body, attributes };

			try {
				const receipt = await startConversation({
					runtime,
					now: new Date(),
					start: {
						id,
						thread,
						startedBy: userId,
						repo: decision.repo,
						// Flue records this only when the dispatch creates the conversation.
						modelChoice: invocation.modelChoice,
						idempotencyKey: eventId,
						message,
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
