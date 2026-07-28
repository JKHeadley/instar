# Convergence report — dated-commitment-reminder (ACT-724)

**Author:** echo · **Rounds:** 2

## Headline

Both rounds returned **SERIOUS ISSUES**, and both changed the design. Round 1
inverted the core write ordering; round 2 caught that the mitigation justifying
that inversion was not actually wired, and that the Testing section still
described the abandoned design.

## Iteration summary

| round | Standards-Conformance Gate | external cross-model | verdict |
|---|---|---|---|
| 1 | ran (0 flags) | codex-cli:gpt-5.5 | **SERIOUS ISSUES** (5) |
| 2 | ran (0 flags) | codex-cli:gpt-5.5 | **SERIOUS ISSUES** (5) |

Single-family external read (codex-cli only); the clean-door Anthropic reviewer
was not run. Disclosed rather than implied. The conformance gate's "0 findings"
covers the subset of the constitution it evaluates, not all ~80 standards
(ATT-conformance-partial-constitution).

Process note: round 1's review **silently died on launch** (dist/ was not built)
and I read the empty output file as "still running" for ~25 minutes. The
relaunch verifies the process is alive before reporting it as such.

## Round 1 — the ordering was backwards

The draft stamped `checkInReminderSentAt` BEFORE sending, reasoning that a
duplicate cannot be recalled while a miss is recoverable.

The reviewer named the consequence: that makes **zero deliveries a designed
outcome**. A failed send left the commitment marked as reminded and permanently
ineligible — a field asserting a delivery that never happened, on a feature
whose entire purpose is that promises are not silently dropped.

| # | finding | disposition |
|---|---|---|
| 1 | stamp-before-send guarantees zero delivery on failure | **Adopted** — inverted to send-then-stamp with bounded retry. |
| 2 | alternatives (outbox, durable queue) not compared | **Adopted** — an alternatives section was added; the outbox is rejected on reasons rather than omitted. |
| 3 | time semantics under-specified (date vs instant, DST, clock jumps) | **Adopted** — `checkInAt` is defined as an absolute instant, normalized at the creation boundary. |
| 4 | cadence, scale, lateness, backpressure omitted | **Adopted** — 5-minute cadence, ~5-minute worst-case lateness, per-pass cap, backlog drain. |
| 5 | "structurally impossible" over-claimed behind a disableable flag | **Adopted** — split into what is true now vs at graduation; the title now says "when the reconciler is live". |

## Round 2 — the fix's own justification was unwired

| # | finding | disposition |
|---|---|---|
| 1 | "exactly one" is really at-least-once; relay dedup is windowed | **Adopted, and worse than stated.** `sendToTopic` does not dedup at all — the dedup lives in the `/telegram/reply` route, which the reconciler bypassed. The mitigation existed only in my comment. The send now routes explicitly through the same `OutboundContentDedup` (durably SQLite-backed), and the guarantee is restated as at-least-once-deduped. |
| 2 | dedup contract undefined — success or retry-loop? | **Adopted** — stated: a duplicate is success-equivalent (stampable); the reservation is released on transport error so real failures retry. |
| 3 | Testing section still says "stamp-before-send" | **Adopted.** Straightforwardly true: the doc lagged the code. Rewritten to assert send-before-stamp and that a failed send leaves no sent stamp. |
| 4 | max-attempt terminal state may re-select forever | **Already implemented, now documented.** `retries-exhausted` was in the predicate; the doc never stated the full predicate. Now written out clause by clause. |
| 5 | title still implies present-tense structural impossibility | **Adopted** — retitled. |

## What self-review caught that neither round did

The Tier-3 test asserted that `AgentServer` self-constructs the
`CommitmentTracker`. It does not — `src/commands/server.ts` injects it — so the
routes 503'd on the real boot path while Tier 2 passed happily against a
hand-assembled context. That is precisely the wiring assumption Tier 3 exists to
break. Fixing it also surfaced that requiring a transport in dry-run mode would
report the feature dead on any agent without messaging configured.

## Decision points

Both `invariant`, argued in the design: the due predicate (arithmetic over
durable state) and the reminder text (fixed template, deliberately not
model-authored).

## Frontloaded decisions

Five: the scan over per-commitment entries; `checkInAt` as its own field rather
than overloading beacon cadence; send-before-stamp; the deterministic delivery
path; and the explicit dedup routing.

## Standing caveat

Two consecutive rounds of SERIOUS ISSUES on a document that read clean
internally, each catching a real correctness defect. The external pass is doing
the work here.
