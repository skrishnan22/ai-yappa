import { getSlackClient } from './slack-reply.ts';

export type CardStatus = 'queued' | 'hydrating' | 'working' | 'completed' | 'failed' | 'aborted';

export type RunCardState = {
	submissionId: string;
	messageTs: string | null;
	status: CardStatus;
	step: string;
	startedAt: number;
	branchUrl?: string;
	prUrl?: string;
	notifyPosted?: boolean;
	/** Deployment model specifier (`provider/model`), stamped from bindRunCard. */
	model?: string;
	/** Reasoning effort from useModel options, stamped from bindRunCard. */
	thinkingLevel?: string;
};

export type CardEvent =
	| { type: 'submission_queued'; submissionId: string }
	| { type: 'submission_running'; submissionId: string }
	| { type: 'hydration'; phase: 'start' | 'done'; skipped?: boolean }
	| { type: 'tool_start'; submissionId?: string; toolName: string }
	| { type: 'tool'; submissionId?: string; toolName: string; isError?: boolean; result?: unknown }
	| {
			type: 'submission_settled';
			submissionId: string;
			outcome: 'completed' | 'failed' | 'aborted';
			error?: string;
	  };

export type RoutedCardEvent = CardEvent & { readonly instanceId: string };

export type CardApply = {
	state: RunCardState;
	notify?: string;
};

const STEP_BY_TOOL: Record<string, string> = {
	read_github_issue: 'Reading GitHub issue',
	read_github_repo: 'Reading repository metadata',
	create_working_branch: 'Creating working branch',
	checkpoint_working_branch: 'Checkpointing working branch',
	open_pull_request: 'Opening pull request',
	reply_in_slack_thread: 'Replying in thread',
	bash: 'Running a command',
	read: 'Reading a file',
	write: 'Editing files',
	edit: 'Editing files',
	grep: 'Searching the workspace',
	glob: 'Searching the workspace',
};

type SlackBlock = Record<string, unknown>;

export type SlackCardPort = {
	post(args: {
		channel: string;
		threadTs: string;
		text: string;
		blocks: SlackBlock[];
	}): Promise<{ ts: string | null }>;
	update(args: { channel: string; ts: string; text: string; blocks: SlackBlock[] }): Promise<void>;
	notify(args: { channel: string; threadTs: string; text: string }): Promise<void>;
};

type CardHandle = {
	channelId: string;
	threadTs: string;
	token?: string;
	state: RunCardState | null;
	persist: (state: RunCardState) => void;
	port?: SlackCardPort;
	chain: Promise<void>;
	model?: string;
	thinkingLevel?: string;
};

const handles = new Map<string, CardHandle>();

export function bindRunCard(args: {
	instanceId: string;
	channelId: string;
	threadTs: string;
	token?: string;
	state: RunCardState | null;
	persist: (state: RunCardState) => void;
	port?: SlackCardPort;
	model?: string;
	thinkingLevel?: string;
}): void {
	let handle = handles.get(args.instanceId);
	if (handle === undefined) {
		handle = { ...args, chain: Promise.resolve() };
		handles.set(args.instanceId, handle);
		return;
	}
	handle.channelId = args.channelId;
	handle.threadTs = args.threadTs;
	handle.token = args.token;
	handle.persist = args.persist;
	handle.port = args.port;
	handle.model = args.model;
	handle.thinkingLevel = args.thinkingLevel;
	if (handle.state === null && args.state !== null) {
		handle.state = args.state;
		return;
	}
	if (
		handle.state !== null &&
		args.state !== null &&
		handle.state.submissionId === args.state.submissionId &&
		handle.state.messageTs === null &&
		args.state.messageTs
	) {
		handle.state = { ...handle.state, messageTs: args.state.messageTs };
	}
}

export function __resetRunCardForTests(): void {
	handles.clear();
}

export function enqueueCardEvent(event: RoutedCardEvent, now = Date.now()): Promise<void> {
	const handle = handles.get(event.instanceId);
	if (handle === undefined) return Promise.resolve();
	handle.chain = handle.chain.then(
		() => publishCardEvent(event, now).catch(() => publishCardEvent(event, now)),
		() => publishCardEvent(event, now),
	);
	return handle.chain;
}

