---
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
review-convergence: "rev-1 — operator-approved incident response (2026-06-05 topic 13481 transfer noise). Both fixes grounded in production logs + source: (1) the transfer planner's rate-limit check ran BEFORE its already-on-target check, so duplicates of an already-satisfied move read as failures; (2) the exactly-once ingress gate ships default-OFF even on a pool actively routing real traffic, so lifeline retries / post-restart replays re-execute user commands. Minimal coherent fixes at the pure-planner and config-resolution layers; both sides of every boundary test-pinned."
approved: true
approved-by: "operator (Justin) via Telegram topic 13481 — 2026-06-05 ~04:48Z (\"Yes please fix it\", responding to the named fix list: idempotent move + replayed messages must not re-execute commands) under the standing multi-machine pre-approval"
approved-at: "2026-06-05T04:48:27Z"
---

# Transfer Idempotency + Exactly-Once-When-Live

**Status:** Approved 2026-06-05. Implemented.
**Author:** Echo
**Companion:** transfer-idempotency-exactly-once.eli16.md
**Trigger:** 2026-06-05 incident (topic 13481): ONE "move this to the laptop"
message produced "Moving this conversation to Laptop" → "I can't move this
right now (rate-limited)" → "Moving…" → "rate-limited" again. The move had
succeeded on the first attempt; everything after was duplicate processing
narrated as failure.

---

## Failure 1 — duplicate move reads as "rate-limited"

`planTransferByNickname` checked the rate limit BEFORE the already-on-target
no-op. A duplicate of an already-satisfied move (lifeline retry under load,
post-restart queue replay) within the 10s window returned
`reject/rate-limited` — the user is told a move that already succeeded
"can't" happen. Worse, in the window where the pin landed but ownership
hadn't re-placed yet (`pin === target`, `owner !== target`), even an
out-of-window duplicate planned a SECOND full transfer.

**Fix:** idempotency before the rate limit, at the pure-planner layer:
- `owner === target` → `noop/already-on-target` (was present, but ran after
  the rate limit; now runs before it).
- NEW `currentPinOf` state hook: `pin === target` →
  `noop/already-pinned-to-target` — a duplicate during the
  pin-landed-but-not-re-placed window is recognized as satisfied.
- The rate limit now only gates ACTUAL placement changes (different target),
  which is its real job (anti rapid-fire flip-flop).
- Consumer (`server.ts`): wires `currentPinOf` from `TopicPlacementPinStore`
  and renders `already-on-target` as "This conversation is already running on
  X — nothing to move."

`currentPinOf` is optional — existing callers keep the old semantics
(backward compatible).

## Failure 2 — exactly-once ingress dark on a live pool

The exactly-once ingress gate (`decideIngress` + `MessageProcessingLedger`,
spec §8 G3a) is fully built and tested but `exactlyOnceIngress` defaults to
`false`. On the dev agent the session pool runs at `stage: 'live-transfer'`
while the ingress ledger was never wired — so the documented guarantee
("each inbound message is handled exactly once") was structurally absent
exactly where it matters most. Production log evidence: zero `exactly-once`
lines while one message executed 4×.

**Fix:** the default now follows the pool stage:
`exactlyOnceIngress: mm?.exactlyOnceIngress ?? (stage === 'live-transfer' || stage === 'rebalance')`.
A live pool gets the dedupe ledger by default; `dark`/`shadow` stay dark; an
explicit `false` still wins (operator opt-out preserved). No migration needed
— resolution-time defaulting, config absence keeps meaning "follow the
default."

## Tests

- `tests/unit/TransferByNickname.test.ts` (+5): the incident case (already-on
  within the window → noop, not rate-limited); pin-landed window → noop;
  different-target within window still rate-limited; `currentPinOf` absent →
  pre-existing behavior; offline target with satisfied pin → noop.
- `tests/unit/seamlessnessConfig.test.ts` (+4): no config → off; dark/shadow
  → off; live-transfer/rebalance → on; explicit value beats stage both ways.

## Out of scope

- The restart-cadence noise ("Server is restarting…" per release) — separate
  UX track.
- Dashboard cross-machine session visibility — separate PR (operator request,
  same session).
