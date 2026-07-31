---
title: "Three independent queues record intent extensively and verify outcome almost never — none can tell finished from abandoned"
date: 2026-07-31
author: echo
machine: Mac Mini
severity: high
status: open
kind: finding
relates:
  - "docs/STANDARDS-REGISTRY.md"
  - "docs/findings/2026-07-31-accumulating-memory-never-synthesises.md"
  - "docs/findings/2026-07-31-standards-coverage-has-a-ceiling.md"
---

## Why this exists

The operator asked (2026-07-30 16:00) whether *"there are enough small improvements in all the
various infrastructure that they will start collectively helping us converge towards coherence."*

Answering that honestly means reading the queues that are supposed to tell us. I audited three.
They were built at different times, by different hands, for different jobs — and they have all
converged on the same defect.

## The measurement

| queue | total | open | terminal-done | can it distinguish done from abandoned? |
|---|---|---|---|---|
| attention (`/attention`) | 666 | 155 open | 434 `DONE` | **no** — nothing resolves an item when its condition clears |
| commitments (`/commitments`) | 1,151 | 327 `pending` | 648 `delivered` | **no** — `verificationCount: 0` and `lastVerifiedAt: null` on every pending item |
| evolution actions (`/evolution/actions`) | 1,645 | **1,000 `pending`** | **52 `completed` (3.2%)** | **not even in principle** — the record has no verification field at all |

The action queue additionally has no usable priority signal: **724 `high` + 73 `critical` +
2 `urgent` = 799 of 1,645** marked high-or-above. When half a queue is high priority, none of it is.

## The proof that the status field is uninterpretable

Two commitments, adjacent in age, identical status (`pending`), opposite realities:

- **CMT-698** (opened 2026-06-16, pending 45 days) promised *"a CI ratchet running `node --check` on
  every shipped hook template."* **That ratchet exists.** `tests/unit/generated-hooks-parse.test.ts`
  generates each `PostUpdateMigrator.get*Hook()` result and runs `node --check` on it, and its header
  names the identical root cause the commitment named — the stray `})();` in
  `getActionClaimFollowthroughHook` that produced *"SyntaxError: Unexpected token '}' on EVERY
  Stop-hook fire, fleet-wide."* The work shipped; the ledger never learned.
- **CMT-694** (opened 2026-06-05, pending 56 days) promised bounded backoff on live-tail flushes.
  **Genuinely undone** — 442 live-tail flush failures in the current `server.log`.

Same status. One finished a month and a half ago; one never started. **Nothing in the record
separates them**, which makes the aggregate "327 pending" a number nobody can act on in either
direction.

Marking CMT-698 delivered (with evidence attached) surfaced one more thing: **`verificationCount`
remained `0` after delivery.** The field is inert across the entire lifecycle, not merely unwritten
while pending. Whatever was meant to distinguish *claimed-done* from *checked-done* was never wired
to anything.

## The finding

**These are not three bugs. They are one architectural habit: a rich write path with no read-back.**

Each queue faithfully records that something was raised. None of them ever asks, later, whether the
thing was resolved. The consequence is identical in all three: the open count grows monotonically,
terminal states are reached only by explicit human or agent action, and the aggregate becomes
uninterpretable — at which point the queue stops functioning as a signal and becomes a landfill that
still costs attention to scan.

The attention queue demonstrates the endpoint. 77 of its 90 HIGH items described a cross-machine
quota disagreement that had **already resolved** — verified live, all six accounts agreeing on both
machines. The detector fired correctly, filed correctly, and nothing ever revisited the finding.
Worse, its dedupe key embeds the calendar day (`agent:quota-truth-<account>-<window>-2026-07-15`),
so a condition lasting longer than a day files **one permanent item per account per window per day**,
forever. That is the same class as the progress-beacon volume bug fixed in #1785: **a bound applied
to the wrong unit.**

## Blind-spot class

> **A system that measures its own filing rate and not its closure rate will report increasing
> activity as increasing progress.**

Every one of these queues is growing, and every one reads that growth as work being tracked. The
2026-07-28 measurement recorded *"1,018 filed in 4 weeks, 43 closed."* Today the action queue reads
1,645 filed / 52 completed. The trend is visible in the instrument and invisible to it.

The system already flags this about itself and cannot act on the flag: *"Action backlog requires
immediate triage (635 items)"* sits in the attention queue as an open HIGH item — the backlog
reporting its own backlog into a second backlog.

## Proposed standard

> **A queue that cannot distinguish done from abandoned must report its open count as UNVERIFIED,
> not as pending.**

"1,000 pending actions" is a claim about work outstanding. "1,000 unverified, completion rate
unknown" is the truth, and it is the phrasing that prompts building the read-back rather than
scheduling another triage sweep. This is *No ratio without a denominator* — merged as project
Tier-1 item `convergence-towards-coherence-1` — never applied to these instruments.

## What was done and deliberately not done

- **Resolved** the 77 stale quota-contradiction attention items after verifying the condition had
  cleared. Non-destructive (`OPEN → DONE`, full record retained). OPEN 232 → 155; HIGH 90 → 48.
- **Delivered** CMT-698 with evidence attached.
- **Not swept** the remaining 327 commitments or 1,000 actions by hand. Verifying each is real
  per-item work, and hand-sweeping is precisely the willpower fix this codebase rejects. **The
  verification pass is the artifact to build**; the cleanup is a one-off that rebuilds itself.
- **Not fixed** the day-embedded dedupe key, which is the mechanism guaranteeing the attention pile
  rebuilds.

## Honest limits

- 587 of the action queue's 1,645 items are `cancelled`, so *some* cleanup path runs (the auto-expiry
  sweep). This is not pure accumulation — it is accumulation faster than any closure path.
- I verified two of 327 pending commitments by hand. The split between done-but-unmarked and
  genuinely-abandoned across the remaining 325 is **unknown**, and this finding deliberately does not
  estimate it — estimating it would repeat the error it documents.
- The attention and commitment counts are per-machine reads taken on the Mac Mini at
  2026-07-31 06:15–06:18Z.
