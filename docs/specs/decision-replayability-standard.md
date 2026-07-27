---
title: "Decision Replayability — an unreplayable decision is an unaccountable one"
slug: "decision-replayability-standard"
author: "echo"
status: "draft"
created: 2026-07-27
parent-principle: "Observability — you can't tune what you can't see"
sibling-principles: "Documentation IS Being; Never-Waste Feedback; Signal vs. Authority; Know Your Principal"
origin: "Operator directive, 2026-07-26 18:32Z: 'we tend to not record data for the sake of privacy. However, this is against the EXO 3.0 fundamentals which requires everything to be fully auditable. This is not a privacy issue. It's a safety and coherence issue and all the data needs to be recoverable so that the situation could be fully replayed and reevaluated.' Plus his 19:34Z follow-up asking me to decide the screenshot question."
eli16-overview: "decision-replayability-standard.eli16.md"
---

# Decision Replayability

> **The rule.** When an autonomous component makes a choice on the operator's behalf, the record
> must be sufficient to REPLAY that choice: what was on offer, what was picked, why, and enough
> surrounding state to re-evaluate it later. Recording only that a decision happened is not an audit
> trail — it is a receipt.

## 1. The failure this closes

Instar components have repeatedly narrowed what they record, citing privacy. The clearest example is
the permission-prompt auto-resolver, documented as recording **"matched-pattern names only, never raw
pane text."** It presses a key on the operator's behalf and records only which regex matched.

That cannot be replayed. It cannot answer *what was I choosing between?*, *what else was offered?*, or
*would that choice still be right?* An operator reviewing it learns that something happened.

**The operator's correction is the governing one:** this is not a privacy question. It is a safety and
coherence question. A decision that cannot be reconstructed cannot be audited, and an unauditable
autonomous decision is an unaccountable one.

## 2. What must be recorded

For every decision an autonomous component makes on the operator's behalf:

| Field | Why |
|---|---|
| `optionsOffered` | The choice set. Without it "chose option 1" is meaningless. |
| `optionChosen` | The action taken. |
| `rationale` | Which rule/pattern/heuristic fired, and its inputs. Not just its NAME. |
| `context` | The surrounding state needed to re-evaluate: the prompt region, session, framework, timestamp. |
| `outcome` | What happened after — did it clear, did it recur. |

"Enough to replay" is the bar. If a reviewer cannot reconstruct the situation well enough to disagree
with the choice, the record is insufficient.

## 3. The medium question — and why "screenshot" was the wrong frame

The operator asked whether storing a screenshot is acceptable. The question contains an assumption
worth challenging: that the choice is between an image and nothing.

**For a terminal prompt it is not.** A tmux pane capture and a screenshot of that pane carry
IDENTICAL information. But:

| | scrubable | greppable | diffable | size |
|---|---|---|---|---|
| pane TEXT | ✅ passes the credential-scrubbing chokepoint | ✅ | ✅ | bytes |
| IMAGE | ❌ cannot be scrubbed without OCR heuristics | ❌ | ❌ | KB–MB |

**So the rule is: capture text wherever text exists.** This is not privacy-squeamishness dressed up —
it is choosing the *more* auditable medium. An image is a worse audit artifact that also happens to be
unscrubbable.

**Images are required, and therefore permitted, where no text equivalent exists** — a GUI dialog, a
browser page, a rendered chart. There, bounded region + bounded retention + sensitive-at-rest
handling apply.

## 4. The bound: prompt region, not unbounded scrollback

Capture the decision's own context — the prompt and its immediate surroundings — **not** the entire
scrollback buffer.

This is a real bound, not a hedge. The audit question is *what was this component choosing between*,
which the prompt region answers completely. Unbounded scrollback adds arbitrary preceding output —
other tasks, other files, whatever was echoed — which is pure secret-exposure surface with **zero**
additional audit value. A bigger capture would be less safe and no more replayable.

## 5. The one hard floor

Captured context passes the existing credential-scrubbing chokepoint before it is written. This is
NOT a licence to record less: it is what makes recording MORE possible. The constitution makes
credential exposure a non-overridable wall, and a standard that wrote unscrubbable secrets to disk by
default would put those two rules in genuine conflict. Text capture removes the conflict entirely.

**Scrubbing must never silently empty the record.** If scrubbing removes so much that the decision is
no longer replayable, the record says so explicitly (`replayability: degraded` + reason) rather than
storing a hollow entry that looks complete. An audit trail that quietly became useless is the exact
absence-reads-as-presence failure this project exists to remove.

## 6. Decision points touched

| point | classification |
|---|---|
| what to record | `invariant` — the field set above is fixed, not per-component judgment |
| text vs image | `invariant` — text where a text form exists; image only where it does not |
| capture bound | `invariant` — prompt region, deterministic |
| scrub-before-write | `invariant` — existing chokepoint, no new judgment |

No judgment points, no LLM, nothing gated.

## 7. Multi-machine posture

**Posture: `machine-local`.** `machine-local-justification: physical-credential-locality` — a
decision record is evidence of what happened on ONE machine's session, and the captured context can
contain that machine's credentials-in-flight. Replicating it would multiply the at-rest exposure of
scrubbed-but-sensitive context across every machine for zero audit gain: the reviewer wants the record
where the decision happened. Cross-machine reads use the existing pool-scope fan-out, which serves
from the owning machine rather than copying.

## 8. Open questions

*(none)* — the screenshot question is resolved in §3 by the operator's delegation (2026-07-26 19:34Z),
recorded in the decision journal with its reasoning.

## 9. Scope and status

This standard is **written but NOT yet applied**. Applying it means changing at least
`PermissionPromptAutoResolver` (today: matched-pattern names only) and auditing other components for
the same narrowing. That work is tracked, not assumed — see the registered action. Writing the
standard and claiming the components comply would be precisely the gap this project keeps finding.
