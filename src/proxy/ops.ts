import { createHash } from 'node:crypto';
import {
	assertOpAllowed,
	canonicalRepo,
	verifyCapability,
	type CapabilityClaims,
	type CapabilityKeys,
	type ProxyOp,
} from './capabilities.ts';

export type AuditRecord = {
	ts: number;
	conversationId: string;
	submissionId: string;
	op: ProxyOp;
	paramsDigest: string;
	outcome: 'ok' | 'unauthorized' | 'invalid' | 'upstream';
	latencyMs: number;
};

export type AuditSink = {
	append(record: AuditRecord): void;
};

export type ProxyHandler = (args: {
	claims: CapabilityClaims;
	params: unknown;
}) => Promise<unknown>;

export type ProxyResult =
	| { ok: true; data: unknown }
	| { ok: false; error: { kind: AuditRecord['outcome']; message: string } };

export function digestParams(params: unknown): string {
	return createHash('sha256').update(canonicalJson(params)).digest('hex');
}

export async function executeProxy(args: {
	token: string;
	keys: CapabilityKeys;
	op: ProxyOp;
	params: unknown;
	now: number;
	handlers: Record<ProxyOp, ProxyHandler>;
	audit: AuditSink;
}): Promise<ProxyResult> {
	const started = Date.now();
	const digest = digestParams(args.params);
	const finish = (
		conversationId: string,
		submissionId: string,
		outcome: AuditRecord['outcome'],
		result: ProxyResult,
	): ProxyResult => {
		args.audit.append({
			ts: args.now,
			conversationId,
			submissionId,
			op: args.op,
			paramsDigest: digest,
			outcome,
			latencyMs: Math.max(0, Date.now() - started),
		});
		return result;
	};

	let claims: CapabilityClaims;
	try {
		claims = verifyCapability({ token: args.token, keys: args.keys, now: args.now });
	} catch (error) {
		const message = errorMessage(error);
		return finish('', '', 'unauthorized', { ok: false, error: { kind: 'unauthorized', message } });
	}

	if (!claims.allowedOps.includes(args.op)) {
		return finish(claims.conversationId, claims.submissionId, 'unauthorized', {
			ok: false,
			error: { kind: 'unauthorized', message: `op ${args.op} is not in token allowedOps` },
		});
	}

	try {
		assertOpAllowed({ submissionType: claims.submissionType, op: args.op });
	} catch (error) {
		return finish(claims.conversationId, claims.submissionId, 'unauthorized', {
			ok: false,
			error: { kind: 'unauthorized', message: errorMessage(error) },
		});
	}

	const repo = repoFromParams(args.params);
	if (repo === undefined) {
		return finish(claims.conversationId, claims.submissionId, 'invalid', {
			ok: false,
			error: { kind: 'invalid', message: 'params.repo is required' },
		});
	}
	if (repo !== claims.repo) {
		return finish(claims.conversationId, claims.submissionId, 'unauthorized', {
			ok: false,
			error: { kind: 'unauthorized', message: 'params.repo does not match capability repo' },
		});
	}

	try {
		const data = await args.handlers[args.op]({ claims, params: args.params });
		return finish(claims.conversationId, claims.submissionId, 'ok', { ok: true, data });
	} catch (error) {
		return finish(claims.conversationId, claims.submissionId, 'upstream', {
			ok: false,
			error: { kind: 'upstream', message: errorMessage(error) },
		});
	}
}

function repoFromParams(params: unknown): string | undefined {
	if (!isRecord(params) || typeof params.repo !== 'string') return undefined;
	try {
		return canonicalRepo(params.repo);
	} catch {
		return undefined;
	}
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
	}
	if (!isRecord(value)) {
		return JSON.stringify(null);
	}
	const keys = Object.keys(value).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'unknown error';
}
