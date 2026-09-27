import {
	createModels,
	createProvider,
	type Models,
	ModelsError,
	type OAuthAuth,
	type OAuthCredential,
	type Provider,
} from '@earendil-works/pi-ai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { decodeJwt } from 'jose';
import * as v from 'valibot';
import { codexAdminIds } from '../../config.ts';
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
import {
	type NeedsLogin,
	type NeedsLoginReason,
	type NeedsLoginRecord,
	permanentRefreshFailure,
} from './needs-login.ts';
import type { PendingLogin, PendingLoginRecord } from './pending-login.ts';

// pi otherwise loads OAuth flows through a variable-path dynamic import that
// the Worker bundle cannot follow, so refresh would fail at runtime.
registerBunOAuthFlows();

const CODEX_PROVIDER_ID = 'openai-codex';

const SLACK_REQUEST_TIMEOUT_MS = 10_000;

// ADR 0020: refresh about a day before expiry, so user requests rarely pay
// for the refresh. A token that lives under two days refreshes at half-life.
const PROACTIVE_REFRESH_AHEAD_MS = 24 * 60 * 60 * 1000;

// Spacing between proactive attempts after a transient refresh failure.
const PROACTIVE_REFRESH_RETRY_MS = 15 * 60 * 1000;

const jwtLifetimeSchema = v.looseObject({ iat: v.number(), exp: v.number() });

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

// The object's single alarm. It serves both device-code polling and
// proactive refresh; `CodexAuthService` sets it to whichever is due first.
export interface CodexAuthAlarm {
	set(at: number): Promise<void>;
	clear(): Promise<void>;
}

export type CodexAuthStorage = {
	credentials: CredentialRecords;
	pendingLogin: PendingLoginRecord;
	needsLogin: NeedsLoginRecord;
	alarm: CodexAuthAlarm;
};

type ConnectedStatus = { state: 'connected'; expires: number; accountId: string };

// `pending_login` omits the user code: status is shown more widely than
// connect, and whoever holds the code can bind the bot to their account.
export type CodexAuthStatus =
	| ConnectedStatus
	| { state: 'pending_login'; expires: number }
	| ({ state: 'needs_login' } & NeedsLogin)
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

// A finished login's final message, sent after the login lock is released.
type LoginEnd = { responseUrl: string; text: string };

// What Slack ingress needs from `CodexAuth`: the Durable Object stub in the
// Worker, a `CodexAuthService` in tests.
export type CodexAuthControl = Pick<CodexAuthService, 'status' | 'startLogin' | 'disconnect'>;

// Thrown from inside pi's locked refresh once the credential needs a new
// login, so queued requests stop without calling OpenAI. `transitioned` marks
// the one refresh that moved the connection into `needs_login`.
class CodexNeedsLoginError extends Error {
	readonly transitioned: boolean;

	readonly reason: NeedsLoginReason;

	constructor(needsLogin: NeedsLogin, transitioned: boolean) {
		super(`The ChatGPT login needs renewal (${needsLogin.reason})`);
		this.name = 'CodexNeedsLoginError';
		this.reason = needsLogin.reason;
		this.transitioned = transitioned;
	}
}

// pi wraps whatever the refresh throws in a `ModelsError` with it as `cause`.
function isNeedsLoginFailure(
	error: unknown,
): error is ModelsError & { cause: CodexNeedsLoginError } {
	return error instanceof ModelsError && error.cause instanceof CodexNeedsLoginError;
}

// Everything `CodexAuth` does, minus the Durable Object shell, so it runs
// under Node in tests. Only access tokens leave this class.
export class CodexAuthService {
	readonly #store: DurableCredentialStore;

	readonly #models: Models;

	readonly #pendingLogin: PendingLoginRecord;

	readonly #needsLogin: NeedsLoginRecord;

	readonly #alarm: CodexAuthAlarm;

	readonly #credentialKey: string | undefined;

	readonly #slackBotToken: string | undefined;

	// Serializes `startLogin`, `disconnect`, and each poll, so none sees
	// another's half-finished change to the pending login or the credential.
	// Slack edits happen after release.
	#loginChain: Promise<void> = Promise.resolve();

	// In memory on purpose: a restart allows one immediate retry.
	#refreshRetryAt = 0;

