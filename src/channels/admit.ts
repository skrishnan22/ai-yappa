export type SlackSignal = 'slack.app_mention' | 'slack.message';

export type AdmitDecision =
	| { kind: 'refuse-invoker' }
	| { kind: 'no-repo' }
	| { kind: 'drop-untracked' }
	| { kind: 'dispatch'; repo: string };

export function decideAdmit(args: {
	signalType: SlackSignal;
	allowed: boolean;
	repo: string | undefined;
	conversationExists: boolean;
}): AdmitDecision {
	if (!args.allowed) return { kind: 'refuse-invoker' };
	if (args.repo === undefined) return { kind: 'no-repo' };
	if (args.signalType === 'slack.message' && !args.conversationExists) {
		return { kind: 'drop-untracked' };
	}
	return { kind: 'dispatch', repo: args.repo };
}
