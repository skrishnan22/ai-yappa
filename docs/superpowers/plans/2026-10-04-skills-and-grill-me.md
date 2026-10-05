# Skills and `/grill-me` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Coworker Agent Skills invoked with `/<name>` in a Slack mention, starting with `/grill-me`. Later, grill sessions become a multi-person question/answer flow with buttons.

**Architecture:** The work ships as a stack of four small PRs. Each PR merges on its own and leaves `main` working. This document has the stack overview and the detailed plan for **PR 1 only**. Each later PR is planned in detail just before it starts, so review of the previous PR can change it.

**Tech Stack:** TypeScript, Flue (`useSkill`, `SKILL.md` imports), `@flue/slack`, Cloudflare Workers, D1 (from PR 2), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-04-skills-and-grill-me-design.md`

## PR stack

| PR | Scope | User-visible change |
|---|---|---|
| **1. Skills + `/grill-me` (text only)** | `src/skills/` registry; `useSkill` mounting; `/name` parsing in mentions passed as the `invokedSkill` signal attribute; the adapted `grill-me` skill asking plain-text questions one at a time | `@aiyappa /grill-me <topic>` runs a grill session. It works well solo. In a group it is still noisy, because every reply triggers a run (today's behavior) |
| **2. D1 foundation** | `APP_DB` binding, `migrations/`, `QuestionStore` interface with D1 implementation and in-memory fake, SQL smoke script | None |
| **3. Question buttons** | `ask_question` / `close_question` tools, question block rendering, `/channels/slack/interactions` (vote, Submit, first-wins), manifest interactivity URL, ADR 0022 amending ADR 0019 | The agent can post questions with buttons. Unmentioned replies still trigger runs |
| **4. Listen mode + group UX** | Ingress stays silent while a question is open; a solo reply or click submits; a newcomer flips the thread to group; `grill-me` switches to `ask_question`; `CONTEXT.md` / `AGENTS.md` updates | The full group grill experience |

If PR 3 is too large when it is planned, split it. 3a: tools and rendering, posting option buttons but no Submit; a click only records a vote. 3b: Submit and dispatch.

Notes for later PRs, found while planning PR 1:
- `CONTEXT.md` already defines **Pending Question**: "a durable question left on an Agent Conversation after the asking Submission completes … expires after seven days". PR 3 must reconcile the spec's "Question" with this term: reuse it or rename one of them. Do not add a second glossary entry for the same idea.
- Vitest cannot run Flue's Vite plugin, which requires `@cloudflare/vite-plugin`. PR 1 stubs `.md` imports in Vitest. The real `SKILL.md` packaging is checked by `pnpm run build`.

---

# PR 1: Skills + `/grill-me` (text only)

Branch: `t3code/execute-implementation-plan`. Plan and spec copied from the design worktree `t3code-6de0ee50`. PR title: "Add skills and /grill-me".

> **Revised after review (2026-10-05).** Tasks below describe the first implementation; the spec wins where they conflict.
> - The Slack ingress does not parse skills (`admit.ts`, `slack.ts`, `signal-attributes.ts` are unchanged from `main`). The Coworker reads `/<name>` from the delivered mention (`src/skills/invocation.ts`).
> - On `/<name>`, a `useAgentStart` hook appends a `skill_invoked` signal telling the model to call `activate_skill`, and a `useAgentFinish` guard enforces it. No `invokedSkill` attribute or system-prompt line.
> - Several skills in one mention are all invoked rather than refused.
> - `grill-me` auto-activates from its description as well as `/grill-me`.

## Global Constraints

- Only `app_mention` text is parsed for `/name`. Unmentioned replies (`slack.message`) are plain text.
- `/name` matches only names in the skill registry. Unknown `/words`, paths (`/usr/bin`), and URLs are left untouched.
- Two **different** skill names in one mention is a `bad-args` refusal. The same name twice is allowed.
- The matched `/name` and the spaces before it are removed from the body the model reads, the same way `$model:` is removed.
- `$model:` / `$effort:` parsing still runs only on the mention that creates the conversation (ADR 0021). It runs on the body after the skill is removed.
- A skill's `name` frontmatter must equal its directory name and its registry key: lowercase, digits, and single hyphens, at most 64 characters.
- The `grill-me` skill credits `mattpocock/skills` `productivity/grilling` (MIT).
- Repo conventions:
  - check optional values by truthiness (`AGENTS.md` Conventions);
  - tabs and single quotes (Oxfmt);
  - run `pnpm run lint`, `pnpm run fmt:check`, `pnpm run check:types`, and `pnpm test` before every commit.

## Review Focus

1. **A mention that only names the skill, for example `@aiyappa /grill-me`.** The body becomes just `<@BOT>`. Expected: dispatch proceeds with `invokedSkill: 'grill-me'`, and the skill asks what to grill. Test in Task 2.
2. **A skill name ending a sentence or followed by punctuation, for example `let's /grill-me.` or `/grill-me, please`.** Expected: matched. Test in Task 2.
3. **A skill name inside a URL or path, for example `https://x.dev/grill-me` or `/grill-me/notes`.** Expected: not matched, text unchanged. Test in Task 2.
4. **`/grill-me` on a later mention in an existing thread.** Expected: the skill is still invoked (unlike `$model:`), and `$model:` in the same text is left as plain text. Test in Task 3.
5. **Mixed case, `/Grill-Me`.** Expected: matched and normalized to `grill-me`. Test in Task 2.

