import type { Credential, CredentialInfo } from '@earendil-works/pi-ai';
import type { CodexAuthStorage, LoginAlarm } from './codex-auth.ts';
import type { CredentialRecords } from './durable-credential-store.ts';
import type { PendingLogin, PendingLoginRecord } from './pending-login.ts';

// Test support: `CodexAuthService` storage in memory.

export class MemoryRecords implements CredentialRecords {
	readonly rows = new Map<string, { type: Credential['type']; record: string }>();

	get(providerId: string): string | undefined {
		return this.rows.get(providerId)?.record;
	}

	set(providerId: string, type: Credential['type'], record: string): void {
		this.rows.set(providerId, { type, record });
	}

	delete(providerId: string): void {
		this.rows.delete(providerId);
	}

	list(): CredentialInfo[] {
		return [...this.rows].map(([providerId, { type }]) => ({ providerId, type }));
	}
}

export class MemoryPendingLogin implements PendingLoginRecord {
	login: PendingLogin | undefined;

	get(): PendingLogin | undefined {
		return this.login;
	}

	set(login: PendingLogin): void {
		this.login = login;
	}

	clear(): void {
		this.login = undefined;
	}
}

export class MemoryAlarm implements LoginAlarm {
	at: number | undefined;

	async set(at: number): Promise<void> {
		this.at = at;
	}

	async clear(): Promise<void> {
		this.at = undefined;
	}
}

export type MemoryStorage = CodexAuthStorage & {
	credentials: MemoryRecords;
	pendingLogin: MemoryPendingLogin;
	alarm: MemoryAlarm;
};

export function memoryStorage(credentials = new MemoryRecords()): MemoryStorage {
	return { credentials, pendingLogin: new MemoryPendingLogin(), alarm: new MemoryAlarm() };
}
