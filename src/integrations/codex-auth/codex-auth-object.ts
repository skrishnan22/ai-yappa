import { DurableObject, type DurableObjectState, type SqlStorage } from 'cloudflare:workers';
import * as v from 'valibot';
import { type CodexAuthStatus, type CodexCredentialSeed, CodexAuthService } from './codex-auth.ts';
import type { CredentialRecords } from './durable-credential-store.ts';

type CodexAuthEnv = { CODEX_CREDENTIAL_KEY?: string };

// Owns the deployment's single Codex Credential (ADR 0020). Address the one
// instance with `env.CODEX_AUTH.getByName('default')`; a second instance would
// hold a second refresh lock and spend rotated refresh tokens twice.
export class CodexAuth extends DurableObject<CodexAuthEnv> {
	readonly #service: CodexAuthService;

	constructor(ctx: DurableObjectState, env: CodexAuthEnv) {
		super(ctx, env);

		this.#service = new CodexAuthService(
			sqlCredentialRecords(ctx.storage.sql),
			env.CODEX_CREDENTIAL_KEY,
		);
	}

	accessToken(): Promise<string | undefined> {
		return this.#service.accessToken();
	}

	status(): Promise<CodexAuthStatus> {
		return this.#service.status();
	}

	seed(credential: CodexCredentialSeed): Promise<CodexAuthStatus> {
		return this.#service.seed(credential);
	}
}

function sqlCredentialRecords(sql: SqlStorage): CredentialRecords {
	sql.exec(
		'CREATE TABLE IF NOT EXISTS credentials (provider_id TEXT PRIMARY KEY, record BLOB NOT NULL)',
	);

	return {
		get(providerId) {
			const [row] = sql
				.exec('SELECT record FROM credentials WHERE provider_id = ?', providerId)
				.toArray();

			return row?.record instanceof ArrayBuffer ? row.record : undefined;
		},
		set(providerId, record) {
			sql.exec(
				'INSERT INTO credentials (provider_id, record) VALUES (?, ?) ON CONFLICT (provider_id) DO UPDATE SET record = excluded.record',
				providerId,
				record,
			);
		},
		delete(providerId) {
			sql.exec('DELETE FROM credentials WHERE provider_id = ?', providerId);
		},
		providerIds() {
			const ids: string[] = [];

			for (const row of sql.exec('SELECT provider_id FROM credentials').toArray()) {
				if (v.is(v.string(), row.provider_id)) ids.push(row.provider_id);
			}

			return ids;
		},
	};
}