---

### Task 1: Skill registry, the `grill-me` skill, and mounting

**Files:**
- Modify: `vitest.config.ts`
- Create: `src/skills/grill-me/SKILL.md`
- Create: `src/skills/index.ts`
- Create: `src/skills/index.test.ts`
- Modify: `src/agents/coworker.ts` (imports, and the mount next to the other `useTool` calls)
- Modify: `src/sandboxes/hydrate.ts:50-73` (`coworkerInstructions`)
- Modify: `src/sandboxes/hydrate.test.ts` (`describe('coworkerInstructions')`)

**Interfaces:**
- Produces:
  - `skills: { 'grill-me': SkillReference }` (exported const), used by `coworker.ts`;
  - `skillNames: ReadonlySet<string>`, used by Task 3 (`slack.ts`).

- [x] **Step 1: Stub `.md` imports for Vitest**

Replace `vitest.config.ts` with:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		{
			// Flue's Vite plugin packages `SKILL.md` imports, but it needs the
			// Cloudflare plugin and cannot run under Vitest. Tests never render an
			// agent, so a stand-in module is enough; `pnpm run build` checks the
			// real packaging.
			name: 'stub-markdown-imports',
			enforce: 'pre',
			load(id) {
				if (!id.endsWith('.md')) return undefined;

				return `export default ${JSON.stringify({ stubbedMarkdown: id })};`;
			},
		},
	],
	test: {
		include: ['src/**/*.test.ts'],
	},
});
```

- [x] **Step 2: Write the failing registry test**

Create `src/skills/index.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { skillNames, skills } from './index.ts';

const SKILLS_DIR = join(import.meta.dirname, '.');

function frontmatterName(skillDir: string): string | undefined {
	const text = readFileSync(join(SKILLS_DIR, skillDir, 'SKILL.md'), 'utf8');

	return /^---\n[\s\S]*?^name:\s*(\S+)\s*$/m.exec(text)?.[1];
}

describe('skill registry', () => {
	test('registers every skill directory under its frontmatter name', () => {
		const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();

		expect(Object.keys(skills).sort()).toEqual(dirs);

		for (const dir of dirs) {
			expect(frontmatterName(dir)).toBe(dir);
		}
	});

	test('exposes the names for the Slack ingress', () => {
		expect([...skillNames]).toEqual(Object.keys(skills));
		expect(skillNames.has('grill-me')).toBe(true);
	});
});
```

- [x] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/skills/index.test.ts`
Expected: FAIL, because `./index.ts` does not exist.

- [x] **Step 4: Write the skill**

Create `src/skills/grill-me/SKILL.md`:

