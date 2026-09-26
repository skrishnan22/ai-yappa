import { DurableObject, type DurableObjectState } from 'cloudflare:workers';
import { type CodexAuthStatus, type CodexCredentialSeed, CodexAuthService } from './codex-auth.ts';
import { sqlCredentialRecords } from './sql-credential-records.ts';

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
