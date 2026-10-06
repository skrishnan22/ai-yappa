'use agent';

import { Daytona } from '@daytona/sdk';
import {
	observe,
	useAgentFinish,
	useAgentStart,
	useDelivery,
	useInitialData,
	useMcpConnection,
	useModel,
	usePersistentState,
	useSandbox,
	useSkill,
	useTool,
	type FlueObservation,
} from '@flue/runtime';
import * as v from 'valibot';
import { questionTools } from '../questions/tools.ts';
import { jsonValueSchema } from '../json.ts';
import {
	bindRunCard,
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
import { skills } from '../skills/index.ts';
import { invokedSkills } from '../skills/invocation.ts';
import { githubTools } from './github-tools.ts';
import { coworkerModel, modelChoiceSchema } from './model-choice.ts';
import { deliveredModelRoute } from './model-route.ts';
import { webSearchTools } from './web-search-tools.ts';

observe((event, context) => {
	const cardEvent = cardEventFromObservation(event);

	if (!cardEvent) return Promise.resolve();

	return publishCardEvent({ ...cardEvent, instanceId: context.id });
});

const initialDataSchema = v.object({
	channelId: v.string(),
	threadTs: v.string(),
	startedBy: v.optional(v.string()),
	startedAt: v.pipe(v.string(), v.isoTimestamp()),
	repo: v.pipe(v.string(), v.url()),
	modelChoice: v.optional(modelChoiceSchema),
});

export function Coworker(props: { id: string }) {
	const data = useInitialData<v.InferOutput<typeof initialDataSchema> | undefined>();

	if (!data) {
		throw new Error('This agent is created by the Slack channel dispatch.');
	}

	const delivery = useDelivery();
	const route = deliveredModelRoute(delivery);
	// A choice recorded by an older deploy that no longer validates falls back
	// to the default route instead of breaking the thread.
	const choice = v.is(modelChoiceSchema, data.modelChoice) ? data.modelChoice : undefined;
	const model = coworkerModel(choice, route === 'chatgpt');

	useModel(model.specifier, { thinkingLevel: model.thinkingLevel });

	// Fail fast with the full missing-secret list (Slack optional here — the
	// reply tool degrades to `posted: false` without a token).
	const agentEnv = loadAgentEnv();

	useTool(replyInThread(data, agentEnv.SLACK_BOT_TOKEN));

	const questions = questionTools(
		{ conversationId: props.id, ...data },
		{ token: agentEnv.SLACK_BOT_TOKEN },
	);

	useTool(questions.askQuestion);
	useTool(questions.closeQuestion);
	// Assistant text never reaches Slack. If the model would stop without a
	// non-error reply_in_slack_thread or ask_question call, send it back to work in this response.
	useAgentFinish(({ response, append }) => {
		if (hasSuccessfulSlackReply(response.toolCalls)) return;
		append({
			kind: 'signal',
			type: 'reminder',
			body: 'You ended without calling reply_in_slack_thread or ask_question — nothing reached the user. Call one now with your answer or question.',
		});
	});
	const [runCard, setRunCard] = usePersistentState<RunCardState | null>('run-card', null);
	bindRunCard({
		instanceId: props.id,
		channelId: data.channelId,
		threadTs: data.threadTs,
		token: agentEnv.SLACK_BOT_TOKEN,
		state: runCard,
		// Mid-submission renders (appended reminders) carry no route; the card
		// keeps the route the submission latched.
		model: route ? model.label : undefined,
		thinkingLevel: route ? model.thinkingLevel : undefined,
		modelIsDefault: model.isDefault,
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

	// The model activates a skill on its own when a request matches its
	// description; `/<name>` in a mention makes it activate that one first.
	for (const skill of skills) {
		useSkill(skill);
	}

	const invoked =
		delivery.kind === 'signal' && delivery.type === 'slack.app_mention'
			? invokedSkills(delivery.body, new Set(skills.map((skill) => skill.name)))
			: [];

	useAgentStart(({ append }) => {
		if (invoked.length === 0) return;

		append({
			kind: 'signal',
			type: 'skill_invoked',
			body: `The user invoked ${invoked.map((name) => `/${name}`).join(' and ')}. Before anything else, call activate_skill for ${invoked.join(' and ')}, then follow the skill for this request.`,
		});
	});
	// Same guard shape as the Slack reply: a stop without the activation goes
	// back to work. Later renders read the appended reminder as the delivery,
	// so this reminds once, alongside the reply guard.
	useAgentFinish(({ response, append }) => {
		if (hasSkillActivations(response.toolCalls, invoked.length)) return;
		append({
			kind: 'signal',
			type: 'reminder',
			body: `The user invoked ${invoked.map((name) => `/${name}`).join(' and ')}, but you have not called activate_skill. Call it now, then answer by following the skill.`,
		});
	});

	// Optional Exa / Parallel keys — same optional-secret posture as MCP catalog.
	for (const tool of webSearchTools(process.env)) {
		useTool(tool);
	}

	// Resolve MCP catalog at render (not module init). Secrets stay out of
	// loadAgentEnv so optional integrations are not boot requirements.
	const mcp = resolveIntegrationCatalog(INTEGRATION_CATALOG, process.env);

	for (const warning of mcp.warnings) {
		console.warn(warning);
	}

	for (const connection of mcp.connections) {
		const credentials =
			connection.authorization.kind === 'bearer'
				? { auth: connection.authorization.value }
				: { headers: { Authorization: `Basic ${connection.authorization.value}` } };

		useMcpConnection({
			name: connection.name,
			url: connection.url,
			...credentials,
			tools: connection.tools,
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

export function hasSkillActivations(
	toolCalls: readonly { tool: string; isError: boolean }[],
	required: number,
): boolean {
	return (
		toolCalls.filter((call) => call.tool === 'activate_skill' && !call.isError).length >= required
	);
}

export function hasSuccessfulSlackReply(
	toolCalls: readonly { tool: string; isError: boolean }[],
): boolean {
	return toolCalls.some(
		(call) =>
			(call.tool === 'reply_in_slack_thread' || call.tool === 'ask_question') && !call.isError,
	);
}

function cardEventFromObservation(event: FlueObservation): CardEvent | undefined {
	switch (event.type) {
		case 'submission_queued':
			return { type: 'submission_queued', submissionId: event.submissionId };
		case 'submission_running':
			return { type: 'submission_running', submissionId: event.submissionId };
		case 'tool_start': {
			if (event.submissionId === undefined) return undefined;

			return { type: 'tool_start', toolName: event.toolName, submissionId: event.submissionId };
		}

		case 'tool': {
			if (event.submissionId === undefined) return undefined;

			const rawResult = event.effectiveResult ?? event.result;

			return {
				type: 'tool',
				toolName: event.toolName,
				submissionId: event.submissionId,
				isError: event.isError,
				result: v.is(jsonValueSchema, rawResult) ? rawResult : undefined,
			};
		}

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
