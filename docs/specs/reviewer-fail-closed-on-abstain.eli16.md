# Reviewer Fail-Closed on Abstain — Plain-English Overview

> The one-line version: when one of the LLM checks that screen your agent's outbound messages errors out, it must say "I couldn't check" (abstain) instead of silently saying "looks fine" (pass) — and a critical check abstaining should hold the message rather than let it through.

## The problem in one breath

Your agent runs several LLM "reviewers" over each outbound message before it sends — one checks for leaked credentials/PII to the wrong person, one checks org-constraint violations, others check for fabricated claims or hallucinated URLs. An audit found that when one of those reviewers' LLM call errors, times out, or returns garbage, the shared code behind them quietly returns "pass" — so on any LLM hiccup, the highest-stakes checks are skipped and the message goes out unchecked. That's a silent fail-open, and it violates the "No Silent Degradation" rule the project already holds.

## What already exists

- **The coherence reviewers** — a set of LLM checks, each able to block or warn on an outbound message.
- **The gate above them** — already knows how to fail safe when ALL reviewers can't vote (it blocks on external channels, allows-with-a-note on internal ones), and already blocks when the LLM is capacity-shed.
- **The gap** — an *individual* reviewer that errors is recorded as a genuine "pass," not as "didn't vote," so the safe-when-all-abstain net never catches a single critical reviewer dropping out.

## What this adds

When a reviewer's call fails (error / timeout / unparseable), it now reports an **abstain** ("no opinion — the call failed") instead of a pass. The gate counts that as not-voting. And — the part that needs a real decision — a **critical** reviewer (the credential-leak and org-constraint ones) that abstains on a message going to the outside world **holds the message** (the safe direction), the same way a capacity-shed already does. Less-critical reviewers abstaining just count as a normal non-vote.

## The new pieces

- An `abstained` flag on a reviewer's result, set on every failure path.
- A `criticality` tag per reviewer so the gate knows whose silence should hold an external message vs whose is tolerable.
- Two smaller fail-open spots closed: the message sentinel's ambiguous-message error path, and the send-gateway's outer catch that currently sends if the gate itself throws.
- A CI ratchet so a reviewer can never silently fail-open again.

## The safeguards

**Doesn't over-block in normal operation.** Only a genuine LLM failure on a *critical* reviewer for an *external* message holds — and "held" means queued for retry, not lost. Internal-channel availability is preserved.

**Operator-visible.** Every fail-closed hold is reported, so a sustained LLM outage shows up rather than silently holding your messages.

## What ships when

One PR after spec-convergence resolves the open question (which reviewers are "critical," and whether a critical abstain should also block on internal channels). The mechanical abstain-tagging is uncontested; the criticality policy is the part being converged.
