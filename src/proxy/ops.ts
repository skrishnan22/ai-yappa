import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { errorMessage, jsonObjectSchema, jsonValueSchema, type JsonValue } from '../json.ts';
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
	params: JsonValue;
}) => Promise<JsonValue>;

export type ProxyResult =
	| { ok: true; data: JsonValue }
	| { ok: false; error: { kind: AuditRecord['outcome']; message: string } };

export function digestParams(params: JsonValue): string {
	return createHash('sha256').update(canonicalJson(params)).digest('hex');
}

export async function executeProxy(args: {
	context: OperationContext;
	op: ProxyOp;
	params: JsonValue;
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
		args.audit.append({
			ts: args.now,
			conversationId,
			submissionId,
			repo,
			op: args.op,
			paramsDigest: digest,
			outcome,
			latencyMs: Math.max(0, Date.now() - started),
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

function canonicalJson(value: JsonValue): string {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
	}

	if (v.is(jsonObjectSchema, value)) {
		const keys = Object.keys(value).toSorted();

		return `{${keys
			.flatMap((key) => {
				const nested = value[key];

				return nested === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(nested)}`];
			})
			.join(',')}}`;
	}

	if (!v.is(jsonValueSchema, value)) return JSON.stringify(null);

	return JSON.stringify(value);
}
