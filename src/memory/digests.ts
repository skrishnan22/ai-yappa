import * as v from 'valibot';
import type { D1Database } from './d1.ts';

export type IndexedVisibility = 'public' | 'private';

export type ConversationDigest = {
	id: string;
	conversationId: string;
	channelId: string;
	channelVisibility: IndexedVisibility;
	threadTs: string;
	invokerUserIds: string[];
	requests: string;
	replies: string;
	toolsUsed: string;
	prUrl: string | null;
	createdAt: string;
};

export type DigestHit = {
	conversationId: string;
	channelId: string;
	threadTs: string;
	prUrl: string | null;
	createdAt: string;
	snippet: string;
};

export type DigestStore = {
	upsert(digest: ConversationDigest): Promise<void>;
	search(query: string, currentChannelId: string, limit: number): Promise<DigestHit[]>;
	forConversation(conversationId: string, currentChannelId: string): Promise<ConversationDigest[]>;
	deleteOlderThan(cutoff: Date): Promise<number>;
};

const hitRow = v.object({
	conversation_id: v.string(),
	channel_id: v.string(),
	thread_ts: v.string(),
	pr_url: v.nullable(v.string()),
	created_at: v.string(),
	snippet: v.string(),
});

const digestRow = v.object({
	id: v.string(),
	conversation_id: v.string(),
	channel_id: v.string(),
	channel_visibility: v.picklist(['public', 'private']),
	thread_ts: v.string(),
	invoker_user_ids: v.string(),
	requests: v.string(),
	replies: v.string(),
	tools_used: v.string(),
	pr_url: v.nullable(v.string()),
	created_at: v.string(),
});

// Coarse scope in SQL; callers re-check live Slack visibility (src/memory/scope.ts).
// Every query using this must bind the current channel ID as parameter ?2.
const IN_SCOPE = "(d.channel_visibility = 'public' OR d.channel_id = ?2)";

// Model-written queries become an OR of quoted words, so FTS5 syntax
// (quotes, parentheses, AND/NEAR, *, -) can never cause a parse error.
export const FTS_QUERY_MAX_WORDS = 32;

export function ftsQuery(text: string): string | undefined {
	const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
	const seen = new Set<string>();
	const deduped: string[] = [];

	for (const word of words) {
		const key = word.toLowerCase();

		if (seen.has(key)) continue;

		seen.add(key);
		deduped.push(word);

		if (deduped.length === FTS_QUERY_MAX_WORDS) break;
	}

	if (deduped.length === 0) return undefined;

	return deduped.map((word) => `"${word}"`).join(' OR ');
}

export function createDigestStore(db: D1Database): DigestStore {
	return {
		async upsert(digest) {
			await db
				.prepare(
					`INSERT INTO conversation_digests
					   (id, conversation_id, channel_id, channel_visibility, thread_ts, invoker_user_ids,
					    requests, replies, tools_used, pr_url, created_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
					 ON CONFLICT (id) DO UPDATE SET
					   channel_visibility = excluded.channel_visibility,
					   invoker_user_ids = excluded.invoker_user_ids,
					   requests = excluded.requests,
					   replies = excluded.replies,
					   tools_used = excluded.tools_used,
					   pr_url = excluded.pr_url`,
				)
				.bind(
					digest.id,
					digest.conversationId,
					digest.channelId,
					digest.channelVisibility,
					digest.threadTs,
					JSON.stringify(digest.invokerUserIds),
					digest.requests,
					digest.replies,
					digest.toolsUsed,
					digest.prUrl,
					digest.createdAt,
				)
				.run();
		},

		async search(query, currentChannelId, limit) {
			const match = ftsQuery(query);

			if (match === undefined) return [];

			const { results } = await db
				.prepare(
					`SELECT d.conversation_id, d.channel_id, d.thread_ts, d.pr_url, d.created_at,
					        snippet(conversation_digests_fts, -1, '[', ']', '…', 16) AS snippet
					 FROM conversation_digests_fts
					 JOIN conversation_digests d ON d.seq = conversation_digests_fts.rowid
					 WHERE conversation_digests_fts MATCH ?1 AND ${IN_SCOPE}
					 ORDER BY bm25(conversation_digests_fts)
					 LIMIT ?3`,
				)
				.bind(match, currentChannelId, limit)
				.all();

			return v.parse(v.array(hitRow), results).map((row) => ({
				conversationId: row.conversation_id,
				channelId: row.channel_id,
				threadTs: row.thread_ts,
				prUrl: row.pr_url,
				createdAt: row.created_at,
				snippet: row.snippet,
			}));
		},

		async forConversation(conversationId, currentChannelId) {
			const { results } = await db
				.prepare(
					`SELECT d.* FROM conversation_digests d
					 WHERE d.conversation_id = ?1 AND ${IN_SCOPE}
					 ORDER BY d.created_at, d.id`,
				)
				.bind(conversationId, currentChannelId)
				.all();

			return v.parse(v.array(digestRow), results).map((row) => ({
				id: row.id,
				conversationId: row.conversation_id,
				channelId: row.channel_id,
				channelVisibility: row.channel_visibility,
				threadTs: row.thread_ts,
				invokerUserIds: v.parse(v.array(v.string()), JSON.parse(row.invoker_user_ids)),
				requests: row.requests,
				replies: row.replies,
				toolsUsed: row.tools_used,
				prUrl: row.pr_url,
				createdAt: row.created_at,
			}));
		},

		async deleteOlderThan(cutoff) {
			const { meta } = await db
				.prepare('DELETE FROM conversation_digests WHERE created_at < ?1')
				.bind(cutoff.toISOString())
				.run();

			return meta.changes;
		},
	};
}
