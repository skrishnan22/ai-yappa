// Flags `await` expressions and `async` functions/methods inside a ternary.
// Prefer if/else: only one branch runs, and mixing control flow with
// expressions hides that.
//
// ponytail: token scan, not a parser. Ceiling: comparison `<` after an
// identifier can be mistaken for type args until a non-type token; `>>` in
// nested generics is handled. Upgrade: ESLint `no-restricted-syntax` with
// `ConditionalExpression AwaitExpression` and
// `ConditionalExpression > ArrowFunctionExpression[async=true]`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeLineStarts, createScanner, SyntaxKind } from 'typescript/unstable/ast';

const OPEN = new Map([
	[SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken],
	[SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken],
	[SyntaxKind.OpenBracketToken, SyntaxKind.CloseBracketToken],
]);
const CLOSE = new Map(
	[...OPEN.entries()].map(([open, close]) => [close, open]),
);
const TYPE_ARG_ABORT = new Set([
	SyntaxKind.SemicolonToken,
	SyntaxKind.AmpersandAmpersandToken,
	SyntaxKind.BarBarToken,
	SyntaxKind.QuestionQuestionToken,
	SyntaxKind.EqualsEqualsToken,
	SyntaxKind.ExclamationEqualsToken,
	SyntaxKind.EqualsEqualsEqualsToken,
	SyntaxKind.ExclamationEqualsEqualsToken,
	SyntaxKind.PlusToken,
	SyntaxKind.MinusToken,
	SyntaxKind.AsteriskToken,
	SyntaxKind.SlashToken,
	SyntaxKind.PercentToken,
	SyntaxKind.EqualsToken,
]);
const TYPE_ARG_PREV = new Set([
	SyntaxKind.Identifier,
	SyntaxKind.ThisKeyword,
	SyntaxKind.CloseParenToken,
	SyntaxKind.CloseBracketToken,
	SyntaxKind.GreaterThanToken,
]);

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

function greaterCount(kind) {
	if (kind === SyntaxKind.GreaterThanToken) return 1;
	if (kind === SyntaxKind.GreaterThanGreaterThanToken) return 2;
	if (kind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) return 3;
	return 0;
}

function isTypeArgList(tokens, ltIndex) {
	if (!TYPE_ARG_PREV.has(tokens[ltIndex - 1]?.kind)) return false;
	let depth = 1;
	let braces = 0;
	let parens = 0;
	let brackets = 0;
	for (let i = ltIndex + 1; i < tokens.length; i++) {
		const kind = tokens[i].kind;
		if (kind === SyntaxKind.OpenBraceToken) {
			braces++;
			continue;
		}
		if (kind === SyntaxKind.CloseBraceToken) {
			if (braces === 0) return false;
			braces--;
			continue;
		}
		if (kind === SyntaxKind.OpenParenToken) {
			parens++;
			continue;
		}
		if (kind === SyntaxKind.CloseParenToken) {
			if (parens === 0) return false;
			parens--;
			continue;
		}
		if (kind === SyntaxKind.OpenBracketToken) {
			brackets++;
			continue;
		}
		if (kind === SyntaxKind.CloseBracketToken) {
			if (brackets === 0) return false;
			brackets--;
			continue;
		}
		if (kind === SyntaxKind.LessThanToken) {
			depth++;
			continue;
		}
		const close = greaterCount(kind);
		if (close > 0) {
			depth -= close;
			if (depth === 0) return true;
			if (depth < 0) return false;
			continue;
		}
		if (braces > 0 || parens > 0 || brackets > 0) continue;
		if (TYPE_ARG_ABORT.has(kind)) return false;
	}
	return false;
}

