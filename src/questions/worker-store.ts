import { createQuestionStore } from './d1-store.ts';
import type { QuestionStore } from './store.ts';

export type QuestionStoreFactory = () => QuestionStore | Promise<QuestionStore>;

// Keep the Worker-only import lazy: agent-only runs without a Slack token
// preview the question and never need Cloudflare bindings.
export async function workerQuestionStore(): Promise<QuestionStore> {
	const { env } = await import('cloudflare:workers');

	return createQuestionStore(env.APP_DB);
}