export async function publishCardEvent(event: RoutedCardEvent, now = Date.now()): Promise<void> {
	const handle = handles.get(event.instanceId);
	if (handle === undefined) return;
	const applied = applyCardEvent(handle.state, event, now);
	if (applied === undefined) return;
	const nextState = withModelRoute(applied.state, handle);
	if (!cardChanged(handle.state, nextState) && applied.notify === undefined) return;

	handle.state = nextState;

	try {
		const port = handle.port ?? (handle.token ? slackCardPort(handle.token) : undefined);
		if (port !== undefined) {
			const rendered = renderRunCard(nextState, now);
			if (nextState.messageTs) {
				await port.update({
					channel: handle.channelId,
					ts: nextState.messageTs,
					text: rendered.text,
					blocks: rendered.blocks,
				});
			} else {
				const posted = await port.post({
					channel: handle.channelId,
					threadTs: handle.threadTs,
					text: rendered.text,
					blocks: rendered.blocks,
				});
				handle.state = { ...nextState, messageTs: posted.ts };
			}
			if (applied.notify !== undefined && handle.state.notifyPosted !== true) {
				await port.notify({
					channel: handle.channelId,
					threadTs: handle.threadTs,
					text: applied.notify,
				});
				handle.state = { ...handle.state, notifyPosted: true };
			}
		}
	} finally {
		handle.persist(handle.state);
	}
}

