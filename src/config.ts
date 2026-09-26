export type ChannelConfig = {
	defaultRepo: string;
};

export const allowedInvokerIds = new Set<string>(['U0BGR738WMC']);

// Slack users who may run `/coworker openai connect` and `disconnect`, which
// bind the whole deployment to one ChatGPT subscription (ADR 0020). Separate
// from the invoker allowlist; empty means nobody.
export const codexAdminIds = new Set<string>(['U0BGR738WMC']);

export const channelRepos = {
	// C0123ABCD: { defaultRepo: 'https://github.com/org/pilot' },
	C0BTJCJD69K: { defaultRepo: 'https://github.com/skrishnan22/codevil.git' },
	C0C172RQLSD: { defaultRepo: 'https://github.com/skrishnan22/codevil.git' },
};

export function isAllowedInvoker(userId: string | undefined): boolean {
	if (!userId) return false;

	return allowedInvokerIds.has(userId);
}

export function isCodexAdmin(userId: string | undefined): boolean {
	if (!userId) return false;

	return codexAdminIds.has(userId);
}

export function repoForChannel(channelId: string): string | undefined {
	switch (channelId) {
		case 'C0BTJCJD69K':
		case 'C0C172RQLSD':
			return channelRepos[channelId].defaultRepo;
		default:
			return undefined;
	}
}
