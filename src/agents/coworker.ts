'use agent';
import { Daytona } from '@daytona/sdk';
import {
	observe,
	useAgentFinish,
	useInitialData,
	useMcpConnection,
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
import { INTEGRATION_CATALOG, resolveIntegrationCatalog } from '../integrations/mcp-catalog.ts';
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
	useModel('opencode-go/deepseek-v4.1-flash');

	const data = useInitialData<v.InferOutput<typeof initialDataSchema> | undefined>();
	if (!data) {
		throw new Error('This agent is created by the Slack channel dispatch.');
	}

	// Fail fast with the full missing-secret list (Slack optional here — the
	// reply tool degrades to `posted: false` without a token).
	const agentEnv = loadAgentEnv();

	useTool(replyInThread(data, agentEnv.SLACK_BOT_TOKEN));
	// Assistant text never reaches Slack. If the model would stop without a
	// non-error reply_in_slack_thread call, send it back to work in this response.
	useAgentFinish(({ response, append }) => {
		if (hasSuccessfulSlackReply(response.toolCalls)) return;
		append({
			kind: 'signal',
			type: 'reminder',
			body: 'You ended without calling reply_in_slack_thread — nothing reached the user. Call it now with your answer.',
		});
	});
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

	// Resolve MCP catalog at render (not module init). Secrets stay out of
	// loadAgentEnv so optional integrations are not boot requirements.
	const mcp = resolveIntegrationCatalog(INTEGRATION_CATALOG, process.env);
	for (const warning of mcp.warnings) {
		console.warn(warning);
	}
	for (const connection of mcp.connections) {
		useMcpConnection({
			name: connection.name,
			url: connection.url,
			auth: connection.auth,
			optional: connection.optional,
		});
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
			await publishCardEvent({
				instanceId: props.id,
				type: 'hydration',
				phase: 'done',
				skipped: result.skipped,
			});
			return daytona(sandbox, { cwd: WORKSPACE_REPO_DIR }).createSandbox(options);
		},
	});

	return coworkerInstructions(data.repo);
}

Coworker.initialData = initialDataSchema;
Coworker.agentName = 'coworker';

export function hasSuccessfulSlackReply(
	toolCalls: readonly { tool: string; isError: boolean }[],
): boolean {
	return toolCalls.some((call) => call.tool === 'reply_in_slack_thread' && !call.isError);
}

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
