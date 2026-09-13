import { createHash } from 'node:crypto';
import { emitTelemetry } from '../observability.ts';
import { assertOpAllowed, canonicalRepo, type ProxyOp, type SubmissionType } from './policy.ts';

export type OperationContext = {
	conversationId: string;
	submissionId: string;
	submissionType: SubmissionType;
	repo: string;
};

export type AuditRecord = {
	ts: number;
	conversationId: string;
	submissionId: string;
	repo: string | null;
	op: ProxyOp;
	paramsDigest: string;
	outcome: 'ok' | 'unauthorized' | 'invalid' | 'upstream';
	latencyMs: number;
};

export type AuditSink = {
	append(record: AuditRecord): void;
};

export type ProxyHandler = (args: {
	context: OperationContext;
	params: unknown;
}) => Promise<unknown>;

export type ProxyResult =
	| { ok: true; data: unknown }
	| { ok: false; error: { kind: AuditRecord['outcome']; message: string } };

export function digestParams(params: unknown): string {
	return createHash('sha256').update(canonicalJson(params)).digest('hex');
}

export async function executeProxy(args: {
	context: OperationContext;
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
		repo: string | null,
		outcome: AuditRecord['outcome'],
		result: ProxyResult,
	): ProxyResult => {
		const latencyMs = Math.max(0, Date.now() - started);
		const record: AuditRecord = {
			ts: args.now,
			conversationId,
			submissionId,
			repo,
			op: args.op,
			paramsDigest: digest,
			outcome,
			latencyMs,
		};
		args.audit.append(record);
		emitTelemetry({
			event_name: 'proxy.operation',
			outcome,
			conversation_id: conversationId,
			submission_id: submissionId,
			...(repo === null ? {} : { repo }),
			proxy_operation: args.op,
			params_digest: digest,
			duration_ms: latencyMs,
		});
		return result;
	};

	let context: OperationContext;
	try {
		context = { ...args.context, repo: canonicalRepo(args.context.repo) };
	} catch (error) {
		return finish(args.context.conversationId, args.context.submissionId, null, 'invalid', {
			ok: false,
			error: { kind: 'invalid', message: errorMessage(error) },
		});
	}

	try {
		assertOpAllowed({ submissionType: context.submissionType, op: args.op });
	} catch (error) {
		return finish(context.conversationId, context.submissionId, context.repo, 'unauthorized', {
			ok: false,
			error: { kind: 'unauthorized', message: errorMessage(error) },
		});
	}

	try {
		const data = await args.handlers[args.op]({ context, params: args.params });
		return finish(context.conversationId, context.submissionId, context.repo, 'ok', {
			ok: true,
			data,
		});
	} catch (error) {
		return finish(context.conversationId, context.submissionId, context.repo, 'upstream', {
			ok: false,
			error: { kind: 'upstream', message: errorMessage(error) },
		});
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
	const keys = Object.keys(value).toSorted();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'unknown error';
}