export function applyCardEvent(
	state: RunCardState | null,
	event: CardEvent,
	now: number,
): CardApply | undefined {
	switch (event.type) {
		case 'submission_queued':
			return beginOrRefresh(state, event.submissionId, 'queued', 'Queued', now);
		case 'submission_running':
			return beginOrRefresh(state, event.submissionId, 'working', 'Working', now);
		case 'hydration': {
			const step =
				event.phase === 'start'
					? 'Hydrating workspace'
					: event.skipped
						? 'Workspace ready'
						: 'Workspace hydrated';
			const status: CardStatus = event.phase === 'start' ? 'hydrating' : 'working';
			if (state === null) {
				return {
					state: {
						submissionId: 'active',
						messageTs: null,
						status,
						step,
						startedAt: now,
					},
				};
			}
			if (isTerminal(state.status)) return undefined;
			return { state: { ...state, status, step } };
		}
		case 'tool_start': {
			if (state === null || isTerminal(state.status)) return undefined;
			return {
				state: {
					...state,
					status: 'working',
					step: STEP_BY_TOOL[event.toolName] ?? `Running ${event.toolName}`,
				},
			};
		}
		case 'tool': {
			if (state === null || isTerminal(state.status)) return undefined;
			const links = linksFromTool(event.toolName, event.result);
			if (links.branchUrl === undefined && links.prUrl === undefined) return undefined;
			return {
				state: {
					...state,
					branchUrl: links.branchUrl ?? state.branchUrl,
					prUrl: links.prUrl ?? state.prUrl,
				},
			};
		}
		case 'submission_settled': {
			const same =
				state !== null &&
				(state.submissionId === event.submissionId || state.submissionId === 'active');
			const base = same
				? state
				: {
						submissionId: event.submissionId,
						messageTs: null,
						status: 'working' as const,
						step: 'Working',
						startedAt: now,
					};
			const next = settle(
				{ ...base, submissionId: event.submissionId },
				event.outcome,
				event.error,
			);
			return { state: next.state, notify: next.notify };
		}
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}

export function renderRunCard(
	state: RunCardState,
	now: number,
): { text: string; blocks: SlackBlock[] } {
	const statusLabel = statusText(state.status);
	const elapsed = formatElapsed(now - state.startedAt);
	const route = formatModelRoute(state);
	const text = route
		? `${statusLabel} · ${state.step} · ${elapsed} · ${route}`
		: `${statusLabel} · ${state.step} · ${elapsed}`;
	const links: string[] = [];
	if (state.branchUrl) links.push(`<${state.branchUrl}|branch>`);
	if (state.prUrl) links.push(`<${state.prUrl}|pull request>`);
	const blocks: SlackBlock[] = [
		{
			type: 'section',
			text: {
				type: 'mrkdwn',
				text: `${statusEmoji(state.status)} *${statusLabel}*  ·  ${escapeMrkdwn(state.step)}  ·  \`${elapsed}\``,
			},
		},
	];
	const contextBits: string[] = [];
	if (route) contextBits.push(escapeMrkdwn(route));
	if (links.length > 0) contextBits.push(links.join('  ·  '));
	if (contextBits.length > 0) {
		blocks.push({
			type: 'context',
			elements: [{ type: 'mrkdwn', text: contextBits.join('  ·  ') }],
		});
	}
	return { text, blocks };
}

function withModelRoute(state: RunCardState, handle: CardHandle): RunCardState {
	if (handle.model === undefined && handle.thinkingLevel === undefined) return state;
	return {
		...state,
		model: handle.model ?? state.model,
		thinkingLevel: handle.thinkingLevel ?? state.thinkingLevel,
	};
}

export function formatModelRoute(
	state: Pick<RunCardState, 'model' | 'thinkingLevel'>,
): string | undefined {
	if (state.model === undefined) return undefined;
	if (state.thinkingLevel === undefined) return state.model;
	return `${state.model} · thinking ${state.thinkingLevel}`;
}

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function beginOrRefresh(
	state: RunCardState | null,
	submissionId: string,
	status: CardStatus,
	step: string,
	now: number,
): CardApply {
	if (state !== null && state.submissionId === submissionId) {
		if (isTerminal(state.status) || statusRank(status) < statusRank(state.status)) {
			return { state };
		}
		return { state: { ...state, status, step } };
	}
	if (state !== null && state.submissionId === 'active' && !isTerminal(state.status)) {
		const nextStatus = statusRank(status) < statusRank(state.status) ? state.status : status;
		const nextStep = statusRank(status) < statusRank(state.status) ? state.step : step;
		return { state: { ...state, submissionId, status: nextStatus, step: nextStep } };
	}
	return {
		state: {
			submissionId,
			messageTs: null,
			status,
			step,
			startedAt: now,
		},
	};
}

function statusRank(status: CardStatus): number {
	switch (status) {
		case 'queued':
			return 0;
		case 'hydrating':
			return 1;
		case 'working':
			return 2;
		case 'completed':
		case 'failed':
		case 'aborted':
			return 3;
		default: {
			const _exhaustive: never = status;
			return _exhaustive;
		}
	}
}

function settle(
	state: RunCardState,
	outcome: 'completed' | 'failed' | 'aborted',
	error: string | undefined,
): { state: RunCardState; notify?: string } {
	if (outcome === 'completed') {
		const step = state.prUrl ? 'Pull request opened' : 'Completed';
		const notify = state.prUrl ? `Done: ${state.prUrl}` : undefined;
		return { state: { ...state, status: 'completed', step }, notify };
	}
	if (outcome === 'aborted') {
		return { state: { ...state, status: 'aborted', step: 'Aborted' }, notify: 'Aborted.' };
	}
	const detail = error && error.length > 0 ? truncate(error, 200) : 'see thread';
	return {
		state: { ...state, status: 'failed', step: `Failed: ${detail}` },
		notify: `Failed: ${detail}`,
	};
}

function linksFromTool(toolName: string, result: unknown): { branchUrl?: string; prUrl?: string } {
	const url = findHtmlUrl(result);
	if (url === undefined) return {};
	if (toolName === 'open_pull_request') return { prUrl: url };
	if (toolName === 'checkpoint_working_branch' || toolName === 'create_working_branch') {
		return { branchUrl: url };
	}
	return {};
}

function findHtmlUrl(value: unknown): string | undefined {
	if (typeof value === 'string' && value.startsWith('https://github.com/')) return value;
	if (!isRecord(value)) return undefined;
	if (typeof value.htmlUrl === 'string' && value.htmlUrl.startsWith('https://github.com/')) {
		return value.htmlUrl;
	}
	if (value.output !== undefined) return findHtmlUrl(value.output);
	if (value.details !== undefined) return findHtmlUrl(value.details);
	if (value.result !== undefined) return findHtmlUrl(value.result);
	return undefined;
}

function cardChanged(prev: RunCardState | null, next: RunCardState): boolean {
	if (prev === null) return true;
	return (
		prev.submissionId !== next.submissionId ||
		prev.status !== next.status ||
		prev.step !== next.step ||
		prev.branchUrl !== next.branchUrl ||
		prev.prUrl !== next.prUrl ||
		prev.model !== next.model ||
		prev.thinkingLevel !== next.thinkingLevel
	);
}

function isTerminal(status: CardStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'aborted';
}

function statusText(status: CardStatus): string {
	switch (status) {
		case 'queued':
			return 'Queued';
		case 'hydrating':
			return 'Hydrating';
		case 'working':
			return 'Working';
		case 'completed':
			return 'Completed';
		case 'failed':
			return 'Failed';
		case 'aborted':
			return 'Aborted';
		default: {
			const _exhaustive: never = status;
			return _exhaustive;
		}
	}
}

function statusEmoji(status: CardStatus): string {
	switch (status) {
		case 'queued':
			return ':hourglass:';
		case 'hydrating':
		case 'working':
			return ':gear:';
		case 'completed':
			return ':white_check_mark:';
		case 'failed':
			return ':x:';
		case 'aborted':
			return ':stop_sign:';
		default: {
			const _exhaustive: never = status;
			return _exhaustive;
		}
	}
}

function escapeMrkdwn(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slackCardPort(token: string): SlackCardPort {
	const client = getSlackClient(token);
	return {
		async post({ channel, threadTs, text, blocks }) {
			const result = await client.chat.postMessage({
				channel,
				thread_ts: threadTs,
				text,
				blocks: blocks as never,
			});
			return { ts: result.ts ?? null };
		},
		async update({ channel, ts, text, blocks }) {
			await client.chat.update({
				channel,
				ts,
				text,
				blocks: blocks as never,
			});
		},
		async notify({ channel, threadTs, text }) {
			await client.chat.postMessage({
				channel,
				thread_ts: threadTs,
				text,
			});
		},
	};
}