```markdown
---
name: grill-me
description: Interview a person or a team relentlessly about a plan, design, or decision until every branch is settled. Use only when the Slack signal's invokedSkill attribute is grill-me; never activate it on your own.
license: MIT
metadata:
  adapted-from: https://github.com/mattpocock/skills/tree/main/skills/productivity/grilling
---

Interview the people in this thread relentlessly until you reach a shared understanding of their plan. Map it as a **design tree**: every decision branches into the decisions that depend on it.

**Frontier.** The frontier is every decision whose prerequisites are settled: the questions you can ask now without guessing at answers you haven't heard. Never ask a question whose answer depends on one that is still open.

**One question at a time.** Each message asks exactly one frontier question: the one that unblocks the most other decisions. After every answer, recompute the frontier. Several people may answer in this thread, and one question keeps their discussion in one place.

Post each question with reply_in_slack_thread in this shape:

❓ **Q<n> · <short title>**
<what they need to know to answer; for a discrete decision, list the options as A) B) C)>

➡️ <your recommended answer, and one line on why>

Give options only when the decision is genuinely discrete. Otherwise ask the question open.

**Facts are your job; decisions are theirs.** When a question needs a fact from the repository or the web, look it up yourself with read-only tools before asking. Never ask for something you could find. Put every decision to the people.

**Reading answers.** Thread context carries everyone's replies.
- Credit each decision to the people who made it.
- When people disagree, do not settle it by majority without saying so. Ask a narrower follow-up that names who disagreed.
- When a reply is discussion between people rather than an answer, keep your response to one line and restate the open question.
- When an answer is unclear, the question stays on the frontier. Say what is unclear.

**Discussion only.** A grill session never edits files, creates commits, checkpoints, or opens pull requests.

**Finish.** The session is done when the frontier is empty: every branch visited, nothing silently assumed. Then post a summary that lists each question, its decision, and who decided it. Ask them to confirm the shared understanding. Offer next steps (a spec, an issue, an implementation), but take none until asked.

**Stopping.** If someone asks you to stop, confirm and stop asking questions.

If the invocation names no topic, your first question is what they want to grill.
```

- [x] **Step 5: Write the registry**

Create `src/skills/index.ts`:

```ts
import grillMe from './grill-me/SKILL.md';

// Deployment skills, keyed by their `SKILL.md` name. The Coworker mounts
// every entry; the Slack ingress invokes one with `/<name>` in a mention.
export const skills = {
	'grill-me': grillMe,
};

export const skillNames: ReadonlySet<string> = new Set(Object.keys(skills));
```

- [x] **Step 6: Run the registry test to verify it passes**

Run: `pnpm vitest run src/skills/index.test.ts`
Expected: PASS (2 tests)

- [x] **Step 7: Write the failing instructions test**

In `src/sandboxes/hydrate.test.ts`, inside `describe('coworkerInstructions', …)`, add:

```ts
	test('activates a skill the invocation names', () => {
		const prompt = coworkerInstructions('https://github.com/skrishnan22/codevil.git');
		expect(prompt).toMatch(/invokedSkill/);
		expect(prompt).toMatch(/activate_skill/);
	});
```

Run: `pnpm vitest run src/sandboxes/hydrate.test.ts`
Expected: FAIL on the new test.

- [x] **Step 8: Add the instruction**

In `src/sandboxes/hydrate.ts` `coworkerInstructions`, insert after the `'Signal attributes may include threadContext: …'` line:

```ts
		'When the signal attributes include invokedSkill, call activate_skill with that name before anything else and follow the skill for the rest of the conversation.',
```

Run: `pnpm vitest run src/sandboxes/hydrate.test.ts`
Expected: PASS

- [x] **Step 9: Mount the skills on the Coworker**

In `src/agents/coworker.ts`:
- add `useSkill` to the `@flue/runtime` import list (alphabetical, after `useSandbox`);
- add `import { skills } from '../skills/index.ts';` after the `../sandboxes/hydrate.ts` import;
- add this block after the `webSearchTools` loop:

```ts
	for (const skill of Object.values(skills)) {
		useSkill(skill);
	}
```

- [x] **Step 10: Verify the build packages the skill**

Run: `pnpm run check:types && pnpm test && pnpm run build`
Expected:
- types are clean;
- all tests pass;
- `vite build` succeeds with no Flue skill-validation error. An invalid `SKILL.md` frontmatter fails here, not in Vitest.

- [x] **Step 11: Lint, format, commit**

```bash
pnpm run lint && pnpm run fmt:check
git add vitest.config.ts src/skills src/agents/coworker.ts src/sandboxes/hydrate.ts src/sandboxes/hydrate.test.ts
git commit -m "Mount deployment skills and add grill-me"
```

