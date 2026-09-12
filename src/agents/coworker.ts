'use agent';
import { Daytona } from '@daytona/sdk';
import {
	observe,
	useInitialData,
	useModel,
	usePersistentState,
	useSandbox,
	useTool,
	type FlueObservation,
} from '@flue/runtime';
import * as v from 'valibot';
import {
	bindRunCard,
	enqueueCardEvent,
	publishCardEvent,
	type CardEvent,
	type RunCardState,
} from '../channels/run-card.ts';
import { replyInThread } from '../channels/slack-reply.ts';
import { gitAuthorFromEnv, loadAgentEnv } from '../env.ts';
import type { AuditRecord } from '../proxy/ops.ts';
import { createContainerSandbox, daytona } from '../sandboxes/daytona.ts';
import {
	coworkerInstructions,
	hydrateIoFromDaytona,
	hydrateWorkspace,
	WORKSPACE_REPO_DIR,
} from '../sandboxes/hydrate.ts';
import { githubTools } from './github-tools.ts';
import { installOpenCodeGoSessionHeader } from './opencode-session.ts';

const noisyDebugEvents = new Set(['text_delta', 'thinking_delta', 'toolcall_delta']);

// ponytail: local hang diagnosis after hydration; delete once the stall is identified
observe((event, context) => {
	if (!noisyDebugEvents.has(event.type)) {
		console.info('[slack-agent]', event.type, debugFields(event));
	}
	const cardEvent = cardEventFromObservation(event);
	if (cardEvent) return enqueueCardEvent({ ...cardEvent, instanceId: context.id });
});

function debugFields(event: FlueObservation): Record<string, unknown> {
	switch (event.type) {
		case 'turn_start':
			return { turnId: event.turnId, purpose: event.purpose };
		case 'turn_request':
			return {
				turnId: event.turnId,
				model: event.request.requestedModel,
				api: event.request.api,
				tools: event.request.input.tools?.length ?? 0,
				messages: event.request.input.messages.length,
			};
		case 'turn':
			return {
				turnId: event.turnId,
				durationMs: event.durationMs,
				isError: event.isError,
				finishReason: event.response.finishReason,
				error: event.response.error?.message,
			};
		case 'tool_start':
			return { toolName: event.toolName, toolCallId: event.toolCallId, args: event.args };
		case 'tool': {
			const error = toolDebugError(event);
			return {
				toolName: event.toolName,
				durationMs: event.durationMs,
				isError: event.isError,
				...(error !== undefined ? { error } : {}),
			};
		}
		case 'operation_start':
			return { operationKind: event.operationKind, operationId: event.operationId };
		case 'operation':
			return {
				operationKind: event.operationKind,
				durationMs: event.durationMs,
				isError: event.isError,
				error: event.errorInfo?.message,
			};
		case 'submission_settled':
			return { outcome: event.outcome, error: event.error?.message ?? event.errorInfo?.message };
		default:
			return {};
	}
}

const initialDataSchema = v.object({
	channelId: v.string(),
	threadTs: v.string(),
	startedBy: v.optional(v.string()),
	startedAt: v.pipe(v.string(), v.isoTimestamp()),
	repo: v.pipe(v.string(), v.url()),
});

export function Coworker(props: { id: string }) {
	installOpenCodeGoSessionHeader();
	useModel('opencode-go/deepseek-v4-flash');

	const data = useInitialData<v.InferOutput<typeof initialDataSchema> | undefined>();
	if (!data) {
		throw new Error('This agent is created by the Slack channel dispatch.');
	}

	// Fail fast with the full missing-secret list (Slack optional here — the
	// reply tool degrades to `posted: false` without a token).
	const agentEnv = loadAgentEnv();

	useTool(replyInThread(data, agentEnv.SLACK_BOT_TOKEN));
	const [runCard, setRunCard] = usePersistentState<RunCardState | null>('run-card', null);
	bindRunCard({
		instanceId: props.id,
		channelId: data.channelId,
		threadTs: data.threadTs,
		token: agentEnv.SLACK_BOT_TOKEN,
		state: runCard,
		persist: (state) => {
			setRunCard(state);
		},
	});
	// ponytail: conversation-scoped audit array until the D1 cross-conversation store in M4
	const [, setProxyAudit] = usePersistentState<AuditRecord[]>('proxy-audit', []);
	for (const tool of githubTools({
		conversationId: props.id,
		repo: data.repo,
		audit: {
			append: (record) => {
				setProxyAudit((entries) => [...entries, record]);
			},
		},
	})) {
		useTool(tool);
	}
	useSandbox({
		async createSandbox(options) {
			const apiKey = agentEnv.DAYTONA_API_KEY;
			const client = new Daytona({ apiKey });
			const sandbox = await createContainerSandbox(client, { conversationId: options.id });
			await publishCardEvent({
				instanceId: props.id,
				type: 'hydration',
				phase: 'start',
			});
			const result = await hydrateWorkspace(hydrateIoFromDaytona(sandbox), {
				repo: data.repo,
				conversationId: options.id,
				git: gitAuthorFromEnv(agentEnv),
			});
			console.info(
				`[slack-agent] hydration skipped=${result.skipped} durationMs=${result.durationMs} cwd=${result.cwd}`,
			);
			await publishCardEvent({
				instanceId: props.id,
				type: 'hydration',
				phase: 'done',
				skipped: result.skipped,
			});
			const attached = await daytona(sandbox, { cwd: WORKSPACE_REPO_DIR }).createSandbox(options);
			console.info(
				'[slack-agent] sandbox attached, Flue will discover workspace then call the model',
			);
			return attached;
		},
	});

	return coworkerInstructions(data.repo);
}

Coworker.initialData = initialDataSchema;
Coworker.agentName = 'coworker';

function cardEventFromObservation(event: FlueObservation): CardEvent | undefined {
	switch (event.type) {
		case 'submission_queued':
			return { type: 'submission_queued', submissionId: event.submissionId };
		case 'submission_running':
			return { type: 'submission_running', submissionId: event.submissionId };
		case 'tool_start':
			return { type: 'tool_start', toolName: event.toolName, submissionId: event.submissionId };
		case 'tool':
			return {
				type: 'tool',
				toolName: event.toolName,
				submissionId: event.submissionId,
				isError: event.isError,
				result: event.effectiveResult ?? event.result,
			};
		case 'submission_settled':
			return {
				type: 'submission_settled',
				submissionId: event.submissionId,
				outcome: event.outcome,
				error: event.error?.message ?? event.errorInfo?.message,
			};
		default:
			return undefined;
	}
}

function toolDebugError(event: Extract<FlueObservation, { type: 'tool' }>): string | undefined {
	if (event.isError) {
		if (typeof event.result === 'string' && event.result.length > 0) return event.result;
		const nested = findErrorString(event.result) ?? findErrorString(event.effectiveResult);
		if (nested) return nested;
		return 'tool failed';
	}
	return findErrorString(event.result) ?? findErrorString(event.effectiveResult);
}

function findErrorString(value: unknown): string | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.error === 'string' && record.error.length > 0) return record.error;
	return findErrorString(record.output) ?? findErrorString(record.details);
}
