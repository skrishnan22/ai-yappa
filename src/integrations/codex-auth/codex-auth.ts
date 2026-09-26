import { createModels, type Models } from '@earendil-works/pi-ai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import * as v from 'valibot';
import { errorMessage } from '../../json.ts';
import { credentialKey } from './credential-cipher.ts';
import {
	type CodexOAuthCredential,
	DEVICE_LOGIN_TIMEOUT_MS,
	DEVICE_VERIFICATION_URL,
	exchangeDeviceCode,
	pollDeviceCode,
	requestDeviceCode,
	revokeRefreshToken,
	SLOW_DOWN_INCREMENT_MS,
} from './device-code.ts';
import { type CredentialRecords, DurableCredentialStore } from './durable-credential-store.ts';
import type { PendingLogin, PendingLoginRecord } from './pending-login.ts';

// pi otherwise loads OAuth flows through a variable-path dynamic import that
// the Worker bundle cannot follow, so refresh would fail at runtime.
registerBunOAuthFlows();

const CODEX_PROVIDER_ID = 'openai-codex';

const SLACK_REQUEST_TIMEOUT_MS = 10_000;

const nonEmpty = v.pipe(v.string(), v.minLength(1));

const seedSchema = v.object({
	access: nonEmpty,
	refresh: nonEmpty,
	expires: v.number(),
	accountId: nonEmpty,
});

const storedCodexCredentialSchema = v.looseObject({
	type: v.literal('oauth'),
	expires: v.number(),
	accountId: v.string(),
});

export type CodexCredentialSeed = v.InferInput<typeof seedSchema>;

// The object's single alarm, which drives device-code polling.
export interface LoginAlarm {
	set(at: number): Promise<void>;
	clear(): Promise<void>;
}

export type CodexAuthStorage = {
	credentials: CredentialRecords;
	pendingLogin: PendingLoginRecord;
	alarm: LoginAlarm;
};

type ConnectedStatus = { state: 'connected'; expires: number; accountId: string };

// `pending_login` omits the user code: status is shown more widely than
// connect, and whoever holds the code can bind the bot to their account.
export type CodexAuthStatus =
	| ConnectedStatus
	| { state: 'pending_login'; expires: number }
	| { state: 'disconnected' };

export type CodexConnectResult =
	| ConnectedStatus
	| { state: 'pending_login'; expires: number; userCode: string; verificationUrl: string };

// `unreadable`: the stored row no longer decrypted, so it was deleted without
// revoking its refresh token.
export type CodexDisconnectResult = {
	revocation: 'revoked' | 'failed' | 'unreadable' | 'none';
	cancelledLogin: boolean;
};

// What Slack ingress needs from `CodexAuth`: the Durable Object stub in the
// Worker, a `CodexAuthService` in tests.
export type CodexAuthControl = Pick<CodexAuthService, 'status' | 'startLogin' | 'disconnect'>;

// Everything `CodexAuth` does, minus the Durable Object shell, so it runs
// under Node in tests. Only access tokens leave this class.
export class CodexAuthService {
	readonly #store: DurableCredentialStore;

	readonly #models: Models;

	readonly #pendingLogin: PendingLoginRecord;

	readonly #alarm: LoginAlarm;

	readonly #credentialKey: string | undefined;

	// Serializes every change to the pending login and the credential a login
	// produces: `startLogin`, `disconnect`, and each poll's outcome. Requests
	// that only read the pending login (a poll, the code exchange) run outside
	// it, and their results apply only if that login is still pending.
	#loginChain: Promise<void> = Promise.resolve();

	constructor(storage: CodexAuthStorage, key: string | undefined) {
		this.#store = new DurableCredentialStore(storage.credentials, key);
		this.#pendingLogin = storage.pendingLogin;
		this.#alarm = storage.alarm;
		this.#credentialKey = key;
		const models = createModels({ credentials: this.#store });

		models.setProvider(openaiCodexProvider());
		this.#models = models;
	}

	async accessToken(): Promise<string | undefined> {
		const result = await this.#models.getAuth(CODEX_PROVIDER_ID);

		return result?.auth.apiKey;
	}

	async status(): Promise<CodexAuthStatus> {
		const credential = await this.#store.read(CODEX_PROVIDER_ID);

		if (credential !== undefined) {
			const { expires, accountId } = v.parse(storedCodexCredentialSchema, credential);

			return { state: 'connected', expires, accountId };
		}

		const login = this.#pendingLogin.get();

		if (login !== undefined) return { state: 'pending_login', expires: login.deadline };

		return { state: 'disconnected' };
	}

	async seed(credential: CodexCredentialSeed): Promise<CodexAuthStatus> {
		const { access, refresh, expires, accountId } = v.parse(seedSchema, credential);

		await this.#store.modify(CODEX_PROVIDER_ID, async () => ({
			type: 'oauth',
			access,
			refresh,
			expires,
			accountId,
		}));

