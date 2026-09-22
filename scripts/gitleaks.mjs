// Downloads a pinned gitleaks CLI (checksum-verified) and forwards argv.
// Usage: `node scripts/gitleaks.mjs git --redact --no-banner`
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '8.30.1';

const ARCHIVES = {
	'darwin-arm64': {
		file: 'gitleaks_8.30.1_darwin_arm64.tar.gz',
		sha256: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
	},
	'darwin-x64': {
		file: 'gitleaks_8.30.1_darwin_x64.tar.gz',
		sha256: 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
	},
	'linux-arm64': {
		file: 'gitleaks_8.30.1_linux_arm64.tar.gz',
		sha256: 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
	},
	'linux-x64': {
		file: 'gitleaks_8.30.1_linux_x64.tar.gz',
		sha256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
	},
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const platformKey = `${process.platform}-${process.arch}`;

const archive = ARCHIVES[platformKey];

if (!archive) {
	console.error(`[gitleaks] unsupported platform: ${platformKey}`);
	process.exit(1);
}

const cacheDir = join(root, 'node_modules', '.cache', 'gitleaks', VERSION);

const binaryPath = join(cacheDir, 'gitleaks');

async function ensureBinary() {
	if (existsSync(binaryPath)) return;
	mkdirSync(cacheDir, { recursive: true });

	const url = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${archive.file}`;
	console.error(`[gitleaks] downloading ${archive.file}`);
	const response = await fetch(url, { redirect: 'follow' });

	if (!response.ok) {
		throw new Error(`download failed: ${response.status} ${url}`);
	}

	const bytes = Buffer.from(await response.arrayBuffer());
	const sha256 = createHash('sha256').update(bytes).digest('hex');

	if (sha256 !== archive.sha256) {
		throw new Error(`checksum mismatch for ${archive.file}: got ${sha256}`);
	}

	const tarPath = join(cacheDir, archive.file);
	writeFileSync(tarPath, bytes);

	const extracted = spawnSync('tar', ['-xzf', tarPath, '-C', cacheDir, 'gitleaks'], {
		stdio: 'inherit',
	});

	if (extracted.status !== 0) {
		throw new Error(`failed to extract ${archive.file}`);
	}

	chmodSync(binaryPath, 0o755);
}

const forwarded = process.argv.slice(2);

const gitleaksArgs = forwarded.length > 0 ? forwarded : ['git', '--redact', '--no-banner'];

await ensureBinary();

const result = spawnSync(binaryPath, gitleaksArgs, { cwd: root, stdio: 'inherit' });

if (result.error) {
	console.error(result.error);
	process.exit(1);
}

process.exit(result.status ?? 1);
