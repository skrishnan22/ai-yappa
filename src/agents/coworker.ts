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
import { classifyTelemetryError, emitTelemetry, observeFlueTelemetry } from '../observability.ts';
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

observe((event, context) => {
	observeFlueTelemetry(event, context.id);
	const cardEvent = cardEventFromObservation(event);
	if (!cardEvent) return Promise.resolve();
	return enqueueCardEvent({ ...cardEvent, instanceId: context.id });
});

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

	useTool(
		replyInThread(
			{ channelId: data.channelId, threadTs: data.threadTs, conversationId: props.id },
			agentEnv.SLACK_BOT_TOKEN,
		),
	);
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
			const hydrationStarted = Date.now();
			let result: Awaited<ReturnType<typeof hydrateWorkspace>>;
			try {
				result = await hydrateWorkspace(hydrateIoFromDaytona(sandbox), {
					repo: data.repo,
					conversationId: options.id,
					git: gitAuthorFromEnv(agentEnv),
				});
				emitTelemetry({
					event_name: 'sandbox.lifecycle',
					outcome: result.skipped ? 'skipped' : 'ok',
					conversation_id: options.id,
					sandbox_id: sandbox.id,
					phase: 'hydrate',
					skipped: result.skipped,
					repo: data.repo,
					duration_ms: result.durationMs,
				});
			} catch (error) {
				emitTelemetry({
					event_name: 'sandbox.lifecycle',
					outcome: 'failed',
					conversation_id: options.id,
					sandbox_id: sandbox.id,
					phase: 'hydrate',
					repo: data.repo,
					duration_ms: Math.max(0, Date.now() - hydrationStarted),
					...classifyTelemetryError(error),
				});
				throw error;
			}
			await publishCardEvent({
				instanceId: props.id,
				type: 'hydration',
				phase: 'done',
				skipped: result.skipped,
			});
			const attachStarted = Date.now();
			try {
				const attached = await daytona(sandbox, { cwd: WORKSPACE_REPO_DIR }).createSandbox(options);
				emitTelemetry({
					event_name: 'sandbox.lifecycle',
					outcome: 'ok',
					conversation_id: options.id,
					sandbox_id: sandbox.id,
					phase: 'attach',
					duration_ms: Math.max(0, Date.now() - attachStarted),
				});
				return attached;
			} catch (error) {
				emitTelemetry({
					event_name: 'sandbox.lifecycle',
					outcome: 'failed',
					conversation_id: options.id,
					sandbox_id: sandbox.id,
					phase: 'attach',
					duration_ms: Math.max(0, Date.now() - attachStarted),
					...classifyTelemetryError(error),
				});
				throw error;
			}
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
