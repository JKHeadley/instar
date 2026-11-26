# Side-Effects Review — Jev correction shadow (log-only check on missed corrections)

**Version / slug:** `jev-correction-shadow`
**Date:** `2026-10-05`
**Author:** `echo`
**Second-pass reviewer:** `independent review subagent (one 80/20 round)`

## Summary of the change

A dark, log-only research instrument (spec `docs/specs/jev-correction-shadow.md`).
Chained onto `TelegramAdapter.onMessageLogged`: an agent message (not
automation) is remembered per topic as context; each user message starts one
detached check that secret-scrubs the message and the context (before any cut,
and again after rendering), asks Jev (`jev-1.13.0`) one four-option question
(correction / preference / neither / cannot_tell) in both option orders, and
appends a content-free row (probabilities, the correction sentinel's Layer-0
verdict on the same text, agreement, message id) to
`logs/jev-correction-shadow.jsonl`. `GET /jev-correction/summary` reads the log.
Files: `src/core/JevCorrectionShadow.ts` (new), `src/commands/server.ts`
(construction + one chained callback), `src/server/routes.ts` (read route),
`src/core/types.ts`, `src/core/devGatedFeatures.ts`, `src/scaffold/templates.ts`
(awareness card), `src/core/PostUpdateMigrator.ts` (card migration + shadow
marker), `src/server/CapabilityIndex.ts` (internal prefix).

## Decision-point inventory

No decision-point surface. Nothing is blocked, allowed, filtered, delivered or
routed, and the correction sentinel's capture/distill path is not touched. No
code path reads the log except the summary route, which a person reads.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Measurement blind spots,
named in the spec: one message of context; Slack not covered (the sentinel
itself listens to Telegram only); messages relayed through the operator's
account are classified as his.

---

## 3. Level-of-abstraction fit

Right layer. It reads the same seam the correction capture loop reads, computes
the sentinel's own Layer-0 verdict with the same classifier, and records both
side by side, so the comparison is exact. It reuses `scrubForStore`,
`resolveDevAgentGate`, the feature-metrics recorder and the TypeSafe endpoint
patterns of the existing Jev shadows. It deliberately does not feed the
sentinel: whether Jev should become a second trigger is a later decision on
soak evidence.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

It produces a logged signal that nothing consumes. It holds no authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The 0.5
threshold only labels rows in a research log; no action follows from it.

---

## 5. Interactions

- **Seam:** chained after every prior `onMessageLogged` consumer in its own
  block before the PresenceProxy block; later consumers chain on top of it, so
  it is preserved. `observe()` is synchronous, wrapped in try/catch, does no
  I/O, and defers the whole check (vault read, cap seed, scrub, Layer 0) to a
  later turn with `setImmediate`; it cannot delay or break
  delivery, logging, PresenceProxy, the capture loop or the topic-intent clerk.
- **Double-fire:** none. The correction capture loop runs Layer 0 itself; the
  shadow calls the same pure `classify` (no recording side effect). Other Jev
  shadows have separate logs, caps and metric feature names.
- **Races:** in-memory state in one process; append-only log. The daily cap is
  counted before the call, so concurrency cannot exceed it; at most 2 calls in
  flight.
- **Feedback loops:** none. The shadow writes only its own log, which no session
  or gate reads.

---

## 6. External surfaces

- **Other agents:** fleet agents get the code and the CLAUDE.md card; the
  feature stays dark (dev gate) and they hold no TypeSafe key.
- **External systems:** on the development agent, the scrubbed user message
  (≤1,500 code points) and context (≤800) go to TypeSafe (`api.typesafe.ai`),
  the vendor already used by the other Jev shadows, under its existing account.
  Bounded by the daily cap (default 500 calls ≈ $0.05/day), 2 in flight, a
  1.5 s abort.
- **Persistent state:** one append-only JSONL log, ~400 bytes per user message
  (~25/day on the dev agent). The summary reads the last 5 MB.
- **Operator surface:** none beyond a Bearer read route.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: each machine logs the inbound messages its own adapter
logs; the research question is a rate that per-machine logs answer. No
user-facing notices, no durable state that follows a topic, no generated URLs.

---

## 8. Rollback cost

Pure code change. Kill switch: `intelligence.jevCorrectionShadow.enabled: false`
(read live, no restart). Full back-out: revert and ship a patch; the log can be
left or deleted. No user-visible effect in either direction.

---

## Conclusion

Clear to ship behind the dev gate. The 14-day backfill (Jev 90 vs Layer 0 12
over 347 operator messages) shows the recall gap is real and large; this
measures it live before anything changes what the sentinel learns.

---

## Second-pass review (if required)

**Reviewer:** independent review subagent (one 80/20 round, 2026-10-05)
**Independent read of the artifact: concur, after four fix-class findings were fixed**

- Part of the check (vault re-read, 5 MB cap seed, scrubs, Layer 0) ran
  synchronously inside `onMessageLogged` before the first await. Fixed: the
  whole check is deferred with `setImmediate`; a unit test pins that
  `observe()` returns before Layer 0 or the call runs.
- Agent context was cut to 3,200 characters before the scrub. Fixed: the
  stored tail is the full 8,192-character scrub span; a unit test with a
  4,000-character token fails under the old cut.
- The row's unsalted text digest made short replies recoverable and was
  redundant with `messageId`. Fixed: removed.
- The once-a-day cap note repeated after each restart. Fixed: seeded from the
  log; tested across a restart.

Confirmed sound: server wiring scope and chaining, the sentinel's verdict
unchanged (`classify` is pure), cap and in-flight bounds race-free, timeout
covering the body read, gate and live kill switch, migration parity, typecheck,
and 2,383 related tests passing.

Full record: `docs/specs/reports/jev-correction-shadow-convergence.md`.

---

## Evidence pointers

- `tests/unit/jev-correction-shadow.test.ts`, `tests/integration/jev-correction-shadow-routes.test.ts`, `tests/e2e/jev-correction-shadow-lifecycle.test.ts`.
- Backfill: `docs/research/jev/harness/idea5-correction-detector/backfill.mjs` (research space, not shipped) — imports the built module's rendering, question, model pin and threshold.
- Live smoke through the real class with the vault key (2026-10-05): "you do not need my approval… stop waiting on me" → correction 0.54 / preference 0.46, flagged, Layer 0 silent; "sounds good, go ahead" → neither, not flagged; "from now on always give me the direct link" → preference 1.0, flagged, Layer 0 agreed. 108–185 ms.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. Not a self-triggered
controller: it never fires a restart, retry, respawn, spawn, notify or kill; its
only action is one bounded, capped vendor call and a log row per user message.
