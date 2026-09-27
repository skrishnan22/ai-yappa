import { DurableObject, type DurableObjectState } from 'cloudflare:workers';
import { errorMessage } from '../../json.ts';
import {
	type CodexAuthStatus,
	type CodexConnectResult,
	type CodexCredentialSeed,
	type CodexDisconnectResult,
	CodexAuthService,
} from './codex-auth.ts';
import { sqlNeedsLogin } from './needs-login.ts';
import { sqlPendingLogin } from './pending-login.ts';
import { sqlCredentialRecords } from './sql-credential-records.ts';

// Worker secrets reach every Durable Object class in the Worker through `env`.
type CodexAuthEnv = { CODEX_CREDENTIAL_KEY?: string; SLACK_BOT_TOKEN?: string };

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
				needsLogin: sqlNeedsLogin(ctx.storage.sql),
				alarm: {
					set: (at) => ctx.storage.setAlarm(at),
					clear: () => ctx.storage.deleteAlarm(),
				},
			},
			env.CODEX_CREDENTIAL_KEY,
			env.SLACK_BOT_TOKEN,
		);

		// A credential stored before proactive refresh existed has no alarm.
		void ctx.blockConcurrencyWhile(async () => {
			try {
				if ((await ctx.storage.getAlarm()) === null) await this.#service.scheduleAlarm();
			} catch (error) {
				console.warn(`[codex-auth] Could not schedule the alarm: ${errorMessage(error)}`);
			}
		});
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
		return this.#service.alarm();
	}
}
