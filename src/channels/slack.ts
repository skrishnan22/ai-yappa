// flue-blueprint: channel/slack@1
import { dispatch, getAgentInstance } from '@flue/runtime';
import { createSlackChannel, type SlackThreadRef } from '@flue/slack';
import { Coworker } from '../agents/coworker.ts';
import { isAllowedInvoker, repoForChannel } from '../config.ts';
import { classifyTelemetryError, emitTelemetry } from '../observability.ts';
import { decideAdmit, mentionsAuthorizedBot } from './admit.ts';
import type { SlackSignal } from './admit.ts';
import { getSlackClient, observeSlackDelivery } from './slack-reply.ts';
import { loadThreadContext } from './thread-context.ts';
import type { ServerEnv } from '../env.ts';

async function conversationExistsInThread(signalType: SlackSignal, id: string): Promise<boolean> {
	if (signalType === 'slack.app_mention') return false;
	const existing = await getAgentInstance(Coworker, id);
	return existing !== null;
}

export function createSlackChannelForEnv(env: ServerEnv) {
	const channel = createSlackChannel({
		signingSecret: env.SLACK_SIGNING_SECRET,

		async events({ payload }) {
			if (payload.type !== 'event_callback') return;

			switch (payload.event.type) {
				case 'app_mention': {
					const event = payload.event;
					await admitThread({
						channel,
						env,
						thread: {
							teamId: payload.team_id,
							channelId: event.channel,
							threadTs: event.thread_ts ?? event.ts,
						},
						userId: event.user,
						eventId: payload.event_id,
						text: event.text,
						signalType: 'slack.app_mention',
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
						thread: {
							teamId: payload.team_id,
							channelId: event.channel,
							threadTs: event.thread_ts,
						},
						userId: event.user,
						eventId: payload.event_id,
						text: event.text ?? '',
						signalType: 'slack.message',
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
	thread,
	userId,
	eventId,
	text,
	signalType,
}: {
	channel: ReturnType<typeof createSlackChannel>;
	env: ServerEnv;
	thread: SlackThreadRef;
	userId: string | undefined;
	eventId: string;
	text: string;
	signalType: SlackSignal;
}): Promise<void> {
	const started = Date.now();
	const id = channel.instanceId(thread);
	const allowed = isAllowedInvoker(userId);
	const repo = repoForChannel(thread.channelId);

	let conversationExists: boolean;
	try {
		conversationExists = await conversationExistsInThread(signalType, id);
	} catch (error) {
		emitTelemetry({
			event_name: 'slack.invocation',
			outcome: 'failed',
			slack_event_id: eventId,
			conversation_id: id,
			signal_type: signalType,
			decision: 'admission-error',
			repo,
			duration_ms: Math.max(0, Date.now() - started),
			...classifyTelemetryError(error),
		});
		throw error;
	}

	const decision = decideAdmit({
		signalType,
		allowed,
		repo,
		conversationExists,
	});

	switch (decision.kind) {
		case 'refuse-invoker':
			emitTelemetry({
				event_name: 'slack.invocation',
				outcome: 'refused',
				slack_event_id: eventId,
				conversation_id: id,
				signal_type: signalType,
				decision: decision.kind,
				duration_ms: Math.max(0, Date.now() - started),
			});
			await observeSlackDelivery(
				{
					conversationId: id,
					slackEventId: eventId,
					deliveryKind: 'refusal',
					method: 'chat.postMessage',
				},
				() =>
					getSlackClient(env.SLACK_BOT_TOKEN).chat.postMessage({
						channel: thread.channelId,
						thread_ts: thread.threadTs,
						text: 'You are not on the invoker allowlist for this deployment.',
					}),
			);
			return;
		case 'no-repo':
			emitTelemetry({
				event_name: 'slack.invocation',
				outcome: 'refused',
				slack_event_id: eventId,
				conversation_id: id,
				signal_type: signalType,
				decision: decision.kind,
				duration_ms: Math.max(0, Date.now() - started),
			});
			await observeSlackDelivery(
				{
					conversationId: id,
					slackEventId: eventId,
					deliveryKind: 'missing_repo',
					method: 'chat.postMessage',
				},
				() =>
					getSlackClient(env.SLACK_BOT_TOKEN).chat.postMessage({
						channel: thread.channelId,
						thread_ts: thread.threadTs,
						text: 'This channel has no default repo. Add it to `src/config.ts` (or pass `repo:` once that override exists).',
					}),
			);
			return;
		case 'drop-untracked':
			emitTelemetry({
				event_name: 'slack.invocation',
				outcome: 'dropped',
				slack_event_id: eventId,
				conversation_id: id,
				signal_type: signalType,
				decision: decision.kind,
				duration_ms: Math.max(0, Date.now() - started),
			});
			return;
		case 'dispatch': {
			const attributes: Record<string, string> = { eventId };
			let threadContextOutcome: 'ok' | 'failed' = 'ok';
			try {
				const threadContext = await loadThreadContext(getSlackClient(env.SLACK_BOT_TOKEN), thread);
				if (threadContext !== undefined) attributes.threadContext = threadContext;
			} catch {
				threadContextOutcome = 'failed';
			}
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
					},
					message: {
						kind: 'signal',
						type: signalType,
						body: text,
						attributes,
					},
				});
				emitTelemetry({
					event_name: 'slack.invocation',
					outcome: receipt.deduplicated ? 'deduplicated' : 'ok',
					slack_event_id: eventId,
					conversation_id: id,
					signal_type: signalType,
					decision: decision.kind,
					thread_context_outcome: threadContextOutcome,
					submission_id: receipt.submissionId,
					agent_uid: receipt.uid,
					deduplicated: receipt.deduplicated === true,
					repo: decision.repo,
					duration_ms: Math.max(0, Date.now() - started),
				});
				return;
			} catch (error) {
				emitTelemetry({
					event_name: 'slack.invocation',
					outcome: 'failed',
					slack_event_id: eventId,
					conversation_id: id,
					signal_type: signalType,
					decision: decision.kind,
					thread_context_outcome: threadContextOutcome,
					repo: decision.repo,
					duration_ms: Math.max(0, Date.now() - started),
					...classifyTelemetryError(error),
				});
				throw error;
			}
		}
		default: {
			const _exhaustive: never = decision;
			return _exhaustive;
		}
	}
}
