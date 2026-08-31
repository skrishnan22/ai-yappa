import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign,
	verify,
} from 'node:crypto';

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

export const CAPABILITY_TTL_SECONDS = 600;

export type CapabilityKeys = {
	kid: string;
	privateKeyPem: string;
	publicKeyPem: string;
};

export type CapabilityClaims = {
	conversationId: string;
	submissionId: string;
	submissionType: SubmissionType;
	repo: string;
	allowedOps: ProxyOp[];
	exp: number;
	kid: string;
};

const PROXY_OPS = [
	'readIssue',
	'readRepoMetadata',
	'readRef',
	'createBranch',
	'createPullRequest',
	'vendPushToken',
] as const satisfies readonly ProxyOp[];

export function generateCapabilityKeyPair(): CapabilityKeys {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
	const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
	const kid = createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 8);
	return { kid, privateKeyPem, publicKeyPem };
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

export function assertOpAllowed(args: { submissionType: SubmissionType; op: ProxyOp }): void {
	const allowed: readonly ProxyOp[] = OPS_BY_SUBMISSION[args.submissionType];
	if (!allowed.includes(args.op)) {
		throw new Error(`op ${args.op} is not allowed for ${args.submissionType} submissions`);
	}
}

export function mintCapability(args: {
	keys: CapabilityKeys;
	now: number;
	claims: {
		conversationId: string;
		submissionId: string;
		submissionType: SubmissionType;
		repo: string;
		allowedOps: ProxyOp[];
	};
}): string {
	if (args.claims.allowedOps.length === 0) {
		throw new Error('capability allowedOps must not be empty');
	}
	for (const op of args.claims.allowedOps) {
		assertOpAllowed({ submissionType: args.claims.submissionType, op });
	}
	const payload: CapabilityClaims = {
		conversationId: args.claims.conversationId,
		submissionId: args.claims.submissionId,
		submissionType: args.claims.submissionType,
		repo: canonicalRepo(args.claims.repo),
		allowedOps: args.claims.allowedOps,
		exp: args.now + CAPABILITY_TTL_SECONDS,
		kid: args.keys.kid,
	};
	const header = { alg: 'EdDSA', kid: args.keys.kid };
	const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
	const signature = sign(null, Buffer.from(signingInput), createPrivateKey(args.keys.privateKeyPem));
	return `${signingInput}.${signature.toString('base64url')}`;
}

export function verifyCapability(args: {
	token: string;
	keys: CapabilityKeys;
	now: number;
}): CapabilityClaims {
	const parts = args.token.split('.');
	if (parts.length !== 3 || parts[0] === undefined || parts[1] === undefined || parts[2] === undefined) {
		throw new Error('malformed capability token');
	}
	const signingInput = `${parts[0]}.${parts[1]}`;
	let signature: Buffer;
	try {
		signature = Buffer.from(parts[2], 'base64url');
	} catch {
		throw new Error('malformed capability token');
	}
	const ok = verify(
		null,
		Buffer.from(signingInput),
		createPublicKey(args.keys.publicKeyPem),
		signature,
	);
	if (!ok) throw new Error('invalid signature');
	const header = parseJson(Buffer.from(parts[0], 'base64url').toString('utf8'));
	if (!isRecord(header) || header.alg !== 'EdDSA' || header.kid !== args.keys.kid) {
		throw new Error('invalid signature');
	}
	const payload = parseClaims(parseJson(Buffer.from(parts[1], 'base64url').toString('utf8')));
	if (payload.kid !== args.keys.kid) throw new Error('invalid signature');
	if (payload.exp <= args.now) throw new Error('capability token expired');
	return payload;
}

function b64urlJson(value: unknown): string {
	return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error('malformed capability token');
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProxyOp(value: unknown): value is ProxyOp {
	if (typeof value !== 'string') return false;
	for (const op of PROXY_OPS) {
		if (op === value) return true;
	}
	return false;
}

function parseClaims(value: unknown): CapabilityClaims {
	if (!isRecord(value)) throw new Error('malformed capability token');
	if (
		typeof value.conversationId !== 'string' ||
		typeof value.submissionId !== 'string' ||
		typeof value.repo !== 'string' ||
		typeof value.exp !== 'number' ||
		typeof value.kid !== 'string' ||
		(value.submissionType !== 'code-change' && value.submissionType !== 'investigation') ||
		!Array.isArray(value.allowedOps) ||
		value.allowedOps.length === 0 ||
		!value.allowedOps.every(isProxyOp)
	) {
		throw new Error('malformed capability token');
	}
	return {
		conversationId: value.conversationId,
		submissionId: value.submissionId,
		submissionType: value.submissionType,
		repo: value.repo,
		allowedOps: value.allowedOps,
		exp: value.exp,
		kid: value.kid,
	};
}
