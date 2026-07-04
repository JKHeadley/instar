# Side-Effects Review — Feature-Maturation Follow-Through Fix, Standard C (C1 + C2)

**Version / slug:** `maturation-followthrough-fix-standard-c`
**Date:** `2026-07-03`
**Author:** `echo (build helper)`
**Second-pass reviewer:** `not required (signal-only content + dark dev-gated delivery-robustness; no new blocking authority)`

## Summary of the change

First increment of `docs/specs/maturation-followthrough-fix.md` (Standard C — delivery
can never be silently dropped). It fixes the operator's actual observed pain: on
2026-06-29 the weekly growth digest hit `send-blocked` (reason `tone-gate-blocked`),
consumed its window, and never retried — a "dark features can never be silently
forgotten" guarantee that silently forgot itself. Two coordinated fixes:

- **C2 (pure content fix, no flag):** the digest formatter no longer emits operator-facing
  raw route paths / config keys — the exact patterns the always-on tone gate blocks.
  `GrowthDigestPublisher.ts` FOOTER (`GET /growth/digest` → "Full digest in your dashboard"),
  the two truncation notes, and `GrowthMilestoneAnalyst.ts` R6 detail (`… DARK at
  ${feature.configPath}` → plain English). Shipped with a deterministic preflight guard
  `scanFormattedDigestForLeaks()` + a fixture test that asserts formatted digest content is
  leak-free, so a future formatter regression is caught at build time, not by a live block.
- **C1 (behind `monitoring.growthAnalyst.blockedDigestEscalation`, dev-gated dark):** a
  RETRYABLE blocked send (tone/provider/send-error) no longer consumes its window. It
  records `send-deferred` (NO `window` field, so `recordedWindows()` ignores it and
  `catchUp()` retries), persists a bounded delivery-attempt record (max 5 attempts / 14 days
  / 60s exponential backoff), and raises ONE deduped attention item — routed to the
  attention surface, not the silent Updates topic (C3's delivery-failure notice). A poison
  window that exhausts a ceiling records `send-exhausted` (consumes the window, stops
  retrying) + ONE HIGH attention item. A TERMINAL non-send, C1-off, or a store fault all
  fall back to today's `send-blocked`-and-consume behavior — never a silent drop.

Files: `src/monitoring/GrowthDigestPublisher.ts` (C1 + C2 + store + scanner), `src/monitoring/GrowthMilestoneAnalyst.ts` (C2 R6 detail), `src/server/AgentServer.ts` (store + dev-gate wiring), `src/server/routes.ts` (attention raiser wiring), `src/core/types.ts` (config flag), `src/monitoring/guardManifest.ts` (flag registered for /guards + tripwire), `src/data/state-coherence-registry.json` (new state file registered), tests.

## Decision-point inventory

- `GrowthDigestPublisher.publishOnce` live-send failure branch — **modify** — a retryable block now defers instead of consuming the window (gated on the C1 flag).
- `isRetryableSendReason(reason)` — **add** — pure classifier (retryable vs terminal); unknown → terminal (safe direction).
- `GrowthDigestPublisher.catchUp` — **modify** — also drains due deferrals (bounded, backoff-respecting).
- Formatter FOOTER / truncation notes / R6 detail — **modify** — content only (C2).

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** This change adds NO gate over user
or agent messages. It only decides whether a FAILED digest send is retried vs consumed, and
whether the digest content contains a leak pattern (a build-time test assertion, never a
runtime block). The tone gate itself is unchanged.

---

## 2. Under-block

The C2 leak scanner (`scanFormattedDigestForLeaks`) is a deterministic pattern guard, not the
LLM tone gate — it catches the known route-path / config-key / file-path leak classes, but a
novel leak shape the LLM would catch could still pass the scanner. This is acceptable: the
scanner is a build-time regression guard (a strictly-additive belt), and the real tone gate
still runs at send time. C1 is the belt for when the tone gate DOES block — so an escaped
leak that the live gate catches now defers + escalates instead of silently dropping. The two
fixes are complementary, not a single point.

---

## 3. Level-of-abstraction fit

Correct layer. C1 lives in the publisher (the component that owns the send + its audit
window), reusing the existing `recordedWindows()` idempotency ledger and the existing
`createAttentionItem` funnel rather than inventing parallel machinery. The deferral store is
file-based JSON on the same `state/` convention as sibling stores (registered in the
state-coherence registry). It FEEDS the existing attention surface, it does not run parallel
to it. C2 is a content fix at the formatter — the lowest layer that owns the text.

---

## 4. Signal vs authority compliance

Compliant. C1 produces SIGNALS (an audit record + a deduped attention item) and self-limits
via a bounded retry contract; it never grants itself authority to bypass the tone gate,
change a flag, or force a send. The tone gate remains the authority over what may be sent;
C1 only changes what happens to the WINDOW on a failure (retry vs consume). The C2 scanner is
a test-time assertion with zero runtime authority. Ref: `docs/signal-vs-authority.md`.

---

## 5. Interactions

- Shares the `recordedWindows()` ledger with the cron/catch-up idempotency path: a
  `send-deferred` entry deliberately carries NO window so it is not swallowed; a `sent` /
  `send-exhausted` entry carries its window so it is. `catchUp` drains due deferrals AND
  skips a missed window that is still an un-elapsed deferral, so the two paths cannot
  double-publish the same window in one cycle. A successful send clears the deferral (so a
  delivered window never retries).
- The deferral store is the single shared idempotency record the spec's watcher (Standard D,
  a later increment) will read — so watcher-drain and cron-retry can never both fire the same
  window. That contract is honored here even though D is not yet built.
