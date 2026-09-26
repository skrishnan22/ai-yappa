import type { DurableObjectNamespace, DurableObjectStub } from 'cloudflare:workers';
import type { CodexAuth } from './codex-auth-object.ts';

export type CodexAuthBinding = { readonly CODEX_AUTH: DurableObjectNamespace<CodexAuth> };

export type CodexAuthStub = DurableObjectStub<CodexAuth>;

// The deployment's single `CodexAuth` instance (ADR 0020). Every caller must
// use this name; a second instance would hold a second refresh lock.
export function codexAuth(env: CodexAuthBinding): CodexAuthStub {
	return env.CODEX_AUTH.getByName('default');
}
