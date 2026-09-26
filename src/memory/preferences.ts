import * as v from 'valibot';
import type { Clock, D1Database } from './d1.ts';

export const PREFERENCE_LIMIT = 20;

export const PREFERENCE_MAX_CHARS = 300;

export type Preference = { id: string; content: string };

export type RememberResult =
	| { ok: true; id: string }
	| { ok: false; reason: 'empty' | 'too_long' | 'limit' };

export type PreferenceStore = {
	list(subjectUserId: string): Promise<Preference[]>;
	add(subjectUserId: string, content: string, conversationId: string): Promise<RememberResult>;
	forget(subjectUserId: string, id: string): Promise<boolean>;
};

const preferenceRow = v.object({ id: v.string(), content: v.string() });

const idRow = v.object({ id: v.string() });

// Subject is always the author (source_user_id = subject_user_id): a person can
// only save preferences about themselves. Callers bind the subject from trusted
// delivery state, never from model input.
export function createPreferenceStore(db: D1Database, clock: Clock): PreferenceStore {
	return {
		async list(subjectUserId) {
			const { results } = await db
				.prepare(
					'SELECT id, content FROM memories WHERE subject_user_id = ?1 AND deleted_at IS NULL ORDER BY created_at, id',
				)
				.bind(subjectUserId)
				.all();

			return v.parse(v.array(preferenceRow), results);
		},

		async add(subjectUserId, content, conversationId) {
			const text = content.trim();

			if (text === '') return { ok: false, reason: 'empty' };

			if (text.length > PREFERENCE_MAX_CHARS) return { ok: false, reason: 'too_long' };

			const existing = await db
				.prepare(
					'SELECT id FROM memories WHERE subject_user_id = ?1 AND content = ?2 AND deleted_at IS NULL',
				)
				.bind(subjectUserId, text)
				.all();

			const [duplicate] = v.parse(v.array(idRow), existing.results);

			if (duplicate) return { ok: true, id: duplicate.id };

			const id = clock.newId();
			const now = clock.now().toISOString();

			// Count and insert in one statement so concurrent threads cannot overshoot the cap.
			const { meta } = await db
				.prepare(
					`INSERT INTO memories
					   (id, subject_user_id, content, source_conversation_id, source_user_id, created_at, updated_at)
					 SELECT ?1, ?2, ?3, ?4, ?2, ?5, ?5
					 WHERE (SELECT COUNT(*) FROM memories WHERE subject_user_id = ?2 AND deleted_at IS NULL) < ?6`,
				)
				.bind(id, subjectUserId, text, conversationId, now, PREFERENCE_LIMIT)
				.run();

			if (meta.changes === 0) return { ok: false, reason: 'limit' };

			return { ok: true, id };
		},

		async forget(subjectUserId, id) {
			const now = clock.now().toISOString();

			const { meta } = await db
				.prepare(
					'UPDATE memories SET content = NULL, deleted_at = ?3, updated_at = ?3 WHERE id = ?1 AND subject_user_id = ?2 AND deleted_at IS NULL',
				)
				.bind(id, subjectUserId, now)
				.run();

			return meta.changes > 0;
		},
	};
}