- Does not race adjacent cleanup: the store is single-writer (only the awake machine emits).

---

## 6. External surfaces

- Adds one attention item on a deferred/exhausted digest send (operator-visible). It carries
  a GENERIC plain-English reason only — never the raw rejected body or the tone gate's cited
  offending pattern (which contains the very route/config leak C2 strips), so the escalation
  can't re-introduce the leak or itself trip the tone gate. Deduped per `<machineId>:growth-digest-defer:<windowId>`.
- The C2 footer/detail text change is visible in the weekly digest content (an improvement:
  plainer, no jargon).
- Timing: retry cadence depends on boot/catch-up (C1's active drainer is the watcher, D — a
  later increment); within this increment a deferred window retries on the next `catchUp`.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, with reason.** The weekly digest is emitted only by the machine
holding the serving lease (`isAwake` gate, pre-existing), so the digest's retry ledger
(`state/growth-digest-deferrals.json`) is a fact about THAT machine — never merged from a
peer. This mirrors the existing `growth-digest.jsonl` audit (also machine-local) and the
`guard-accepted-fallbacks.json` per-machine posture. Registered as `scope: machine-local` in
`state-coherence-registry.json`. One-voice on send is inherited: because publishOnce is
lease-gated, only the awake machine defers/escalates, so a two-machine agent never
double-notifies. The attention dedupe-key encodes `machineId` so two machines never collapse
distinct findings.

---

## 8. Rollback cost

Cheap. C1 is behind `monitoring.growthAnalyst.blockedDigestEscalation` (dev-gated: fleet
stays dark; a dev agent runs it live). Setting `enabled: false` restores today's
consume-and-drop exactly — and because it is a `monitoring.*` flag, that OFF flip is caught
by the Guard-Posture Tripwire (loud boot log + one HIGH attention item) and shows as
`diverged-from-default` in `/guards`, so turning off the guarantee is a surfaced, acknowledged
act ("louder legacy"), never a silent re-introduction of the drop. C2 is a pure content
change with no runtime state; a revert is a one-line string change. No data migration — the
deferral store is created lazily and is empty until a real deferral occurs. No fleet posture
is flipped on by this change.