---

### Task 2: Parse `/name` from mention text

**Files:**
- Create: `src/channels/skill-invocation.ts`
- Create: `src/channels/skill-invocation.test.ts`

**Interfaces:**
- Consumes: nothing. The names are injected, which keeps the function pure.
- Produces:

```ts
export type SkillInvocationResult =
	| { ok: true; skill?: string; body: string }
	| { ok: false; error: string };
export function parseSkillInvocation(text: string, names: ReadonlySet<string>): SkillInvocationResult;
```

- [x] **Step 1: Write the failing tests**

Create `src/channels/skill-invocation.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { parseSkillInvocation } from './skill-invocation.ts';

const names = new Set(['grill-me', 'review']);

describe('parseSkillInvocation', () => {
	test('reads a registered /name and strips it', () => {
		expect(parseSkillInvocation('<@U1> /grill-me should we move auth?', names)).toEqual({
			ok: true,
			skill: 'grill-me',
			body: '<@U1> should we move auth?',
		});
	});

	test('accepts a mention that only names the skill', () => {
		expect(parseSkillInvocation('<@U1> /grill-me', names)).toEqual({
			ok: true,
			skill: 'grill-me',
			body: '<@U1>',
		});
	});

	test('matches at the start, before punctuation, and in any case', () => {
		expect(parseSkillInvocation('/grill-me the plan', names)).toMatchObject({ skill: 'grill-me' });
		expect(parseSkillInvocation("<@U1> let's /grill-me.", names)).toEqual({
			ok: true,
			skill: 'grill-me',
			body: "<@U1> let's.",
		});
		expect(parseSkillInvocation('<@U1> /grill-me, please', names)).toMatchObject({
			skill: 'grill-me',
		});
		expect(parseSkillInvocation('<@U1> /Grill-Me plan', names)).toMatchObject({
			skill: 'grill-me',
		});
	});

	test('leaves paths, URLs, and unknown names alone', () => {
		for (const text of [
			'<@U1> check /usr/bin and /tmp',
			'<@U1> see https://x.dev/grill-me',
			'<@U1> notes in /grill-me/notes',
			'<@U1> run /deploy now',
		]) {
			expect(parseSkillInvocation(text, names)).toEqual({ ok: true, body: text });
		}
	});

	test('keeps the line structure of the rest of the message', () => {
		expect(parseSkillInvocation('<@U1> /grill-me\nline two\n  indented', names)).toEqual({
			ok: true,
			skill: 'grill-me',
			body: '<@U1>\nline two\n  indented',
		});
	});

	test('refuses two different skills and allows a repeat', () => {
		expect(parseSkillInvocation('<@U1> /grill-me then /review', names)).toEqual({
			ok: false,
			error: 'One skill per message: `/grill-me` and `/review`.',
		});
		expect(parseSkillInvocation('<@U1> /grill-me x /grill-me', names)).toEqual({
			ok: true,
			skill: 'grill-me',
			body: '<@U1> x',
		});
	});
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/channels/skill-invocation.test.ts`
Expected: FAIL, because `./skill-invocation.ts` does not exist.

- [x] **Step 3: Implement**

Create `src/channels/skill-invocation.ts`:

