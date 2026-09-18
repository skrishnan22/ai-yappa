/**
 * Deploy-time Integration Catalog + credential resolution for open MCP mounts.
 *
 * Catalog rows are static and reviewed. Neither the model nor Slack input may
 * choose a server URL, secret name, headers, or optional policy. Secrets stay
 * outside the fixed boot schema so an optional integration is not an
 * application-wide requirement (ADR 0017).
 */
import * as v from 'valibot';

const nonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1));

const httpUrl = v.pipe(
	nonEmpty,
	// One check: valibot may still run later pipe steps after a failed `v.url()`,
	// so avoid a bare `new URL(...)` that throws out of `safeParse`.
	v.check((value) => {
		try {
			const protocol = new URL(value).protocol;
			return protocol === 'http:' || protocol === 'https:';
		} catch {
			return false;
		}
	}, 'url must be an absolute http(s) URL'),
);

const catalogEntrySchema = v.object({
	name: nonEmpty,
	url: httpUrl,
	authEnv: nonEmpty,
	/** Defaults to true when omitted. */
	optional: v.optional(v.boolean(), true),
});

export type CatalogEntry = v.InferInput<typeof catalogEntrySchema>;
type ValidatedEntry = v.InferOutput<typeof catalogEntrySchema>;

/** Static, reviewed catalog. Adding a server is one row + one Worker secret. */
export const INTEGRATION_CATALOG: readonly CatalogEntry[] = [
	{
		name: 'cloudflare',
		url: 'https://mcp.cloudflare.com/mcp',
		authEnv: 'CLOUDFLARE_MCP_API_TOKEN',
		optional: true,
	},
	{
		name: 'honeycomb',
		url: 'https://mcp.honeycomb.io/mcp',
		authEnv: 'HONEYCOMB_MCP_API_TOKEN',
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

function validateEntry(entry: unknown, index: number): ValidatedEntry {
	const result = v.safeParse(catalogEntrySchema, entry);
	if (result.success) return result.output;
	const detail = result.issues
		.map((issue) => {
			const key = issue.path?.[0]?.key;
			return typeof key === 'string' ? key : 'entry';
		})
		.filter((value, i, all) => all.indexOf(value) === i)
		.join(', ');
	// Field names only — never echo received values (could be mistaken for secrets).
	throw new Error(`[mcp-catalog] entry[${index}]: invalid ${detail || 'entry'}`);
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
		const entry = validateEntry(catalog[i], i);
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
