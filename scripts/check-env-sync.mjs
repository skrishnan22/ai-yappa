// Warns when `.env` (Flue/`flue run`) and `.dev.vars` (workerd via the
// Cloudflare Vite plugin) disagree on secret *values*. If `.dev.vars` exists,
// the plugin ignores `.env` for the Worker isolate, so a rotated key in one
// file silently stops applying to the other runtime.
//
// Usage: `npm run check:env`. Exits 0 with a warning (drift is advisory —
// `loadServerEnv()` in src/env.ts is the hard gate).
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Local-only hostnames never need to match across runtimes.
const IGNORED_KEYS = new Set(['TUNNEL_HOSTNAME']);

function parseDotenv(path) {
	const vars = new Map();
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		vars.set(key, value);
	}
	return vars;
}

const envPath = join(root, '.env');
const devVarsPath = join(root, '.dev.vars');

if (!existsSync(envPath) || !existsSync(devVarsPath)) {
	console.log('[check:env] skipping: need both .env and .dev.vars present');
	process.exit(0);
}

const env = parseDotenv(envPath);
const devVars = parseDotenv(devVarsPath);
const drift = [];

for (const [key, value] of env) {
	if (IGNORED_KEYS.has(key) || value === 'replace-me' || value === '') continue;
	if (devVars.has(key) && devVars.get(key) !== value) drift.push(key);
}
for (const [key, value] of devVars) {
	if (IGNORED_KEYS.has(key) || value.includes('REPLACE_ME') || value === '') continue;
	if (!env.has(key)) drift.push(`${key} (only in .dev.vars)`);
}

if (drift.length > 0) {
	console.warn(`[check:env] WARNING: .env and .dev.vars disagree on: ${drift.join(', ')}`);
	console.warn('[check:env] The Cloudflare plugin ignores .env when .dev.vars exists.');
	process.exit(0);
}
console.log('[check:env] .env and .dev.vars agree on shared secret keys');
