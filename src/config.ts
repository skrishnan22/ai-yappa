export type ChannelConfig = {
	defaultRepo: string;
};

export const allowedInvokerIds = new Set<string>([
  "U0BGR738WMC"
]);

export const channelRepos: Record<string, ChannelConfig> = {
	// C0123ABCD: { defaultRepo: 'https://github.com/org/pilot' },
	C0BTJCJD69K: {defaultRepo: 'https://github.com/skrishnan22/codevil.git'}
};

export function isAllowedInvoker(userId: string | undefined): boolean {
	if (!userId) return false;
	return allowedInvokerIds.has(userId);
}

export function repoForChannel(channelId: string): string | undefined {
	return channelRepos[channelId]?.defaultRepo;
}