	constructor(storage: CodexAuthStorage, key: string | undefined, slackBotToken?: string) {
		this.#store = new DurableCredentialStore(storage.credentials, key);
		this.#pendingLogin = storage.pendingLogin;
		this.#needsLogin = storage.needsLogin;
		this.#alarm = storage.alarm;
		this.#credentialKey = key;
		this.#slackBotToken = slackBotToken;
		const models = createModels({ credentials: this.#store });

		models.setProvider(this.#codexProvider());
		this.#models = models;
	}

	async accessToken(): Promise<string | undefined> {
		if (this.#needsLogin.get() !== undefined) return undefined;

		try {
			const result = await this.#models.getAuth(CODEX_PROVIDER_ID);

			return result?.auth.apiKey;
		} catch (error) {
			if (!isNeedsLoginFailure(error)) throw error;
			await this.#enteredNeedsLogin(error.cause);

			return undefined;
		}
	}

	async status(): Promise<CodexAuthStatus> {
		const credential = await this.#store.read(CODEX_PROVIDER_ID);
		const needsLogin = this.#needsLogin.get();

		if (credential && needsLogin === undefined) {
			const { expires, accountId } = v.parse(storedCodexCredentialSchema, credential);

			return { state: 'connected', expires, accountId };
		}

		const login = this.#pendingLogin.get();

		if (login) return { state: 'pending_login', expires: login.deadline };

		if (needsLogin !== undefined) return { state: 'needs_login', ...needsLogin };

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
		this.#replacedCredential();
		await this.scheduleAlarm();

		return this.status();
	}

	// Starts a device-code login, replacing any pending one. A working
	// credential is kept: replacing it would strand a live refresh token, so
	// the admin disconnects (and revokes) first. A `needs_login` credential is
	// dead, and the approved login replaces it.
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
				pollAt: Date.now() + code.intervalMs,
				responseUrl,
			};

			this.#pendingLogin.set(login);
			await this.scheduleAlarm();

			return {
				state: 'pending_login',
				expires: login.deadline,
				userCode: code.userCode,
				verificationUrl: DEVICE_VERIFICATION_URL,
			};
		});
	}

	// Runs whatever is due, then sets the alarm to the next due time. Each task
	// catches its own failure so one cannot starve the other, and a failed
	// task is pushed back so the alarm cannot spin on it.
	async alarm(): Promise<void> {
		const login = this.#pendingLogin.get();

		if (login !== undefined && login.pollAt <= Date.now()) {
			try {
				await this.pollLogin();
			} catch (error) {
				console.warn(`[codex-auth] Login poll failed: ${errorMessage(error)}`);

				if (this.#isPending(login)) this.#deferPoll(login);
			}
		}

		const refreshAt = await this.#refreshAt();

		if (refreshAt !== undefined && refreshAt <= Date.now()) await this.#refreshAhead();

		await this.scheduleAlarm();
	}

	// Sets the alarm to the earliest due work: the next login poll or the next
	// proactive refresh. Every state change calls this, so neither schedule
	// clobbers the other. No work clears the alarm.
	async scheduleAlarm(): Promise<void> {
		const refreshAt = await this.#refreshAt();
		// Read after the await, so a login started meanwhile is seen. A refresh
		// time gone stale during the await only fires an alarm that re-derives.
		const pollAt = this.#pendingLogin.get()?.pollAt;
		const due = [refreshAt, pollAt].filter((at) => at !== undefined);

		if (due.length === 0) {
			await this.#alarm.clear();

			return;
		}

		await this.#alarm.set(Math.min(...due));
	}

	// One poll per alarm. pi's in-process sleep loop would keep the object
	// awake for up to 15 minutes; an alarm lets it sleep between polls and
	// resume after a restart. The whole poll holds the login lock, so a
	// connect or disconnect waits for it rather than racing it.
	async pollLogin(): Promise<void> {
		const ended = await this.#withLoginLock(() => this.#pollOnce());

		if (ended) await editSlackResponse(ended.responseUrl, ended.text);
	}

	// Cancels a pending login, revokes the stored refresh token, and deletes
	// the credential. The credential is deleted even when revocation fails.
	// Clears `needs_login`. A login still requesting its code, or a poll in
	// flight, finishes first.
	async disconnect(): Promise<CodexDisconnectResult> {
		const { login, revocation } = await this.#withLoginLock(async () => {
			const pending = this.#pendingLogin.get();

			if (pending) this.#pendingLogin.clear();

			let revoked: CodexDisconnectResult['revocation'] = 'none';

			const outcome = await this.#store.revokeAndDelete(CODEX_PROVIDER_ID, async (stored) => {
				if (stored.type !== 'oauth') return;
				const ok = await revokeRefreshToken(stored.refresh);

				revoked = ok ? 'revoked' : 'failed';
			});

