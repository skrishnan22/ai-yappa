import { DurableObject, type DurableObjectState } from 'cloudflare:workers';
import {
	type CodexAuthStatus,
	type CodexConnectResult,
	type CodexCredentialSeed,
	type CodexDisconnectResult,
	CodexAuthService,
} from './codex-auth.ts';
import { sqlPendingLogin } from './pending-login.ts';
import { sqlCredentialRecords } from './sql-credential-records.ts';

type CodexAuthEnv = { CODEX_CREDENTIAL_KEY?: string };

// Owns the deployment's single Codex Credential (ADR 0020). Address the one
// instance through `codexAuth(env)` in codex-auth-binding.ts.
export class CodexAuth extends DurableObject<CodexAuthEnv> {
	readonly #service: CodexAuthService;

	constructor(ctx: DurableObjectState, env: CodexAuthEnv) {
		super(ctx, env);

		this.#service = new CodexAuthService(
			{
				credentials: sqlCredentialRecords(ctx.storage.sql),
				pendingLogin: sqlPendingLogin(ctx.storage.sql),
				alarm: {
					set: (at) => ctx.storage.setAlarm(at),
					clear: () => ctx.storage.deleteAlarm(),
				},
			},
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

	// Not `connect`: a stub's own `connect()` opens a TCP socket and would
	// shadow an RPC method of that name.
	startLogin(responseUrl: string): Promise<CodexConnectResult> {
		return this.#service.startLogin(responseUrl);
	}

	disconnect(): Promise<CodexDisconnectResult> {
		return this.#service.disconnect();
	}

	override alarm(): Promise<void> {
		return this.#service.pollLogin();
	}
}
