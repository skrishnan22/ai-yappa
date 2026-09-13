export type SubmissionType = 'code-change' | 'investigation';

export type ProxyOp =
	| 'readIssue'
	| 'readRepoMetadata'
	| 'readRef'
	| 'createBranch'
	| 'createPullRequest'
	| 'vendPushToken';

export const OPS_BY_SUBMISSION = {
	'code-change': [
		'readIssue',
		'readRepoMetadata',
		'readRef',
		'createBranch',
		'createPullRequest',
		'vendPushToken',
	],
	investigation: ['readIssue', 'readRepoMetadata', 'readRef'],
} as const satisfies Record<SubmissionType, readonly ProxyOp[]>;

export function assertOpAllowed(args: { submissionType: SubmissionType; op: ProxyOp }): void {
	const allowed: readonly ProxyOp[] = OPS_BY_SUBMISSION[args.submissionType];
	if (!allowed.includes(args.op)) {
		throw new Error(`op ${args.op} is not allowed for ${args.submissionType} submissions`);
	}
}

export function canonicalRepo(input: string): string {
	const trimmed = input.trim();
	if (!trimmed.includes('://') && !trimmed.startsWith('/')) {
		const ownerName = trimmed.replace(/\.git$/i, '');
		const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(ownerName);
		if (match) return `${match[1]}/${match[2]}`;
		throw new Error('repo must be a github.com URL or owner/name');
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error('repo must be a github.com URL or owner/name');
	}
	if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
		throw new Error('repo host must be github.com');
	}
	const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
	if (parts.length < 2 || parts[0] === undefined || parts[1] === undefined) {
		throw new Error('repo must be owner/name');
	}
	const name = parts[1].replace(/\.git$/i, '');
	return `${parts[0]}/${name}`;
}