			if (outcome === 'unreadable') revoked = 'unreadable';
			this.#needsLogin.clear();
			await this.scheduleAlarm();

			return { login: pending, revocation: revoked };
		});

		if (login) {
			await editSlackResponse(login.responseUrl, 'ChatGPT login cancelled by a disconnect.');
		}

		return { revocation, cancelledLogin: login !== undefined };
	}

	// pi's Codex provider with its OAuth refresh wrapped. The wrapper runs
	// inside pi's locked `modify`, so it records `needs_login` before the lock
	// releases, and requests queued behind it fail without calling OpenAI.
	#codexProvider(): Provider {
		const catalog = openaiCodexProvider();
		const oauth = catalog.auth.oauth;

		if (oauth === undefined) throw new Error('pi openai-codex provider has no OAuth auth');

		return createProvider({
			id: catalog.id,
			name: catalog.name,
			baseUrl: catalog.baseUrl,
			auth: {
				oauth: {
					...oauth,
					refresh: (credential, signal) => this.#refresh(oauth, credential, signal),
				},
			},
			models: catalog.getModels(),
			// Never streams: this `Models` only resolves auth.
			api: {
				stream: () => {
					throw new Error('CodexAuth does not stream');
				},
				streamSimple: () => {
					throw new Error('CodexAuth does not stream');
				},
			},
		});
	}

	async #refresh(
		oauth: OAuthAuth,
		credential: OAuthCredential,
		signal: AbortSignal,
	): Promise<OAuthCredential> {
		const current = this.#needsLogin.get();

		if (current !== undefined) throw new CodexNeedsLoginError(current, false);

		try {
			return await oauth.refresh(credential, signal);
		} catch (error) {
			const reason = error instanceof Error ? permanentRefreshFailure(error) : undefined;

			// Network failures and 5xx keep the credential for the next attempt.
			if (reason === undefined) throw error;
			const needsLogin = { reason, since: Date.now() };

			this.#needsLogin.set(needsLogin);
			throw new CodexNeedsLoginError(needsLogin, true);
		}
	}

	// Only the refresh that made the transition stops the refresh alarm and
	// DMs the admins, so they hear about it once.
	async #enteredNeedsLogin(failure: CodexNeedsLoginError): Promise<void> {
		if (!failure.transitioned) return;
		console.warn(`[codex-auth] ChatGPT login needs renewal: ${failure.reason}`);
		await this.scheduleAlarm();
		await notifyCodexAdmins(this.#slackBotToken, needsLoginMessage(failure.reason));
	}

	// Forces a refresh through pi, under the same lock as request refreshes:
	// the minimum validity is just past the stored expiry. pi re-checks under
	// the lock, so a refresh that landed first makes this a no-op.
	async #refreshAhead(): Promise<void> {
		try {
			const credential = await this.#store.read(CODEX_PROVIDER_ID);

			if (credential?.type !== 'oauth' || this.#needsLogin.get() !== undefined) return;
			const remainingMs = Math.max(0, credential.expires - Date.now());

			await this.#models.getAuth(CODEX_PROVIDER_ID, { minOAuthValidityMs: remainingMs + 1 });
		} catch (error) {
			if (isNeedsLoginFailure(error)) {
				await this.#enteredNeedsLogin(error.cause);

				return;
			}

			this.#refreshRetryAt = Date.now() + PROACTIVE_REFRESH_RETRY_MS;
			console.warn(`[codex-auth] Proactive refresh failed: ${errorMessage(error)}`);
		}
	}

	// When the next proactive refresh is due, or undefined when there is
	// nothing to refresh.
	async #refreshAt(): Promise<number | undefined> {
		if (this.#needsLogin.get() !== undefined) return undefined;
		const credential = await this.#store.read(CODEX_PROVIDER_ID);

		if (credential?.type !== 'oauth') return undefined;

		return Math.max(proactiveRefreshAt(credential), this.#refreshRetryAt);
	}

	// A new credential is live: forget `needs_login` and any retry spacing.
	#replacedCredential(): void {
		this.#needsLogin.clear();
		this.#refreshRetryAt = 0;
	}

	// Returns the admin's Slack update when the login ends.
	async #pollOnce(): Promise<LoginEnd | undefined> {
		const login = this.#pendingLogin.get();

		if (!login) return undefined;

		if (Date.now() >= login.deadline) {
			return this.#endLogin(
				login,
				'The ChatGPT login code expired before it was approved. Run `/aiyappa openai connect` for a new code.',
			);
		}

		const poll = await pollDeviceCode(login);

		switch (poll.kind) {
			case 'pending':
				await this.#schedulePoll(login);

				return undefined;
			case 'slow_down': {
				const slower = { ...login, intervalMs: login.intervalMs + SLOW_DOWN_INCREMENT_MS };

				await this.#schedulePoll(slower);

				return undefined;
			}

			case 'failed':
				return this.#endLogin(login, `ChatGPT login failed: ${poll.message}`);
			case 'approved':
				return this.#completeLogin(login, poll.authorizationCode, poll.codeVerifier);
			default: {
				const _exhaustive: never = poll;

				return _exhaustive;
			}
		}
	}

	async #completeLogin(
		login: PendingLogin,
		authorizationCode: string,
		codeVerifier: string,
	): Promise<LoginEnd> {
		let credential: CodexOAuthCredential;

		try {
			credential = await exchangeDeviceCode(authorizationCode, codeVerifier);
		} catch (error) {
			return this.#endLogin(login, `ChatGPT login failed: ${errorMessage(error)}`);
		}

		await this.#store.modify(CODEX_PROVIDER_ID, async () => credential);
		this.#replacedCredential();

		return this.#endLogin(
			login,
			`Connected ChatGPT account \`${credential.accountId}\`. New Coworker runs use the ChatGPT subscription.`,
		);
	}

	#isPending(login: PendingLogin): boolean {
		return this.#pendingLogin.get()?.deviceAuthId === login.deviceAuthId;
	}

	// The last poll lands on the deadline, where `#pollOnce` expires the login.
	#schedulePoll(login: PendingLogin): Promise<void> {
		this.#deferPoll(login);

		return this.scheduleAlarm();
	}

	#deferPoll(login: PendingLogin): void {
		this.#pendingLogin.set({
			...login,
			pollAt: Math.min(Date.now() + login.intervalMs, login.deadline),
		});
	}

	async #endLogin(login: PendingLogin, text: string): Promise<LoginEnd> {
		this.#pendingLogin.clear();
		await this.scheduleAlarm();

		return { responseUrl: login.responseUrl, text };
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

