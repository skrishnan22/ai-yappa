// flue-blueprint: channel/slack@1
import { dispatch, getAgentInstance } from '@flue/runtime';
import { createSlackChannel, type SlackThreadRef } from '@flue/slack';
import { Coworker } from '../agents/coworker.ts';
import { isAllowedInvoker, repoForChannel } from '../config.ts';
import { decideAdmit, mentionsAuthorizedBot } from './admit.ts';
import type { SlackSignal } from './admit.ts';
import { client } from './slack-reply.ts';
import { env } from '../env.ts';

export const channel = createSlackChannel({
	signingSecret: env.SLACK_SIGNING_SECRET,

	async events({ payload }) {
		if (payload.type !== 'event_callback') return;

		switch (payload.event.type) {
			case 'app_mention': {
				const event = payload.event;
				await admitThread({
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

async function admitThread({
	thread,
	userId,
	eventId,
	text,
	signalType,
}: {
	thread: SlackThreadRef;
	userId: string | undefined;
	eventId: string;
	text: string;
	signalType: SlackSignal;
}): Promise<void> {
	const id = channel.instanceId(thread);
	const allowed = isAllowedInvoker(userId);
	const repo = repoForChannel(thread.channelId);

	const conversationExists =
		signalType === 'slack.message' ? (await getAgentInstance(Coworker, id)) !== null : true;

	const decision = decideAdmit({
		signalType,
		allowed,
		repo,
		conversationExists,
	});

	switch (decision.kind) {
		case 'refuse-invoker':
			await client.chat.postMessage({
				channel: thread.channelId,
				thread_ts: thread.threadTs,
				text: 'You are not on the invoker allowlist for this deployment.',
			});
			return;
		case 'no-repo':
			await client.chat.postMessage({
				channel: thread.channelId,
				thread_ts: thread.threadTs,
				text: 'This channel has no default repo. Add it to `src/config.ts` (or pass `repo:` once that override exists).',
			});
			return;
		case 'drop-untracked':
			return;
		case 'dispatch':
			await dispatch(Coworker, {
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
					attributes: { eventId },
				},
			});
			return;
		default: {
			const _exhaustive: never = decision;
			return _exhaustive;
		}
	}
}