function stepGroup(tokens, i, stack) {
	const kind = tokens[i].kind;
	const closer = OPEN.get(kind);
	if (closer !== undefined) {
		stack.push(kind);
		return 'open';
	}
	const opener = CLOSE.get(kind);
	if (opener !== undefined) {
		if (stack.at(-1) === opener) {
			stack.pop();
			return 'close';
		}
		return stack.length === 0 ? 'unmatched-close' : 'other';
	}
	if (kind === SyntaxKind.LessThanToken && isTypeArgList(tokens, i)) {
		stack.push(SyntaxKind.LessThanToken);
		return 'open';
	}
	const close = greaterCount(kind);
	if (close > 0 && stack.at(-1) === SyntaxKind.LessThanToken) {
		for (let n = 0; n < close && stack.at(-1) === SyntaxKind.LessThanToken; n++) {
			stack.pop();
		}
		return 'close';
	}
	return 'other';
}

function isTernaryQuestion(tokens, index) {
	if (tokens[index].kind !== SyntaxKind.QuestionToken) return false;
	return tokens[index + 1]?.kind !== SyntaxKind.ColonToken;
}

function findMatchingColon(tokens, questionIndex) {
	const stack = [];
	let nested = 0;
	for (let i = questionIndex + 1; i < tokens.length; i++) {
		if (stepGroup(tokens, i, stack) !== 'other' || stack.length > 0) continue;
		if (isTernaryQuestion(tokens, i)) {
			nested++;
			continue;
		}
		if (tokens[i].kind === SyntaxKind.ColonToken) {
			if (nested === 0) return i;
			nested--;
		}
	}
	return -1;
}

function alternateEnd(tokens, colonIndex) {
	const stack = [];
	let nested = 0;
	for (let i = colonIndex + 1; i < tokens.length; i++) {
		const step = stepGroup(tokens, i, stack);
		if (step === 'unmatched-close') return i;
		if (step !== 'other' || stack.length > 0) continue;
		if (isTernaryQuestion(tokens, i)) {
			nested++;
			continue;
		}
		if (tokens[i].kind === SyntaxKind.ColonToken && nested > 0) {
			nested--;
			continue;
		}
		if (nested === 0 && (tokens[i].kind === SyntaxKind.CommaToken || tokens[i].kind === SyntaxKind.SemicolonToken)) {
			return i;
		}
	}
	return tokens.length;
}

function skipDotOrLabel(tokens, i) {
	return tokens[i - 1]?.kind === SyntaxKind.DotToken || tokens[i + 1]?.kind === SyntaxKind.ColonToken;
}

function arrowAfterParens(tokens, openIndex) {
	let depth = 0;
	for (let i = openIndex; i < tokens.length; i++) {
		const kind = tokens[i].kind;
		if (kind === SyntaxKind.OpenParenToken) depth++;
		else if (kind === SyntaxKind.CloseParenToken) {
			depth--;
			if (depth === 0) return tokens[i + 1]?.kind === SyntaxKind.EqualsGreaterThanToken;
		}
	}
	return false;
}

function isAsyncControlFlow(tokens, i) {
	const kind = tokens[i].kind;
	if (kind === SyntaxKind.AwaitKeyword) return !skipDotOrLabel(tokens, i);
	if (kind !== SyntaxKind.AsyncKeyword || skipDotOrLabel(tokens, i)) return false;
	const next = tokens[i + 1]?.kind;
	if (next === SyntaxKind.FunctionKeyword) return true;
	if (next === SyntaxKind.OpenParenToken) return arrowAfterParens(tokens, i + 1);
	if (next === SyntaxKind.Identifier && tokens[i + 2]?.kind === SyntaxKind.EqualsGreaterThanToken) return true;
	if (next === SyntaxKind.Identifier && tokens[i + 2]?.kind === SyntaxKind.OpenParenToken) return true;
	return false;
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
	const seen = new Set();
	for (let i = 0; i < tokens.length; i++) {
		if (!isTernaryQuestion(tokens, i)) continue;
		const colon = findMatchingColon(tokens, i);
		if (colon < 0) continue;
		const end = alternateEnd(tokens, colon);
		for (let j = i + 1; j < end; j++) {
			if (!isAsyncControlFlow(tokens, j) || seen.has(tokens[j].start)) continue;
			seen.add(tokens[j].start);
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
