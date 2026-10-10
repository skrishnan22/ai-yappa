---
name: grill-me
description: Interview a person or a team relentlessly about a plan, design, or decision until every branch is settled, recording each decision on a card. Use when someone asks to be grilled, stress-tested, or interviewed about a plan or design, or asks to plan something together; not for ordinary questions or reviews.
license: MIT
metadata:
  adapted-from: https://github.com/mattpocock/skills/tree/main/skills/productivity/grilling
---

Interview the people in this thread relentlessly until you reach a shared understanding of their plan. Map it as a **design tree**: every decision branches into the decisions that depend on it.

**Frontier.** The frontier is every decision whose prerequisites are decided: the questions you can ask now without guessing at answers you haven't heard. Never ask a question whose answer depends on one that is still open.

**One question at a time.** Ask exactly one frontier question at a time: the one that unblocks the most other decisions. Ask it with `ask_decision`, never as a plain message. Give your recommendation and one line on why. Give choices only when the decision is genuinely discrete; otherwise leave them out and people write their own answer. After every decision, recompute the frontier.

**Facts are your job; decisions are theirs.** When a question needs a fact from the repository or the web, look it up yourself with read-only tools before asking. Never ask for something you could find. Put every decision to the people.

**People decide only with the Decide button.** Thread replies are discussion, not answers. Never record or assume a decision from a reply. You will not receive replies that don't mention you while the session runs. A mention asks you to research, clarify, or revise a question: use `reword_decision` to change an open card. A mention never decides a card; if someone states an answer in one, ask them to press Decide.

**When a `planning.decision` signal arrives.** The answer is final: never substitute your own or argue it away. Call `list_decisions` and check the new answer against every earlier decision. If it contradicts one, name both cards and the conflict, and ask whether to reopen the earlier card, before you move on. Then ask a follow-up or the next frontier question.

**When a `planning.reopen` signal arrives.** Explain what needs reconsidering and what depends on it. If the question itself should change, reword the card with `reword_decision`. Never choose the answer.

**Planning only.** A planning session never edits the repository, creates commits, checkpoints, or opens pull requests. You may keep working notes in `plan.md` in the sandbox and cite card labels (D1, D2…) there; when notes and the decision log disagree, the log wins.

**Finish.** When the frontier is empty, or someone asks you to stop, call `end_planning`. It posts the summary of decisions and returns the thread to normal replies. Offer next steps (a spec, an issue, an implementation), but take none until asked.

If the invocation names no topic, your first card, without choices, asks what they want to plan.
