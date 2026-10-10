// flue-blueprint: channel/slack@1
import { dispatch, getAgentInstance } from '@flue/runtime';
import {
	createSlackChannel,
	type SlackChannel,
	type SlackEventCallbackPayload,
	type SlackThreadRef,
} from '@flue/slack';
import { Coworker } from '../agents/coworker.ts';
import { type ModelRoute, modelRouteFor } from '../agents/model-route.ts';
import { repoForChannel } from '../config.ts';
import type { CodexAuthControl } from '../integrations/codex-auth/codex-auth.ts';
import { errorMessage } from '../json.ts';
import { emitSemanticEvent } from '../observability.ts';
import type { PlanningStore } from '../planning/decision-log.ts';
import {
	decideAdmit,
	decideInvocation,
	isExternalSender,
	isTimeoutRetry,
	mentionsAuthorizedBot,
} from './admit.ts';
import type { SlackSignal } from './admit.ts';
import { handlePlanningInteraction, type PlanningContinuation } from './planning-interactions.ts';
import { handleSlashCommand } from './slash-command.ts';
import { getSlackClient } from './slack-reply.ts';
import { loadThreadContext } from './thread-context.ts';
import { buildSignalAttributes, type SignalAttributes } from './signal-attributes.ts';
import type { ServerEnv } from '../env.ts';

export type SlackRuntime = {
	dispatch: typeof dispatch;
	getAgentInstance: typeof getAgentInstance;
};

const defaultSlackRuntime: SlackRuntime = { dispatch, getAgentInstance };

// The sender's organization. In a Slack Connect channel only `user_team`
// counts, so a missing field fails closed; elsewhere every sender is a member
// and plain messages may carry only `team` (`@slack/types` omits `user_team`).
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

// Thread history is context for the agent, not a dispatch requirement.
async function dispatchAttributes(
	env: ServerEnv,
	thread: SlackThreadRef,
	eventId: string,
	userId: string | undefined,
	modelRoute: ModelRoute,
): Promise<SignalAttributes & { modelRoute: ModelRoute }> {
	let threadContext: string | undefined;

	try {
		threadContext = await loadThreadContext(getSlackClient(env.SLACK_BOT_TOKEN), thread);
	} catch {
		// Dispatch without it.
	}

	return { ...buildSignalAttributes(eventId, userId, threadContext), modelRoute };
}

// A card decision or reopen continues an existing Coworker. No initialData: a
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
		const attributes = await dispatchAttributes(env, thread, eventId, userId, modelRoute);

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
						slack: getSlackClient(env.SLACK_BOT_TOKEN),
						workspaceTeamOf: (id) => channel.parseInstanceId(id).teamId,
						continueConversation: (continuation) =>
							continuePlanning({ channel, env, codexAuth, runtime, continuation }),
						// Hono throws when there is no execution context (tests, `flue run`).
						defer: (work) => {
							try {
								c.executionCtx.waitUntil(work);

								return Promise.resolve();
							} catch {
								return work;
							}
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
						external: isExternalEvent(payload, event),
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
						runtime,
						planning,
						thread: {
							teamId: payload.team_id,
							channelId: event.channel,
							threadTs: event.thread_ts,
						},
						userId: event.user,
						external: isExternalEvent(payload, event),
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
	runtime,
	planning,
	thread,
	userId,
	external,
	eventId,
	text,
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
	signalType: SlackSignal;
	timeoutRetry: boolean;
}): Promise<void> {
	const id = channel.instanceId(thread);
	const repo = repoForChannel(thread.channelId);

	// Mentions check too: only the mention that creates a conversation reads
	// `$model:` / `$effort:`.
	const conversationExists = await conversationExistsInThread(runtime, id);

	async function refuse(
		kind: 'refuse-external' | 'no-repo' | 'bad-args' | 'model-unavailable',
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

	if (signalType === 'slack.message' && conversationExists && planning) {
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
		case 'no-repo':
			await refuse(
				decision.kind,
				'This channel has no default repo. Add it to `src/config.ts` (or pass `repo:` once that override exists).',
			);

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

			const attributes = await dispatchAttributes(env, thread, eventId, userId, modelRoute);

			try {
				const receipt = await runtime.dispatch(Coworker, {
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
