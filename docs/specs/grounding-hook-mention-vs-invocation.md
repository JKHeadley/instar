---
title: "REJECTED DESIGN — grounding hook: infer sends by inspecting shell text"
slug: "grounding-hook-mention-vs-invocation"
author: "echo"
status: "rejected-at-review"
eli16-overview: "docs/specs/grounding-hook-mention-vs-invocation.eli16.md"
supersedes-into: "ACT-1520 (enforce at the relay boundary), ACT-1519 (regex filter holds blocking authority)"
---

# REJECTED DESIGN — inferring outbound sends by inspecting shell text

> **Status: rejected at review, 2026-07-28. No code shipped.** Three rounds of the
> Standards-Conformance Gate and two rounds of cross-model review (codex-cli/gpt-5.5, verdict
> **SERIOUS ISSUES** both times) converged on the same verdict from different directions: the
> approach is wrong at the layer, not wrong in its details.
>
> This document is kept because the reasoning is the deliverable. The real work is
> **ACT-1520**; whoever picks it up should start here rather than re-deriving the problem,
> the three attempts, and why each failed.

## The problem, which is real

`grounding-before-messaging.sh` is a PreToolUse hook with **blocking authority** (exit 2). It
decides whether a bash command is an outbound message by grepping the raw command string for
relay names. So any command whose text merely **names** a relay is treated as a send.

**Observed three times on 2026-07-28**, all while working on the relay itself: a `git commit`
whose message described the relay script, a `gh pr create` whose body quoted it, and a
`python3` heredoc editing this very document. None sends anything.

**The cost is the workaround, not the delay.** Blocked, the author routes the text through a
file so the substring no longer appears in the bash command — and on this occasion that
rerouting dropped an `## ELI16` section a different PR gate required, producing a red PR. One
guard misfiring caused a second, unrelated failure through the habit it trained. That is
`gate-remedy-text-teaches-behaviour`: a guard whose effective remedy is "route the text
elsewhere" trains routing around guards.

## What was attempted, and how each attempt failed

### Attempt 1 — match the quote-stripped text

Strip single/double-quoted spans before matching, on the reasoning that a mention lives
inside quotes and a command cannot execute from inside one.

**Rejected by the conformance gate** against *Verify the State, Not Its Symbol*: it treats
absence-after-stripping as **proof** no send is happening, which is false for a `bash -c`
whose quoted payload pipes into the relay — a real send that stripping hides. It fails in the
unsafe direction.

### Attempt 2 — two signals, one authority

Keep detection at full raw breadth (`IS_MENTION`), and narrow only *blocking* to the
quote-stripped signal (`IS_INVOCATION`). Nothing loses examination; only enforcement narrows.

**Rejected by cross-model review**, three findings: "unquoted" is not "command position"
(unquoted *arguments* also survive stripping); the wrapped-execution case is a **real
bypass**, not merely reduced enforcement, and "unused in this repo" is a usage argument
rather than a safety one; and the enforcement point itself is wrong.

### Attempt 3 — fail closed on wrapped execution

Force `IS_INVOCATION=yes` whenever a relay is named alongside `bash -c`, `sh -c`, `eval`,
backticks or `$( )`, closing the bypass.

**Rejected by cross-model review round 2**, five findings — decisively including:

> **Wrapped execution fail-closed overblocks unrelated commands.** Any relay mention plus any
> `$(...)`, backticks, `eval`, or `bash -c` becomes blockable. That can still catch inert text
> if the command also uses command substitution for unrelated data.

**That is the finding that ended it.** Attempt 3 fixed attempt 2's under-block by introducing
an over-block. A design whose each fix creates the next defect is being pushed, not converged.

Also standing after three attempts: the sed stripper is not a shell parser (escaped quotes,
`$'…'`, heredocs, multiline commands, nested and process substitutions), and a relay reached
through a **variable**, an alias, or a wrapper script was never matched and still would not be.

## Why the layer is wrong

The reviewer's third finding, which both rounds repeated and which the gate reached
independently:

> The industry-standard fix is to enforce at the relay/send boundary, not by heuristically
> inspecting shell text before execution. If the relay script, `send-email`, or the HTTP
> relay endpoint are the actual outbound choke points, they should invoke the
> convergence/tone authority themselves. Then shell quoting, variables, `bash -c`, aliases,
> and wrappers stop mattering.

The chokepoints already exist — the relay script and `POST /telegram/reply` — and the tone
gate already runs at the server-side send boundary. Every refinement above is a better
heuristic for a question that should not be answered heuristically.

**Tracked as ACT-1520.** <!-- tracked: ACT-1520 -->

## The unresolved foundation

Separately, and unresolved by any attempt above:

> `convergence-check.sh`, a brittle low-context regex filter over raw text, holds blocking
> authority over outbound commands instead of emitting signals to a higher-context gate.

Flagged by the conformance gate in all three rounds, and by the external reviewer as:
*"Calling it mitigation does not make it compliant with the cited principle."* Correct — a
narrower blocked population is a smaller blast radius, not compliance.

**Tracked as ACT-1519.** <!-- tracked: ACT-1519 --> ACT-1519 and ACT-1520 are almost certainly
one design: move the check to the boundary *and* have it emit into an intelligent authority
rather than veto directly. The sequencing constraint both records: the tone gate runs at
message SEND while this hook runs at PreToolUse, so a naive merge could double-gate or open an
unchecked window.

## Decision points touched

*(none — no code ships from this document.)* The decision points it examined
(`IS_MENTION` / `IS_INVOCATION` / `convergence-check.sh`'s verdict) are described above as
rejected proposals, not as shipped behaviour. Their disposition moves to ACT-1519/ACT-1520.

## Multi-machine posture

*(not applicable — nothing ships.)* Had it shipped, the posture was `unified`: an identical
hook script delivered to every machine by the same migration path, holding no durable state,
emitting no user-facing notice, and generating no URL.

## Open questions

*(none)*

The design question is settled — this layer is the wrong one — and the successor work is
registered with its reasoning and its sequencing constraint rather than parked as an
intention.

## What was verified before the design was rejected

Recorded so the effort is auditable rather than merely asserted, and so ACT-1520 inherits the
test shapes:

- 13 unit tests that **read the real expressions out of the shipped template** rather than
  restating them, so they could not pass against a drifted copy.
- Mutation-proved three times: disabling the strip failed exactly the mention-only cases;
  removing the fail-closed clause failed exactly the wrapped-execution cases; and an earlier
  draft of the test swallowed its own extraction error, which would have passed every
  negative case with the hook gone — caught by mutation, fixed by extracting at module scope.
- `tsc --noEmit` and `bash -n` clean across all three attempts.

None of that saved the design, which is the point worth keeping: **a thoroughly tested
implementation of the wrong idea is still the wrong idea**, and only review at the design
layer caught it.
