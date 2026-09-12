// Flags `async` / `await` inside a ternary (`cond ? await a() : b`,
// `cond ? async () => {} : …`). Prefer if/else: only one branch runs, and
// mixing control flow with expressions hides that.
//
// ponytail: token scan, not a parser. Ceiling: a TypeScript conditional type
// that uses the `async`/`await` keywords as names can false-positive. Upgrade:
// ESLint `no-restricted-syntax` with `ConditionalExpression AwaitExpression`
// (and `ConditionalExpression > ArrowFunctionExpression[async=true]`).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeLineStarts, createScanner, SyntaxKind } from 'typescript/unstable/ast';

const OPEN = new Set([
	SyntaxKind.OpenBraceToken,
	SyntaxKind.OpenParenToken,
	SyntaxKind.OpenBracketToken,
]);
const CLOSE = new Set([
	SyntaxKind.CloseBraceToken,
	SyntaxKind.CloseParenToken,
	SyntaxKind.CloseBracketToken,
]);
const END_ALTERNATE = new Set([
	SyntaxKind.CommaToken,
	SyntaxKind.SemicolonToken,
	SyntaxKind.CloseBraceToken,
	SyntaxKind.CloseParenToken,
	SyntaxKind.CloseBracketToken,
]);
const ASYNC_KINDS = new Set([SyntaxKind.AwaitKeyword, SyntaxKind.AsyncKeyword]);

function tokenize(text) {
	const scanner = createScanner(true);
	scanner.setText(text);
	const tokens = [];
	for (;;) {
		const kind = scanner.scan();
		if (kind === SyntaxKind.EndOfFile) break;
		tokens.push({
			kind,
			start: scanner.getTokenStart(),
			text: scanner.getTokenText(),
		});
	}
	return tokens;
}

function isTernaryQuestion(tokens, index) {
	if (tokens[index].kind !== SyntaxKind.QuestionToken) return false;
	return tokens[index + 1]?.kind !== SyntaxKind.ColonToken;
}

function findMatchingColon(tokens, questionIndex) {
	let group = 0;
	let nested = 0;
	for (let i = questionIndex + 1; i < tokens.length; i++) {
		const kind = tokens[i].kind;
		if (OPEN.has(kind)) {
			group++;
			continue;
		}
		if (CLOSE.has(kind)) {
			group--;
			continue;
		}
		if (group !== 0) continue;
		if (kind === SyntaxKind.QuestionToken && tokens[i + 1]?.kind !== SyntaxKind.ColonToken) {
			nested++;
			continue;
		}
		if (kind === SyntaxKind.ColonToken) {
			if (nested === 0) return i;
			nested--;
		}
	}
	return -1;
}

function alternateEnd(tokens, colonIndex) {
	let group = 0;
	let nested = 0;
	for (let i = colonIndex + 1; i < tokens.length; i++) {
		const kind = tokens[i].kind;
		if (OPEN.has(kind)) {
			group++;
			continue;
		}
		if (CLOSE.has(kind)) {
			if (group === 0) return i;
			group--;
			continue;
		}
		if (group !== 0) continue;
		if (kind === SyntaxKind.QuestionToken && tokens[i + 1]?.kind !== SyntaxKind.ColonToken) {
			nested++;
			continue;
		}
		if (kind === SyntaxKind.ColonToken && nested > 0) {
			nested--;
			continue;
		}
		if (END_ALTERNATE.has(kind) && nested === 0) return i;
	}
	return tokens.length;
}

function lineCol(lineStarts, pos) {
	let line = 0;
	while (line + 1 < lineStarts.length && lineStarts[line + 1] <= pos) line++;
	return { line: line + 1, column: pos - lineStarts[line] + 1 };
}

export function findAsyncTernaries(text, file = 'input.ts') {
	const tokens = tokenize(text);
	const lineStarts = computeLineStarts(text);
	const hits = [];
	for (let i = 0; i < tokens.length; i++) {
		if (!isTernaryQuestion(tokens, i)) continue;
		const colon = findMatchingColon(tokens, i);
		if (colon < 0) continue;
		const end = alternateEnd(tokens, colon);
		for (let j = i + 1; j < end; j++) {
			if (!ASYNC_KINDS.has(tokens[j].kind)) continue;
			const at = lineCol(lineStarts, tokens[j].start);
			hits.push({
				file,
				line: at.line,
				column: at.column,
				kind: tokens[j].text,
			});
			break;
		}
	}
	return hits;
}

function walkTsFiles(dir, acc = []) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walkTsFiles(path, acc);
		else if (path.endsWith('.ts')) acc.push(path);
	}
	return acc;
}

function isCli() {
	const invoked = process.argv[1];
	return invoked !== undefined && import.meta.url === pathToFileURL(invoked).href;
}

if (isCli()) {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
	const hits = [];
	for (const file of walkTsFiles(root)) {
		hits.push(...findAsyncTernaries(readFileSync(file, 'utf8'), file));
	}
	if (hits.length > 0) {
		for (const hit of hits) {
			console.error(
				`${hit.file}:${hit.line}:${hit.column}: ${hit.kind} in a ternary; use if/else`,
			);
		}
		process.exit(1);
	}
	console.log('[lint] no async/await inside ternaries');
}
