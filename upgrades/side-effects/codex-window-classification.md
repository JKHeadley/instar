# Side-Effects Review — Classify codex rate-limit windows by declared length

**Version / slug:** `codex-window-classification`
**Date:** `2026-08-19`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required`

## Summary of the change

`QuotaPoller` mapped codex's two rate-limit windows positionally — `primary → fiveHour`,
`secondary → sevenDay` — because codex conventionally reports the 5-hour window first. A live pro
account (2026-08-19) reported `primary` carrying `window_minutes: 10080` (the WEEKLY window) with
`secondary: null`, so a fraction of a seven-day allowance was recorded as a five-hour figure. The
change adds `classifyCodexWindows`, a pure function that routes each window into the short/long
bucket by the `windowMinutes` it declares. Files: `src/core/QuotaPoller.ts`,
`tests/unit/codex-window-classification.test.ts`, `tests/unit/quota-poller.test.ts`.

## Decision-point inventory

- `QuotaPoller` codex window mapping — **modify** — the two windows are now sorted by declared
  length rather than by `primary`/`secondary` key position. This is a data-labelling step feeding
  downstream decisions; it makes no decision itself.

Downstream consumers are **pass-through** (unchanged code, corrected input): the proactive/reactive
account swap, pool placement, and the codex load-shed brake all read `fiveHour`/`sevenDay` as window
LENGTHS.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The function classifies; it never rejects a
window. A window codex sends is always placed somewhere, and a window codex omits stays absent
exactly as before.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

The nearest analogue is a mislabel this change still cannot correct: if codex sends a window with
**no** `window_minutes` (or a non-finite/zero value), the function falls back to that window's
positional meaning. That is deliberate — with no declared length there is nothing better than the
convention, and inventing a class from a sentinel would let a length-less window outrank one that
genuinely stated its length. A codex build that dropped `window_minutes` entirely would therefore
still be classified positionally, i.e. exactly as before this change.

---

## 3. Level-of-abstraction fit

Correct layer. The mislabel originates where the vendor payload is mapped into instar's internal
shape, so the fix belongs at that mapping — not in each of the three consumers, which would have
meant three copies of the same length heuristic drifting apart.

It is a low-level, cheap, deterministic transform with no context requirement, which is exactly what
this layer should hold. No higher-level gate exists that should own it: the swap/placement/brake
gates consume the labelled numbers and have no access to the raw payload. No lower-level primitive
was re-implemented — `CodexUsageSnapshot` already carries `windowMinutes`; it was simply not being
read.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

`classifyCodexWindows` is a pure data-shaping function. It holds no blocking authority: it cannot
stop a session, refuse a spawn, or shed load. It corrects an INPUT consumed by existing authorities
(the swap and the load-shed brake), which keep their own decision logic untouched. This is the
compliant direction — a brittle-but-cheap transform feeding smart consumers, never a brittle
transform holding the block.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The domain is enumerable and this is
an invariant, not a judgment: codex defines exactly two window classes with fixed lengths (300 and
10,080 minutes), and the boundary constant (1440 minutes — one day) sits an order of magnitude away
from both. There are no competing live signals to weigh; there is one declared fact per window.

---

## 5. Interactions

- **Shadowing:** none. `classifyCodexWindows` runs inside the existing codex mapping path, before
  any consumer sees the snapshot. It replaces the positional assignment rather than running
  alongside it, so there is no second mapper it could shadow or be shadowed by.
- **Double-fire:** not applicable — the function is invoked once per poll per account, on the same
  schedule as the mapping it replaces. It emits no events.
- **Races:** none. The function is pure over its two arguments, holds no state, touches no file or
  shared store, and reads no clock.
- **Feedback loops:** none introduced. The corrected labels feed the swap/brake, which change which
  account runs work — but the labels themselves are derived from the vendor payload, not from
  instar's own behaviour, so there is no path back into the input.

One genuine behavioural interaction worth naming: on an account previously affected by the mislabel,
the load-shed brake will now correctly treat a weekly wall as multi-day rather than expecting it to
clear in hours. That is the intended correction, and it means such an account will be avoided for
longer than it was yesterday — the safe direction (previously it was returned to service while still
exhausted).

---

## 6. External surfaces

- **Other agents on the same machine:** no change. The function is internal to quota polling.
- **Other users of the install base:** codex-enrolled agents get corrected numbers on the next poll.
  Claude-only agents are a strict no-op (the function is only reached on the codex path).
- **External systems:** none. No new request is made to codex; the same payload is read more
  carefully.
- **Persistent state:** the polled snapshot is overwritten each poll. No schema change, no new
  field, no migration. A previously-mislabelled stored snapshot self-corrects at the next poll
  rather than needing repair.
- **Timing / runtime conditions:** none — the function reads no clock and takes no I/O.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing actions added or
  touched. The existing `GET /subscription-pool` and dashboard Subscriptions tab render the same
  two fields; they now render correct values.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard renderer, markup file, approval page, or
grant/revoke/secret-drop form is staged.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: machine-local BY DESIGN, already proxied-on-read at the layer above.**

The reason it should differ per machine: a rate-limit reading is derived from codex's rollout files
on the local disk, and a per-machine seat is genuinely distinct data — the same account polled on two
machines is two real observations, not a duplicate. This is why the existing pooled read
(`GET /subscription-pool?scope=pool`) deliberately keeps the same account individually visible per
machine rather than coalescing.

That existing merged read is the pool-wide answer and needs no change: it merges whatever each
machine's poller produced, so correcting the per-machine labelling corrects the pooled view for
free.

- **User-facing notices:** emits none, so no one-voice gating is required.
- **Durable state on topic transfer:** holds none — the snapshot is per-machine, overwritten each
  poll, and a moved topic re-reads the destination machine's own snapshot. Nothing strands.
- **Generated URLs:** none.

---

## 8. Rollback cost

- **Hot-fix release:** revert the code change, ship as the next patch. Pure code change.
- **Data migration:** none. No persistent state, no schema change; the next poll overwrites the
  snapshot either way.
- **Agent state repair:** none. No agent needs notifying or resetting.
- **User visibility:** during a rollback window an affected account returns to the previous
  mislabel — the pre-change behaviour, not a new regression.

---

## Conclusion

The review produced no design changes. The change is a pure, deterministic relabel at the vendor
boundary with no block/allow surface, no persistent state, no external calls, and a strictly
narrowing failure mode: a window that declares its length is now classified correctly, and a window
that declares nothing keeps exactly the behaviour that shipped before. The one behavioural
consequence worth flagging to a reviewer is intended and in the safe direction — a genuinely
exhausted weekly window is now avoided for its real duration rather than being returned to service
early. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required

This change touches none of the Phase-5 triggers: it makes no block/allow decision on inbound,
outbound, or dispatch; it does not touch session lifecycle, compaction, or respawn; it is not a
coherence gate, idempotency check, or trust level; and it is not a sentinel, guard, gate, or
watchdog. It is a data-mapping correction consumed by those systems.

---

## Evidence pointers

- `tests/unit/codex-window-classification.test.ts` — 8 tests: weekly-under-primary, absent
  secondary, conventional ordering, same-class ties, missing/invalid `window_minutes` fallback.
- `tests/unit/quota-poller.test.ts` — 23 tests, extended for the new mapping.
- Local run 2026-08-19: 31 tests, 0 failures.
- Field observation: a live pro account reporting `primary` with `window_minutes: 10080` and
  `secondary: null`, found while enrolling a second codex account into the pool.
