import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

const persistence = mkdtempSync(join(tmpdir(), 'slack-question-smoke-'));

function wrangler(args) {
	execFileSync(
		'pnpm',
		['exec', 'wrangler', 'd1', ...args, '--local', '--persist-to', persistence],
		{
			cwd: root,
			stdio: 'inherit',
			env: { ...process.env, CI: 'true' },
		},
	);
}

try {
	wrangler(['migrations', 'apply', 'APP_DB']);
	wrangler(['execute', 'APP_DB', '--file', 'scripts/question-store-smoke.sql']);
	console.log('Question SQL smoke passed against a fresh local D1 database.');
} finally {
	rmSync(persistence, { recursive: true, force: true });
}