```ts
export type SkillInvocationResult =
	| { ok: true; skill?: string; body: string }
	| { ok: false; error: string };

// `/grill-me` as its own word, with the spaces before it so removing it
// leaves no gap. It must start the text or follow whitespace, and end at
// whitespace, the end, or sentence punctuation, so paths (`/usr/bin`) and
// URLs never match.
const SKILL = /[ \t]*(?<!\S)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?![^\s.,!?;:])/gi;

/**
 * Reads `/<name>` for a registered skill from a Slack mention and removes it
 * from the text the model reads. Unknown names stay as ordinary text.
 */
export function parseSkillInvocation(
	text: string,
	names: ReadonlySet<string>,
): SkillInvocationResult {
	let skill: string | undefined;

	for (const [, raw = ''] of text.matchAll(SKILL)) {
		const name = raw.toLowerCase();

		if (!names.has(name)) continue;

		if (skill && skill !== name) {
			return { ok: false, error: `One skill per message: \`/${skill}\` and \`/${name}\`.` };
		}

		skill = name;
	}

	if (!skill) return { ok: true, body: text };

	const body = text
		.replace(SKILL, (match, raw: string) => (names.has(raw.toLowerCase()) ? '' : match))
		.trim();

	return { ok: true, skill, body };
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/channels/skill-invocation.test.ts`
Expected: PASS (6 tests). If `"<@U1> let's /grill-me."` produces `"<@U1> let's ."`, the regex consumed the space but not the period. Check that the leading `[ \t]*` is outside the lookbehind, as written.

- [x] **Step 5: Lint, format, commit**

```bash
pnpm run lint && pnpm run fmt:check && pnpm run check:types
git add src/channels/skill-invocation.ts src/channels/skill-invocation.test.ts
git commit -m "Parse /skill invocations from Slack mentions"
```

---

### Task 3: Wire skill invocation through admission and dispatch; docs

**Files:**
- Modify: `src/channels/admit.ts` (`InvocationDecision`, `decideInvocation`)
- Modify: `src/channels/admit.test.ts` (`describe('decideInvocation')`)
- Modify: `src/channels/signal-attributes.ts`
- Modify: `src/channels/signal-attributes.test.ts`
- Modify: `src/channels/slack.ts` (the `decideInvocation` call and `buildSignalAttributes` call in `admitThread`)
- Modify: `src/channels/slack.test.ts`
- Modify: `AGENTS.md` (Layout), `CONTEXT.md` (new **Skill** entry)

**Interfaces:**
- Consumes:
  - `parseSkillInvocation(text, names)` (Task 2);
  - `skillNames` (Task 1).
- Produces:
  - `decideInvocation(args: { signalType; text; chatgptConnected; conversationExists; skillNames: ReadonlySet<string> })`;
  - the `proceed` decision gains `invokedSkill?: string`;
  - `buildSignalAttributes(eventId, userId, threadContext, invokedSkill?)`;
  - `SignalAttributes` gains `invokedSkill?: string`.

- [x] **Step 1: Write the failing admission tests**

In `src/channels/admit.test.ts`, update `describe('decideInvocation', …)`.
- Add `skillNames` to the `mention` helper:

```ts
	const skillNames = new Set(['grill-me']);
	const mention = (text: string, chatgptConnected = true) =>
		decideInvocation({
			signalType: 'slack.app_mention',
			text,
			chatgptConnected,
			conversationExists: false,
			skillNames,
		});
```

- Add `skillNames,` to both direct `decideInvocation({ … })` calls in `'leaves unmentioned replies and later mentions as plain text'`.
- Then add:

```ts
	test('invokes a skill on the creating mention, alongside model arguments', () => {
		expect(mention('<@U1> $model:kimi /grill-me the auth plan')).toEqual({
			kind: 'proceed',
			body: '<@U1> the auth plan',
			invokedSkill: 'grill-me',
			modelChoice: { model: { provider: 'opencode-go', modelId: 'kimi-k3' } },
		});
	});

	test('invokes a skill on a later mention but leaves model arguments as text', () => {
		expect(
			decideInvocation({
				signalType: 'slack.app_mention',
				text: '<@U1> /grill-me $model:luna round two',
				chatgptConnected: true,
				conversationExists: true,
				skillNames,
			}),
		).toEqual({
			kind: 'proceed',
			body: '<@U1> $model:luna round two',
			invokedSkill: 'grill-me',
		});
	});

	test('never reads a skill from an unmentioned reply', () => {
		expect(
			decideInvocation({
				signalType: 'slack.message',
				text: '/grill-me please',
				chatgptConnected: true,
				conversationExists: true,
				skillNames,
			}),
		).toEqual({ kind: 'proceed', body: '/grill-me please' });
	});

	test('refuses two different skills', () => {
		const refused = decideInvocation({
			signalType: 'slack.app_mention',
			text: '<@U1> /grill-me /review',
			chatgptConnected: true,
			conversationExists: true,
			skillNames: new Set(['grill-me', 'review']),
		});

		expect(refused).toEqual({
			kind: 'bad-args',
			reply: 'One skill per message: `/grill-me` and `/review`.',
		});
	});
