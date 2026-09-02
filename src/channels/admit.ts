export type SlackSignal = 'slack.app_mention' | 'slack.message';

type SlackAuthorization = {
	user_id: string;
	is_bot: boolean;
};

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
	if (args.signalType === 'slack.message' && !args.conversationExists) {
		return { kind: 'drop-untracked' };
	}
	if (!args.allowed) return { kind: 'refuse-invoker' };
	if (args.repo === undefined) return { kind: 'no-repo' };
	return { kind: 'dispatch', repo: args.repo };
}

export function mentionsAuthorizedBot(
	text: string,
	authorizations: SlackAuthorization[] | undefined,
): boolean {
	const botUserId = authorizations?.find((authorization) => authorization.is_bot)?.user_id;
	return botUserId !== undefined && text.includes(`<@${botUserId}>`);
}
