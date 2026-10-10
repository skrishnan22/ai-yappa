# Channel-member access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the invoker allowlist so any human member of the deployment's own workspace can use Yappa in a bound channel, while external Slack Connect users stay refused.

**Architecture:** Admission (`decideAdmit`) stops taking `allowed` and takes `external` instead. Slack ingress computes `external` from the event's sender team (`user_team`, falling back to `team`), the envelope's `team_id` (the installing workspace) and `is_ext_shared_channel`. Slash commands drop the allowlist gate on `status` and `models`. Connect and disconnect keep `codexAdminIds`.

**Tech Stack:** TypeScript, `@flue/slack`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-10-channel-member-access-design.md`

## Global Constraints

- Binding a channel in `channelRepos` is the opt-in. Every human member of the workspace gets the Coworker's full capability.
- External users are refused with a polite in-thread reply. Bots stay ignored. Codex connect/disconnect still require `codexAdminIds`.
- No new OAuth scope.
- Follow `AGENTS.md`. Check optional values by truthiness.

## Findings that shape the plan

- **Event envelope `team_id`.** Slack's Slack Connect docs say the outer `team_id` mirrors the first authorized user, so it is the installing workspace. The sender's workspace is the inner event's `user_team`. Message events also carry `team`, and `@slack/types` only declares `team` on `GenericMessageEvent`.
- **Slash commands (the spec's open item).** Slack's Slack Connect docs say: "Slash commands and message actions are _not_ shared — they are limited only to the team that has installed the app." No payload field is needed, because an external user cannot reach `/aiyappa`. The payload's `team_id` is always the invoking user's team, and that is the installing team.

## Review Focus

1. **Shared channel, sender team missing.** If an event in an `is_ext_shared_channel` channel has neither `user_team` nor `team`, ingress refuses it rather than assuming the sender is internal.
2. **Ordinary channel, sender team missing.** In a channel that is not externally shared, an event with no team field is admitted. Every sender there is internal.
3. **External user replies, unmentioned, in a thread that already has a Coworker.** Refused, with no dispatch. Today a thread reply skips the allowlist only when no conversation exists.
4. **External user's unmentioned reply in an untracked thread.** Dropped silently, with no refusal post, so Yappa doesn't spam threads it isn't in.
5. **Slack timeout retry of an external mention.** No second refusal post. This uses the existing `timeoutRetry` path.

---

### Task 1: Admission decides on external users, not an allowlist

**Files:**
- Modify: `src/channels/admit.ts`
- Modify: `src/observability.ts` (`refuse-invoker` → `refuse-external`)
- Test: `src/channels/admit.test.ts`

**Interfaces:**
- Produces:
  - `decideAdmit(args: { signalType: SlackSignal; external: boolean; repo: string | undefined; conversationExists: boolean }): AdmitDecision`
  - `AdmitDecision` kind `'refuse-external'` replaces `'refuse-invoker'`
  - `isExternalSender(args: { senderTeam: string | undefined; workspaceTeam: string; sharedExternally: boolean }): boolean`

- [ ] **Step 1: Rewrite the `decideAdmit` tests.** Replace `allowed` with `external`. Rename "refuses a user who is not allowlisted" to "refuses an external user" with `external: true` → `{ kind: 'refuse-external' }`. "An untracked reply from an external user is silently dropped" → `drop-untracked`. Add "an external reply to an existing conversation is refused" (`slack.message`, `external: true`, `conversationExists: true`) → `refuse-external`. Every other case uses `external: false`.
- [ ] **Step 2: Add `isExternalSender` tests:**

```ts
describe('isExternalSender', () => {
	test('a sender from another team is external', () => {
		expect(isExternalSender({ senderTeam: 'T_OTHER', workspaceTeam: 'T_HOME', sharedExternally: true })).toBe(true);
		expect(isExternalSender({ senderTeam: 'T_OTHER', workspaceTeam: 'T_HOME', sharedExternally: false })).toBe(true);
	});

	test('a sender from the workspace is not external', () => {
		expect(isExternalSender({ senderTeam: 'T_HOME', workspaceTeam: 'T_HOME', sharedExternally: true })).toBe(false);
	});

	test('a missing sender team fails closed only in an externally shared channel', () => {
		expect(isExternalSender({ senderTeam: undefined, workspaceTeam: 'T_HOME', sharedExternally: true })).toBe(true);
		expect(isExternalSender({ senderTeam: undefined, workspaceTeam: 'T_HOME', sharedExternally: false })).toBe(false);
	});
});
```

- [ ] **Step 3: Run** `pnpm vitest run src/channels/admit.test.ts`. Expect FAIL.
- [ ] **Step 4: Implement:**

```ts
export function isExternalSender(args: {
	senderTeam: string | undefined;
	workspaceTeam: string;
	sharedExternally: boolean;
}): boolean {
	if (!args.senderTeam) return args.sharedExternally;

	return args.senderTeam !== args.workspaceTeam;
}
```

In `decideAdmit`, replace `if (!args.allowed) return { kind: 'refuse-invoker' };` with `if (args.external) return { kind: 'refuse-external' };`. Keep it after the `drop-untracked` check. Update the `SlackAdmissionEvent.decision` union.

- [ ] **Step 5: Run the test again.** Expect PASS. Types still fail in `slack.ts` until Task 2, so commit Tasks 1 and 2 together.

### Task 2: Slack ingress passes sender identity; config loses the allowlist

**Files:**
- Modify: `src/config.ts` (delete `allowedInvokerIds` and `isAllowedInvoker`, and reword the `codexAdminIds` comment)
- Modify: `src/channels/slack.ts`
- Test: `src/channels/slack.test.ts`

**Interfaces:**
- Consumes: `decideAdmit` and `isExternalSender` from Task 1.
- `admitThread` gains `external: boolean`. Each `case` in `events` computes it with `isExternalSender({ senderTeam: event.user_team ?? event.team, workspaceTeam: payload.team_id, sharedExternally: payload.is_ext_shared_channel === true })`. For `message`, read the fields through a narrow `senderTeamOf(event: { team?: string; user_team?: string })` helper, because `GenericMessageEvent` does not declare `user_team`.

- [ ] **Step 1: Tests in `slack.test.ts`.** Drop `allowedInvokerIds` and the `afterEach` add/delete. Change `FOLLOW_UP_USER` to a user who was never on the old list. The existing follow-up test then proves that a non-allowlisted member can start and continue. Extend `eventPayload` with optional `userTeam` and `sharedExternally`. Add:
  - an external mention in a shared channel (`userTeam: 'T_OTHER'`, `sharedExternally: true`) posts one `chat.postMessage` whose text contains `members of this workspace`, with no dispatch;
  - an external unmentioned reply in a thread with a Coworker is refused, with no dispatch;
  - a shared-channel mention with no team field is refused;
  - a mention from `userTeam: 'TTEAM'` in a shared channel dispatches.
- [ ] **Step 2: Run** `pnpm vitest run src/channels/slack.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Refusal copy: `'Yappa only works for members of this workspace.'`. Replace `isAllowedInvoker` in `admitThread`. Rename the `refuse` kind union.
- [ ] **Step 4: Run** `pnpm vitest run src/channels`. Expect PASS.