		return this.status();
	}

	// Starts a device-code login, replacing any pending one. An existing
	// credential is kept: replacing it would strand a live refresh token, so
	// the admin disconnects (and revokes) first.
	startLogin(responseUrl: string): Promise<CodexConnectResult> {
		return this.#withLoginLock(async () => {
			// Fail now rather than after the admin approves the login.
			credentialKey(this.#credentialKey);
			const status = await this.status();

			if (status.state === 'connected') return status;

			const code = await requestDeviceCode();

			const login: PendingLogin = {
				...code,
				deadline: Date.now() + DEVICE_LOGIN_TIMEOUT_MS,
				responseUrl,
			};

			this.#pendingLogin.set(login);
			await this.#schedulePoll(login);

			return {
				state: 'pending_login',
				expires: login.deadline,
				userCode: code.userCode,
				verificationUrl: DEVICE_VERIFICATION_URL,
			};
		});
	}

	// One poll per alarm. pi's in-process sleep loop would keep the object
	// awake for up to 15 minutes; an alarm lets it sleep between polls and
	// resume after a restart.
	async pollLogin(): Promise<void> {
		const login = this.#pendingLogin.get();

		if (login === undefined) return;

		if (Date.now() >= login.deadline) {
			await this.#settle(
				login,
				'The ChatGPT login code expired before it was approved. Run `/aiyappa openai connect` for a new code.',
			);

			return;
		}

		const poll = await pollDeviceCode(login);

		switch (poll.kind) {
			case 'pending':
				await this.#pollAgain(login, login.intervalMs);

				return;
			case 'slow_down':
				await this.#pollAgain(login, login.intervalMs + SLOW_DOWN_INCREMENT_MS);

				return;
			case 'failed':
				await this.#settle(login, `ChatGPT login failed: ${poll.message}`);

				return;
			case 'approved':
				await this.#completeLogin(login, poll.authorizationCode, poll.codeVerifier);

				return;
			default: {
				const _exhaustive: never = poll;

				return _exhaustive;
			}
		}
	}

	// Cancels a pending login, revokes the stored refresh token, and deletes
	// the credential. The credential is deleted even when revocation fails.
	// A login still requesting its code finishes first, then is cancelled.
	async disconnect(): Promise<CodexDisconnectResult> {
		const { login, revocation } = await this.#withLoginLock(async () => {
			const pending = this.#pendingLogin.get();

			if (pending !== undefined) {
				this.#pendingLogin.clear();
				await this.#alarm.clear();
			}

			let revoked: CodexDisconnectResult['revocation'] = 'none';

			const outcome = await this.#store.revokeAndDelete(CODEX_PROVIDER_ID, async (stored) => {
				if (stored.type !== 'oauth') return;
				const ok = await revokeRefreshToken(stored.refresh);

				revoked = ok ? 'revoked' : 'failed';
			});

			if (outcome === 'unreadable') revoked = 'unreadable';

			return { login: pending, revocation: revoked };
		});

		if (login !== undefined) {
			await editSlackResponse(login.responseUrl, 'ChatGPT login cancelled by a disconnect.');
		}

		return { revocation, cancelledLogin: login !== undefined };
	}

	async #completeLogin(
		login: PendingLogin,
		authorizationCode: string,
		codeVerifier: string,
	): Promise<void> {
		let credential: CodexOAuthCredential;

		try {
			credential = await exchangeDeviceCode(authorizationCode, codeVerifier);
		} catch (error) {
			await this.#settle(login, `ChatGPT login failed: ${errorMessage(error)}`);

			return;
		}

		const stored = await this.#withLoginLock(async () => {
			if (!this.#isPending(login)) return false;
			await this.#store.modify(CODEX_PROVIDER_ID, async () => credential);
			this.#pendingLogin.clear();

			return true;
		});

		// A disconnect or a newer connect during the exchange wins; do not strand
		// the new token.
		if (!stored) {
			await revokeRefreshToken(credential.refresh);

			return;
		}

		await editSlackResponse(
			login.responseUrl,
			`Connected ChatGPT account \`${credential.accountId}\`. New Coworker runs use the ChatGPT subscription.`,
		);
	}

	#isPending(login: PendingLogin): boolean {
		return this.#pendingLogin.get()?.deviceAuthId === login.deviceAuthId;
	}

	// Polls `login` again after `intervalMs`, unless a connect or disconnect
	// replaced it during the poll.
	#pollAgain(login: PendingLogin, intervalMs: number): Promise<void> {
		return this.#withLoginLock(async () => {
			if (!this.#isPending(login)) return;
			const next = { ...login, intervalMs };

			this.#pendingLogin.set(next);
			await this.#schedulePoll(next);
		});
	}

	// The last alarm lands on the deadline, where `pollLogin` expires the login.
	#schedulePoll(login: PendingLogin): Promise<void> {
		return this.#alarm.set(Math.min(Date.now() + login.intervalMs, login.deadline));
	}

	// Ends `login` and tells the admin, unless it was already replaced.
	async #settle(login: PendingLogin, text: string): Promise<void> {
		const settled = await this.#withLoginLock(async () => {
			if (!this.#isPending(login)) return false;
			this.#pendingLogin.clear();

			return true;
		});

		if (settled) await editSlackResponse(login.responseUrl, text);
	}

	#withLoginLock<T>(task: () => Promise<T>): Promise<T> {
		const queued = this.#loginChain.then(task);

		this.#loginChain = queued.then(
			() => undefined,
			() => undefined,
		);

		return queued;
	}
}

// Replaces the admin's ephemeral `/aiyappa openai connect` response. Best
// effort: the outcome is already stored, and `status` reports it.
async function editSlackResponse(responseUrl: string, text: string): Promise<void> {
	try {
		const response = await fetch(responseUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ response_type: 'ephemeral', replace_original: true, text }),
			signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
		});

		if (!response.ok)
			console.warn(`[codex-auth] Slack response_url returned HTTP ${response.status}`);
	} catch {
		console.warn('[codex-auth] Slack response_url request failed');
	}
}
