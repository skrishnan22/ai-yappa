// flue-blueprint: channel/slack@1
import { dispatch, getAgentInstance } from '@flue/runtime';
import { createSlackChannel, type SlackThreadRef } from '@flue/slack';
import { Coworker } from '../agents/coworker.ts';
import { isAllowedInvoker, repoForChannel } from '../config.ts';
import { emitSemanticEvent } from '../observability.ts';
import { decideAdmit, mentionsAuthorizedBot } from './admit.ts';
import type { SlackSignal } from './admit.ts';
import { getSlackClient } from './slack-reply.ts';
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
	const id = channel.instanceId(thread);
	const allowed = isAllowedInvoker(userId);
	const repo = repoForChannel(thread.channelId);

	const conversationExists = await conversationExistsInThread(signalType, id);

	const decision = decideAdmit({
		signalType,
		allowed,
		repo,
		conversationExists,
	});

	switch (decision.kind) {
		case 'refuse-invoker':
			emitSemanticEvent({
				event_name: 'slack_admission',
				outcome: 'refused',
				conversation_id: id,
				slack_event_id: eventId,
				signal_type: signalType,
				decision: decision.kind,
			});
			await getSlackClient(env.SLACK_BOT_TOKEN).chat.postMessage({
				channel: thread.channelId,
				thread_ts: thread.threadTs,
				text: 'You are not on the invoker allowlist for this deployment.',
			});
			return;
		case 'no-repo':
			emitSemanticEvent({
				event_name: 'slack_admission',
				outcome: 'refused',
				conversation_id: id,
				slack_event_id: eventId,
				signal_type: signalType,
				decision: decision.kind,
			});
			await getSlackClient(env.SLACK_BOT_TOKEN).chat.postMessage({
				channel: thread.channelId,
				thread_ts: thread.threadTs,
				text: 'This channel has no default repo. Add it to `src/config.ts` (or pass `repo:` once that override exists).',
			});
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
			const attributes: Record<string, string> = { eventId };
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
