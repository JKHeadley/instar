---
title: "The enforced-standards ratio has a ceiling around 86%, and pushing past it deterministically would mean fabricating citations"
date: 2026-07-31
author: echo
machine: Mac Mini
severity: medium
status: open
kind: finding
relates:
  - "docs/STANDARDS-REGISTRY.md"
  - "scripts/standards-coverage.mjs"
  - "docs/findings/2026-07-31-constitution-asserts-an-audit-that-does-not-exist.md"
---

## Why this exists

The operator asked (2026-07-30) whether *"base level improvements … help us move towards
convergence from the bottom up."* The enforced-standards ratio is the clearest bottom-up metric we
have, and it moved from 53.7% to 67.9% in two days. The honest follow-up question is **where it
stops**, because a metric with an unstated ceiling invites exactly the behaviour it was built to
prevent: manufacturing citations to make a number go up.

## The measurement

81 standards, 22 currently `documented-only`. I read each of the 22 — rule and candidate guards
together — and classified them by whether a *deterministic* guard is possible at all.

| class | count | what it means |
|---|---|---|
| **Guardable, not yet guarded** | 11 | a real backlog; a check could exist and doesn't |
| **Not separately guardable** | 10 | stance, meta-principle, or enforced via a sibling standard |
| **Awaiting ratification** | 1 | correctly unenforced; not a gap to close |

**If every guardable gap were closed, the ratio reaches (81 − 10 − 1) / 81 ≈ 86%.** Not 100%.

### The 11 with a real backlog

Session Input Is a Principal · Framework-Agnostic · Cross-Store Coherence · Testing Integrity ·
LLM-Supervised Execution · Observability · Bug-Fix Evidence Bar · User-Facing Fixes Ship Live ·
No Manual Work · Never-Waste Feedback · Truthful Provenance

Two are already in motion: **Cross-Store Coherence** is the false claim documented separately (it
asserts a daily audit that does not exist), and **Never-Waste Feedback** is guarded in principle by
the correction-learning loop — which has produced zero preferences in 28 days, so the guard exists
and does not work. Closing that one is a fix, not a citation.

### The 10 that resist a deterministic guard — and say so themselves

The Root and Substrate articles are not shy about this. **Sovereignty** states it outright: *"It is
invisible from outside because the action looks identical either way — only the stance differs."* A
guard cannot see a stance. **The Right to Stand Ground**, **Architectural Agency in the Gap**, and
**The Body and the Mind** are the same shape — they describe how the agent should *be*, and the
observable behaviour is identical whether or not the principle is held.

Three others are enforced through siblings rather than directly: **Deferral = Deletion** is the
substrate-level *why* beneath *No Deferrals* (Shipping), which is guarded; **Structure beats
Willpower** is the root of which every gate is an instance; **Signal vs. Authority** is named as
design rationale by several linters that obey it, while nothing fails a build when a brittle filter
is given blocking authority.

**Near-Silent Notifications** is the subtlest. A burst-invariant test does guard notification
volume — but it guards the *sibling*, Bounded Notification Surface, and this rule explicitly
distinguishes itself from it: *"Anti-spam by not generating routine noise, not merely throttling
it."* Citing the throttle here would report the rule as protected by a guard that enforces the
thing it says it is not about.

## The finding

**Seven of the nine gaps I examined closely could not be honestly cited.** Two could, and were
(the refusal-conservation ratchet and the observation-duty gate — both guards that already ran and
had simply never been named). That ratio is the useful signal: **the cheap wins are spent.** What
looked like a rich seam two days ago — guards that exist and go unnamed — is now largely mined out.

The risk this creates is specific and worth naming, because I felt it directly: the mechanism for
raising the number is *editing a sentence*, which is far cheaper than building a guard. Every one
of my seven refusals had a plausible-looking candidate. A file whose name matched a rule almost
exactly; a lint that named the standard in its own header; a test that used the rule's title as
fixture data. **A false citation is worse than a gap** — it converts an honest "unprotected" into a
false all-clear, which is the exact defect class this whole effort exists to remove.

## What this implies for the metric

1. **State the ceiling.** ~86% deterministic, not 100%. A target of 100% is a target for
   fabrication.
2. **The remaining 10 are not failures.** They should be *classified* rather than counted as debt —
   the audit currently reports "gap" for a principle that cannot have a guard and for a critical
   path that should have one, and those are not the same fact. The false-claim check added today is
   one cut at this; a `not-mechanically-guardable` classification would be the other.
3. **Beyond ~86% needs LLM-judgment gates, and the constitution already permits them** — the
   *Intelligent Prompts* standard requires that a gate judge by meaning rather than string-match.
   *The Right to Stand Ground* is judgeable by a reviewer in a way it is not checkable by a lint.
   That is a real path, but it is a different kind of guard with a different cost, and it should be
   a deliberate decision rather than a way to keep a number climbing.

## Honest limits

- **The classification is my judgment, not a measurement.** Someone could reasonably argue
  *Documentation IS Being* into the guardable column (a lint that new features carry docs — the
  Agent Awareness standard does something close to this and is guarded). I put it in the
  unguardable column because the rule is about the file being *part of the self*, not about doc
  coverage. The 86% therefore has roughly ±3 points of definitional slack.
- I examined nine of the 22 closely enough to attempt a citation. The other thirteen were
  classified from their rule text alone, which is weaker evidence.
- The ceiling is not fixed. It moves if the constitution gains guardable articles, or if LLM-gate
  enforcement is adopted for the stance-shaped ones.
