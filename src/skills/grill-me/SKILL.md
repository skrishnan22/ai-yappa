---
name: grill-me
description: Interview a person or a team relentlessly about a plan, design, or decision until every branch is settled. Use when someone asks to be grilled, stress-tested, or interviewed about a plan or design; not for ordinary questions or reviews.
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