```

Without `$effort:`, the recorded choice has no `thinkingLevel`. `coworkerModel` applies the `high` default at render, not here.

- [x] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/channels/admit.test.ts`
Expected: FAIL. The new tests fail, and type errors on `skillNames` show up in `pnpm run check:types`.

- [x] **Step 3: Implement in `admit.ts`**

Add the import:

```ts
import { parseSkillInvocation } from './skill-invocation.ts';
```

Change the `proceed` variant:

```ts
	| { kind: 'proceed'; body: string; modelChoice?: ModelChoice; invokedSkill?: string };
```

Replace `decideInvocation` and update its doc comment:

```ts
/**
 * A mention may invoke one deployment skill with `/<name>`, on any mention.
 * Inline `$model:` / `$effort:` arguments count only on the mention that
 * creates a conversation; replies and later mentions leave them as plain
 * text, because the thread's choice is already recorded and they could not
 * change it. A ChatGPT model is refused while ChatGPT is not usable, so
 * asking for Luna never silently gets DeepSeek.
 */
export function decideInvocation(args: {
	signalType: SlackSignal;
	text: string;
	chatgptConnected: boolean;
	conversationExists: boolean;
	skillNames: ReadonlySet<string>;
}): InvocationDecision {
	if (args.signalType !== 'slack.app_mention') return { kind: 'proceed', body: args.text };

	const skill = parseSkillInvocation(args.text, args.skillNames);

	if (!skill.ok) return { kind: 'bad-args', reply: skill.error };

	const invoked = skill.skill ? { invokedSkill: skill.skill } : {};

	if (args.conversationExists) return { kind: 'proceed', body: skill.body, ...invoked };

	const parsed = parseInvocationArgs(skill.body);

	if (!parsed.ok) return { kind: 'bad-args', reply: `${parsed.error}\n${modelHelpText()}` };

	const resolved = resolveModelChoice(parsed.args);

	if (!resolved.ok) return { kind: 'bad-args', reply: `${resolved.error}\n${modelHelpText()}` };

	const { choice } = resolved;

	if (choice?.model?.provider === 'chatgpt' && !args.chatgptConnected) {
		return {
			kind: 'model-unavailable',
			reply: `ChatGPT isn't connected, so \`${choice.model.modelId}\` isn't available. Pick an OpenCode Go model, or ask a Codex admin to run \`/aiyappa openai connect\`.\n${modelHelpText()}`,
		};
	}

	return { kind: 'proceed', body: parsed.args.body, modelChoice: choice, ...invoked };
}
```

- [x] **Step 4: Run the admission tests**

Run: `pnpm vitest run src/channels/admit.test.ts`
Expected: PASS

- [x] **Step 5: Signal attributes, test first**

In `src/channels/signal-attributes.test.ts`, add:

```ts
	test('carries an invoked skill', () => {
		expect(buildSignalAttributes('Ev4', 'U_A', undefined, 'grill-me')).toEqual({
			eventId: 'Ev4',
			userId: 'U_A',
			invokedSkill: 'grill-me',
		});
	});
```

Run: `pnpm vitest run src/channels/signal-attributes.test.ts`. Expected: FAIL.

Replace `src/channels/signal-attributes.ts` with:

```ts
// Signal attributes are string→string. userId is the author of *this* message,
// which may differ from the thread starter in initialData.startedBy.
export type SignalAttributes = {
	eventId: string;
	userId?: string;
	threadContext?: string;
	invokedSkill?: string;
};

