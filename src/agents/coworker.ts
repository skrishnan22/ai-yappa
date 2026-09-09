'use agent';
import { Daytona } from '@daytona/sdk';
import { useInitialData, useModel, useSandbox, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { replyInThread } from '../channels/slack-reply.ts';
import { gitAuthorFromEnv, loadAgentEnv } from '../env.ts';
import { createContainerSandbox, daytona } from '../sandboxes/daytona.ts';
import {
	coworkerInstructions,
	hydrateIoFromDaytona,
	hydrateWorkspace,
	WORKSPACE_REPO_DIR,
} from '../sandboxes/hydrate.ts';

const initialDataSchema = v.object({
	channelId: v.string(),
	threadTs: v.string(),
	startedBy: v.optional(v.string()),
	startedAt: v.pipe(v.string(), v.isoTimestamp()),
	repo: v.pipe(v.string(), v.url()),
});

export function Coworker() {
	useModel('opencode-go/kimi-k2.7-code');

	const data = useInitialData<v.InferOutput<typeof initialDataSchema> | undefined>();
	if (!data) {
		throw new Error('This agent is created by the Slack channel dispatch.');
	}

	// Fail fast with the full missing-secret list (Slack optional here — the
	// reply tool degrades to `posted: false` without a token).
	const agentEnv = loadAgentEnv();

	useTool(replyInThread(data, agentEnv.SLACK_BOT_TOKEN));
	useSandbox({
		async createSandbox(options) {
			const apiKey = agentEnv.DAYTONA_API_KEY;
			const client = new Daytona({ apiKey });
			const sandbox = await createContainerSandbox(client, { conversationId: options.id });
			const result = await hydrateWorkspace(hydrateIoFromDaytona(sandbox), {
				repo: data.repo,
				conversationId: options.id,
				git: gitAuthorFromEnv(agentEnv),
			});
			console.info(
				`[slack-agent] hydration skipped=${result.skipped} durationMs=${result.durationMs} cwd=${result.cwd}`,
			);
			return daytona(sandbox, { cwd: WORKSPACE_REPO_DIR }).createSandbox(options);
		},
	});

	return coworkerInstructions(data.repo);
}

Coworker.initialData = initialDataSchema;
Coworker.agentName = 'coworker';
