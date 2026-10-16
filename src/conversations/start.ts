import type { DeliveredMessage, dispatch } from '@flue/runtime';
import { Coworker } from '../agents/coworker.ts';
import type { ModelChoice } from '../agents/model-choice.ts';
import { type ModelRoute, modelRouteFor } from '../agents/model-route.ts';
import type { CodexAuthControl } from '../integrations/codex-auth/codex-auth.ts';
import { errorMessage } from '../json.ts';

export type ConversationRuntime = { dispatch: typeof dispatch };

export type ConversationStart = {
	id: string; // channel.instanceId(thread)
	thread: { channelId: string; threadTs: string };
	startedBy?: string;
	repo?: string;
	modelChoice?: ModelChoice;
	automationId?: string;
	idempotencyKey: string;
	message: DeliveredMessage;
};

// Slack mentions and DMs start a Coworker here; automation fires will too.
// Flue records initialData only when the dispatch creates the conversation.
export function startConversation({
	runtime,
	start,
	now,
}: {
	runtime: ConversationRuntime;
	start: ConversationStart;
	now: Date;
}): ReturnType<typeof dispatch> {
	return runtime.dispatch(Coworker, {
		id: start.id,
		idempotencyKey: start.idempotencyKey,
		initialData: {
			channelId: start.thread.channelId,
			threadTs: start.thread.threadTs,
			startedBy: start.startedBy,
			startedAt: now.toISOString(),
			repo: start.repo,
			modelChoice: start.modelChoice,
			automationId: start.automationId,
		},
		message: start.message,
	});
}

// Falls back to OpenCode Go when `CodexAuth` cannot answer, so a broken
// ChatGPT connection never blocks Slack or a scheduled run.
export async function modelRouteForDispatch(
	codexAuth: () => CodexAuthControl,
): Promise<ModelRoute> {
	try {
		const status = await codexAuth().status();

		return modelRouteFor(status);
	} catch (error) {
		console.warn(
			`[dispatch] CodexAuth status failed; routing to OpenCode Go: ${errorMessage(error)}`,
		);

		return 'opencode-go';
	}
}