export function buildSignalAttributes(
	eventId: string,
	userId: string | undefined,
	threadContext: string | undefined,
	invokedSkill?: string,
): SignalAttributes {
	const attributes: SignalAttributes = { eventId };

	if (userId) attributes.userId = userId;

	if (threadContext) attributes.threadContext = threadContext;

	if (invokedSkill) attributes.invokedSkill = invokedSkill;

	return attributes;
}
```

Run again. Expected: PASS.

- [x] **Step 6: Ingress test, test first**

In `src/channels/slack.test.ts`, inside `describe('Slack ingress', …)`, add a test modeled on `'leaves model arguments untouched on a later app mention'`. Copy its `runtime` and `slackClient` setup exactly, then:

```ts
	test('passes an invoked skill to the agent and strips it from the body', async () => {
		const dispatchRequests: Array<Parameters<SlackRuntime['dispatch']>[1]> = [];

		const runtime: SlackRuntime = {
			dispatch: async (_agent, request) => {
				dispatchRequests.push(request);

				return {
					submissionId: 'submission',
					acceptedAt: '2026-10-04T00:00:00.000Z',
					uid: 'uid',
				};
			},
			getAgentInstance: async () => ({ id: 'instance', uid: 'uid' }),
		};

		const slackClient: SlackBotClient = {
			chat: {
				postMessage: async () => ({ ok: true }),
				update: async () => ({ ok: true }),
			},
			conversations: {
				replies: async () => ({ ok: true, messages: [] }),
			},
		};

		__setSlackClientFactoryForTests(() => slackClient);

		const channel = createSlackChannelForEnv(env, codexAuth, runtime);

		const response = await channel.route().fetch(
			signedEventRequest(
				eventPayload({
					eventId: 'Ev-grill',
					type: 'app_mention',
					user: THREAD_STARTER,
					text: '<@UBOT> /grill-me the auth plan',
					ts: THREAD_TS,
				}),
			),
		);

		expect(response.status).toBe(200);
		expect(dispatchRequests).toHaveLength(1);
		expect(dispatchRequests[0]?.message).toMatchObject({
			body: '<@UBOT> the auth plan',
			attributes: { invokedSkill: 'grill-me' },
		});
	});
```

Run: `pnpm vitest run src/channels/slack.test.ts`. Expected: FAIL (type error or missing attribute).

- [x] **Step 7: Wire `slack.ts`**

In `src/channels/slack.ts`:
- add `import { skillNames } from '../skills/index.ts';`;
- in `admitThread`, pass `skillNames` to `decideInvocation`:

```ts
			const invocation = decideInvocation({
				signalType,
				text,
				chatgptConnected: modelRoute === 'chatgpt',
				conversationExists,
				skillNames,
			});
```

- change the attributes line to:

```ts
			const attributes = {
				...buildSignalAttributes(eventId, userId, threadContext, invocation.invokedSkill),
				modelRoute,
			};
```

Run: `pnpm vitest run src/channels/slack.test.ts`. Expected: PASS.

- [x] **Step 8: Docs**

`AGENTS.md`, Layout section: add after the `src/channels/invocation-args.ts` bullet:

```markdown
- `src/skills/` — deployment Agent Skills (`<name>/SKILL.md`, registered in `index.ts`). The Coworker mounts all of them with `useSkill`; `/<name>` in any mention invokes one (`src/channels/skill-invocation.ts`, passed as the `invokedSkill` signal attribute). Vitest stubs `.md` imports; `pnpm run build` validates real packaging.
```

`CONTEXT.md`: add after the **Model Choice** entry:

```markdown
**Skill**:
A packaged procedure the Coworker loads on demand (Agent Skills format). Deployment skills live in `src/skills/`; a mention invokes one with `/<name>`, and skills in the bound repository's `.agents/skills/` are discovered but not invocable by name.
_Avoid_: Command, plugin, slash command (that is `/aiyappa`)
```

- [x] **Step 9: Full verification**

Run: `pnpm run lint && pnpm run fmt:check && pnpm run check:types && pnpm test && pnpm run build`
Expected: everything passes, and the build packages `grill-me`.

- [x] **Step 10: Commit**

```bash
git add src/channels/admit.ts src/channels/admit.test.ts src/channels/signal-attributes.ts src/channels/signal-attributes.test.ts src/channels/slack.ts src/channels/slack.test.ts AGENTS.md CONTEXT.md
git commit -m "Invoke skills with /name in Slack mentions"
```

- [ ] **Step 11: Manual check in Slack (after deploy or with `pnpm run dev` + tunnel)**

1. In a mapped channel: `@aiyappa /grill-me should we cache GitHub tokens in the Worker?`
   - **Expected:** a single question in the ❓ / ➡️ format.
   - **Expected:** the run card shows an `activate_skill` tool step.
2. Answer in the thread without mentioning the bot.
   - **Expected:** the next question takes your answer into account.
3. `@aiyappa /grill-me` with no topic.
   - **Expected:** the agent asks what to grill.
4. `@aiyappa what's in /usr/bin on the sandbox?`
   - **Expected:** an ordinary answer, no skill activation.

Record the results in the PR description.
