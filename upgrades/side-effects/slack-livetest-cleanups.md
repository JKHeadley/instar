# Side-Effects Review — Slack live-test cleanups (#2 ambient-silence observability, #5 spec/type alignment)

**Version / slug:** `slack-livetest-cleanups`
**Date:** `2026-06-09`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required` (Tier-1; observability-only + doc-accuracy; no decision authority touched)

## Summary of the change

Two small cleanups the Slack-org live-test plan flagged.

**Cleanup #2 (observability):** the `AmbientContributionGate` previously only left a trace when it SPOKE (the speak-path `console.log` + the `onDecision` log fires on `speak:true`). A wrongful SILENCE left no measurable record, so the ambient false-positive (wrongful-silence) / false-negative rate could not be measured during the observe-only live test. This adds a bounded, in-memory aggregate inside the gate — per-channel `{evaluated, spoke, silent, nearMissSilent, silentByReason}` plus a bounded ring of the most-recent near-miss silences — read via a new `getStats()` method, a `SlackAdapter.getAmbientStats()` passthrough, and a read-only `GET /permissions/ambient-stats` route (reads the live `ctx.slack` instance). Files: `src/permissions/AmbientContributionGate.ts`, `src/messaging/slack/SlackAdapter.ts`, `src/server/routes.ts`, plus unit + integration tests.

**Cleanup #5 (doc accuracy):** `SLACK-ORG-INTEGRATION-SPEC.md` named a `respondMode: 'considered'` third mode, but the shipped `SlackRespondMode` type is `'all' | 'mention-only'`; ambient rides on `ambientContribution.enabledChannelIds` ON TOP of `mention-only`. The spec (§5.2 and the §15 migration-parity bullet) is rewritten to match the shipped reality — the lower-risk fix. No type value added; no code path needed it.

## Decision-point inventory

- `AmbientContributionGate.shouldSpeak` (the speak/silence decision) — **pass-through** — the verdict is computed exactly as before; the aggregate is updated AFTER the verdict is formed, inside `decide()`, wrapped in try/catch, and `decide()` returns the decision unchanged. The recording cannot alter the outcome.
- `GET /permissions/ambient-stats` — **add** — read-only observability surface; performs no mutation and no messaging.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. The aggregate is signal-only and the new route is read-only. The speak/silence decision is unchanged (a dedicated regression test asserts identical verdicts with the aggregate present).

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable. The aggregate is an in-memory FP-measurement counter, not a gate. It is reset on restart, which is acceptable for an FP-rate-measurement surface (the durable per-decision record is the file-backed `/permissions/decisions`). Worst case is a momentary loss of accumulated counts after a restart — never an over- or under-speak.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The aggregate lives ON the gate that produces the decisions it counts, so every decision (including the previously-invisible silences) is observed at the single chokepoint `decide()` — no parallel detector, no double-counting. The route reads the live `ctx.slack` adapter (already in `RouteContext`), mirroring how the existing observe-only `/permissions/*` surfaces expose internal state. A durable counter could replace the in-memory map later without changing the contract.

---

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic, or produce a signal?**

Pure signal. Per `docs/signal-vs-authority.md`: the aggregate is a detector/observability surface with ZERO authority — it never blocks, delays, or rewrites a message, and it cannot change the speak/silence verdict (recording runs after the verdict and returns it unchanged; a stats bug is swallowed by try/catch). The ambient gate's own fail-to-silence authority is untouched.

---

## 5. Interactions

**Does it shadow another check, get shadowed, double-fire, or race?**

No. The new counters are independent of the existing `onDecision` hook and the speak-path `console.log` (both retained). No timer, no shared mutable state with another component. The `recordSpoke()` rate-limit budget is a separate concern and is not affected. The new route shares the `/permissions/*` prefix, already allowlisted as dark/internal in `CapabilityIndex` (line ~1023), so it does not trip the route-discoverability scan.

---

## 6. External surfaces

**Does it change anything visible to other agents / users / systems?**

Only the new authenticated read-only route `GET /permissions/ambient-stats` (returns `{ present: false }` when no ambient gate is attached — the default). It creates NO Telegram message and NO forum topic, so it cannot contribute to a notification flood (verified: the notification-flood burst-invariant test still passes). It is dark unless a channel is opted into ambient contribution. No timing/conversation-state dependency.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Trivial. The aggregate is in-memory (no persistence, no migration, no agent-state repair) and the route is additive. Reverting the commit removes both with no residue. Cleanup #5 is a doc edit with zero runtime effect.