### Task 3: Slash commands open `status` and `models` to workspace members

**Files:**
- Modify: `src/channels/slash-command.ts`
- Test: `src/channels/slash-command.test.ts`

- [ ] **Step 1: Tests.** "refuses connect, disconnect…" keeps the connect and disconnect assertions. `status` for `STRANGER` now returns status text and calls `codexAuth`. Replace "refuses users on neither list" with "lists models for any workspace member" (`STRANGER` gets the `sol` line).
- [ ] **Step 2: Run** and expect FAIL. **Step 3:** delete both `isAllowedInvoker` gates and reword the doc comment: status and models are open to the workspace, because Slack only lets the installing team invoke slash commands. **Step 4:** run and expect PASS.
- [ ] **Step 5: Commit** Tasks 1–3: `git commit -m "Open Yappa to channel members; refuse external users"`.

### Task 4: Docs and ADR

**Files:**
- Create: `docs/adr/0022-channel-members-may-use-yappa.md`
- Modify: `docs/adr/README.md`, `SLACK_AGENT_SPEC.md` §4.1 and §5 ingress line, `CONTEXT.md` (Configured Channel), `AGENTS.md` (config and slash-command lines), `README.md` (status line and admins paragraph)

- [ ] **Step 1:** Write the ADR. Cover the context (an allowlist per person doesn't scale, and channel membership is already the social boundary), the decision (binding is the opt-in, external users are refused by `user_team` vs envelope `team_id` and fail closed in shared channels, Codex admins stay), the consequences (full capability for every member, PR review is the gate on code, spend on the shared subscription), and the alternatives (keeping the allowlist, a Slack user-group check that needs `usergroups:read`).
- [ ] **Step 2:** Update the doc lines listed above.
- [ ] **Step 3: Verify:** `pnpm run check:types && pnpm test && pnpm run lint && pnpm run fmt:check`.
- [ ] **Step 4: Commit** `"Record ADR 0022: channel members may use Yappa"`.
