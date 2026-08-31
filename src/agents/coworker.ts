'use agent';
import { Daytona } from '@daytona/sdk';
import { useInitialData, useModel, useSandbox, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { replyInThread } from '../channels/slack-reply.ts';
import { createContainerSandbox, daytona } from '../sandboxes/daytona.ts';
import { githubTools } from './github-tools.ts';

const initialDataSchema = v.object({
	channelId: v.string(),
	threadTs: v.string(),
	startedBy: v.optional(v.string()),
	startedAt: v.pipe(v.string(), v.isoTimestamp()),
	repo: v.pipe(v.string(), v.url()),
});

export function Coworker(props: { id: string }) {
	useModel('opencode-go/kimi-k2.7-code');

	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) {
		throw new Error('This agent is created by the Slack channel dispatch.');
	}

	useTool(replyInThread(data));
	for (const tool of githubTools({ conversationId: props.id, repo: data.repo })) {
		useTool(tool);
	}
	useSandbox({
		async createSandbox(options) {
			const apiKey = process.env.DAYTONA_API_KEY;
			if (!apiKey) {
				throw new Error('DAYTONA_API_KEY is required to create a sandbox.');
			}
			const client = new Daytona({ apiKey });
			const sandbox = await createContainerSandbox(client, { conversationId: options.id });
			return daytona(sandbox, { cwd: '/workspace' }).createSandbox(options);
		},
	});

	return [
		'You are a Slack-native engineering coworker.',
		`This conversation is bound to one Slack thread and the repository ${data.repo}.`,
		'On the first mention, clone that repo (shallow) into the sandbox working directory, run ls, and reply in the thread with the command output.',
		'Later messages in the same thread continue this conversation.',
		'GitHub reads, the working branch, and pull requests go through the GitHub tools. Persist git work with checkpoint_working_branch. Never git push with a token. Do not merge or deploy. Do not choose a different Slack channel or thread.',
		'Reply with the reply_in_slack_thread tool.',
	].join(' ');
}

Coworker.initialData = initialDataSchema;
Coworker.agentName = 'coworker';
