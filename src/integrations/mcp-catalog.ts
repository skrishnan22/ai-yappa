/**
 * Deploy-time Integration Catalog + credential resolution for open MCP mounts.
 *
 * Catalog rows are static and reviewed. Neither the model nor Slack input may
 * choose a server URL, secret name, headers, or optional policy. Secrets stay
 * outside the fixed boot schema so an optional integration is not an
 * application-wide requirement (ADR 0017).
 */

export type CatalogEntry = {
	name: string;
	url: string;
	authEnv: string;
	/** Defaults to true when omitted. */
	optional?: boolean;
};

/** Static, reviewed catalog. Adding a server is one row + one Worker secret. */
export const INTEGRATION_CATALOG: readonly CatalogEntry[] = [
	{
		name: 'cloudflare',
		url: 'https://mcp.cloudflare.com/mcp',
		authEnv: 'CLOUDFLARE_API_TOKEN',
		optional: true,
	},
];

export type ResolvedMcpDefinition = {
	name: string;
	url: string;
	optional: boolean;
	/** Bearer token value for Flue `auth` (sent as Authorization: Bearer …). */
	auth: string;
};

export type ResolveCatalogResult = {
	connections: ResolvedMcpDefinition[];
	/** Credential-free warnings for skipped optional entries. */
	warnings: string[];
};

export type EnvMap = Record<string, string | undefined>;

function failValidation(message: string): never {
	throw new Error(`[mcp-catalog] ${message}`);
}

function validateEntry(
	entry: CatalogEntry,
	index: number,
): {
	name: string;
	url: string;
	authEnv: string;
	optional: boolean;
} {
	const label = `entry[${index}]`;
	if (typeof entry !== 'object' || entry === null) {
		failValidation(`${label}: must be an object`);
	}
	const name = typeof entry.name === 'string' ? entry.name.trim() : '';
	const url = typeof entry.url === 'string' ? entry.url.trim() : '';
	const authEnv = typeof entry.authEnv === 'string' ? entry.authEnv.trim() : '';
	if (!name) failValidation(`${label}: name is required`);
	if (!url) failValidation(`${label}: url is required`);
	if (!authEnv) failValidation(`${label}: authEnv is required`);
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			failValidation(`${label}: url must be http(s)`);
		}
	} catch {
		failValidation(`${label}: url must be an absolute URL`);
	}
	if (entry.optional !== undefined && typeof entry.optional !== 'boolean') {
		failValidation(`${label}: optional must be a boolean when set`);
	}
	return {
		name,
		url,
		authEnv,
		optional: entry.optional !== false,
	};
}

/**
 * Resolve catalog rows against an injected environment map.
 * Returns only resolved MCP definitions; never returns or logs secret values.
 */
export function resolveIntegrationCatalog(
	catalog: readonly CatalogEntry[],
	env: EnvMap,
): ResolveCatalogResult {
	const connections: ResolvedMcpDefinition[] = [];
	const warnings: string[] = [];

	for (let i = 0; i < catalog.length; i++) {
		const entry = validateEntry(catalog[i]!, i);
		const raw = env[entry.authEnv];
		const secret = typeof raw === 'string' ? raw.trim() : '';
		if (!secret) {
			if (entry.optional) {
				warnings.push(
					`[mcp-catalog] skipping optional MCP "${entry.name}": missing ${entry.authEnv}`,
				);
				continue;
			}
			throw new Error(`[mcp-catalog] required MCP "${entry.name}" missing secret ${entry.authEnv}`);
		}
		connections.push({
			name: entry.name,
			url: entry.url,
			optional: entry.optional,
			auth: secret,
		});
	}

	return { connections, warnings };
}
