import { describe, expect, test } from 'vitest';
import {
	INTEGRATION_CATALOG,
	resolveIntegrationCatalog,
	type CatalogEntry,
} from './mcp-catalog.ts';

const cloudflare: CatalogEntry = {
	name: 'cloudflare',
	url: 'https://mcp.cloudflare.com/mcp',
	authEnv: 'CLOUDFLARE_MCP_API_TOKEN',
	optional: true,
};

const honeycomb: CatalogEntry = {
	name: 'honeycomb',
	url: 'https://mcp.honeycomb.io/mcp',
	authEnv: 'HONEYCOMB_MCP_API_TOKEN',
	optional: true,
};

const requiredLinear: CatalogEntry = {
	name: 'linear',
	url: 'https://mcp.linear.app/mcp',
	authEnv: 'LINEAR_API_KEY',
	optional: false,
};

const langfuse: CatalogEntry = {
	name: 'langfuse',
	url: 'https://us.cloud.langfuse.com/api/public/mcp',
	authEnv: 'LANGFUSE_MCP_BASIC_AUTH',
	authScheme: 'basic',
	tools: [
		'getHealth',
		'listObservations',
		'getObservation',
		'getObservationFieldSchema',
		'getObservationFilterSchema',
		'getObservationFilterValues',
		'queryMetrics',
		'getMetricsSchema',
		'listScores',
		'getScore',
	],
	optional: true,
};

describe('INTEGRATION_CATALOG', () => {
	test('ships reviewed optional Cloudflare, Honeycomb, and read-only Langfuse rows', () => {
		expect(INTEGRATION_CATALOG).toEqual([cloudflare, honeycomb, langfuse]);
	});
});

describe('resolveIntegrationCatalog', () => {
	test('resolves a present secret to static name, URL, optional policy, and Bearer auth', () => {
		const token = 'cf-token-value-for-test';

		const result = resolveIntegrationCatalog([cloudflare], {
			CLOUDFLARE_MCP_API_TOKEN: token,
		});

		expect(result.warnings).toEqual([]);
		expect(result.connections).toEqual([
			{
				name: 'cloudflare',
				url: 'https://mcp.cloudflare.com/mcp',
				optional: true,
				authorization: { kind: 'bearer', value: token },
			},
		]);
	});

	test('resolves Langfuse Basic auth and preserves its read-only tool allowlist', () => {
		const result = resolveIntegrationCatalog([langfuse], {
			LANGFUSE_MCP_BASIC_AUTH: 'encoded-project-credentials',
		});

		expect(result.warnings).toEqual([]);
		expect(result.connections).toEqual([
			{
				name: 'langfuse',
				url: 'https://us.cloud.langfuse.com/api/public/mcp',
				optional: true,
				authorization: { kind: 'basic', value: 'encoded-project-credentials' },
				tools: [
					'getHealth',
					'listObservations',
					'getObservation',
					'getObservationFieldSchema',
					'getObservationFilterSchema',
					'getObservationFilterValues',
					'queryMetrics',
					'getMetricsSchema',
					'listScores',
					'getScore',
				],
			},
		]);
	});

	test('defaults omitted optional to true', () => {
		const entry: CatalogEntry = {
			name: 'notion',
			url: 'https://mcp.notion.com/mcp',
			authEnv: 'NOTION_TOKEN',
		};

		const result = resolveIntegrationCatalog([entry], { NOTION_TOKEN: 'n-secret' });
		expect(result.connections[0]?.optional).toBe(true);
	});

	test('missing optional secret omits only that connection and emits a credential-free warning', () => {
		const token = 'super-secret-should-not-leak';

		const result = resolveIntegrationCatalog([cloudflare, requiredLinear], {
			LINEAR_API_KEY: 'lin-ok',
			// CLOUDFLARE_MCP_API_TOKEN intentionally absent
		});

		expect(result.connections).toEqual([
			{
				name: 'linear',
				url: 'https://mcp.linear.app/mcp',
				optional: false,
				authorization: { kind: 'bearer', value: 'lin-ok' },
			},
		]);
		expect(result.warnings).toEqual([
			'[mcp-catalog] skipping optional MCP "cloudflare": missing CLOUDFLARE_MCP_API_TOKEN',
		]);
		const blob = JSON.stringify(result);
		expect(blob).not.toContain(token);
		expect(blob).not.toContain('super-secret');
	});

	test('missing required secret fails before mount and names the env key, never the value', () => {
		const secret = 'lin-secret-must-not-appear';
		expect(() =>
			resolveIntegrationCatalog([requiredLinear], {
				LINEAR_API_KEY: '',
			}),
		).toThrow(/required MCP "linear" missing secret LINEAR_API_KEY/);

		let thrown: unknown;

		try {
			resolveIntegrationCatalog([requiredLinear], { LINEAR_API_KEY: undefined });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);

		if (!(thrown instanceof Error)) throw new Error('expected Error');
		expect(thrown.message).toContain('LINEAR_API_KEY');
		expect(thrown.message).not.toContain(secret);
	});

	test('rejects empty or invalid catalog fields without exposing secrets', () => {
		const secret = 'leak-me-please';

		const cases: CatalogEntry[] = [
			{ name: '', url: 'https://mcp.example.com/mcp', authEnv: 'T' },
			{ name: 'x', url: '', authEnv: 'T' },
			{ name: 'x', url: 'not-a-url', authEnv: 'T' },
			{ name: 'x', url: 'https://mcp.example.com/mcp', authEnv: '' },
		];

		for (const entry of cases) {
			let thrown: unknown;

			try {
				resolveIntegrationCatalog([entry], { T: secret });
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(Error);

			if (!(thrown instanceof Error)) throw new Error('expected Error');
			expect(thrown.message).toMatch(/\[mcp-catalog\]/);
			expect(thrown.message).not.toContain(secret);
		}
	});

	test('trims whitespace-only secrets as missing', () => {
		const result = resolveIntegrationCatalog([cloudflare], {
			CLOUDFLARE_MCP_API_TOKEN: '   ',
		});

		expect(result.connections).toEqual([]);
		expect(result.warnings[0]).toContain('CLOUDFLARE_MCP_API_TOKEN');
	});
});