function proactiveRefreshAt(credential: OAuthCredential): number {
	const lifetimeMs = accessTokenLifetimeMs(credential.access);

	const aheadMs =
		lifetimeMs === undefined
			? PROACTIVE_REFRESH_AHEAD_MS
			: Math.min(PROACTIVE_REFRESH_AHEAD_MS, lifetimeMs / 2);

	return credential.expires - aheadMs;
}

// From the access token's `iat` and `exp`; undefined when it carries neither.
function accessTokenLifetimeMs(access: string): number | undefined {
	try {
		const claims = v.safeParse(jwtLifetimeSchema, decodeJwt(access));

		return claims.success ? (claims.output.exp - claims.output.iat) * 1000 : undefined;
	} catch {
		return undefined;
	}
}

function needsLoginMessage(reason: NeedsLoginReason): string {
	return `Coworker's ChatGPT login stopped working: OpenAI rejected its refresh token (\`${reason}\`). Coworker uses OpenCode Go until a Codex admin runs \`/aiyappa openai connect\`.`;
}

// DMs every Codex admin through the bot. Best effort: a failure warns and
// never reaches the model call that found the dead refresh token.
async function notifyCodexAdmins(token: string | undefined, text: string): Promise<void> {
	if (token === undefined || token === '') {
		console.warn('[codex-auth] SLACK_BOT_TOKEN is not set; Codex admins were not notified');

		return;
	}

	await Promise.all([...codexAdminIds].map((userId) => postDirectMessage(token, userId, text)));
}

const slackPostResultSchema = v.looseObject({ ok: v.boolean(), error: v.optional(v.string()) });

// A user id as `channel` posts to the app's DM with that user.
async function postDirectMessage(token: string, userId: string, text: string): Promise<void> {
	try {
		const response = await fetch('https://slack.com/api/chat.postMessage', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json; charset=utf-8',
			},
			body: JSON.stringify({ channel: userId, text }),
			signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
		});

		const body = await response.json();
		const result = v.safeParse(slackPostResultSchema, body);

		if (!result.success || !result.output.ok) {
			const detail = result.success ? result.output.error : `HTTP ${response.status}`;

			console.warn(`[codex-auth] Slack DM to a Codex admin failed: ${detail ?? 'unknown error'}`);
		}
	} catch {
		console.warn('[codex-auth] Slack DM to a Codex admin failed');
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
