# Side-Effects Review — Jev review-flag shadow (log-only "does this reply need review?" measurement)

**Version / slug:** `jev-review-flag-shadow`
**Date:** `2026-10-05`
**Author:** `echo`
**Second-pass reviewer:** `independent review subagent + codex-cli gpt-5.5 (one 80/20 round on the spec)`

## Summary of the change

A dark, log-only research instrument (spec `docs/specs/jev-review-flag-shadow.md`).
A 60-second unref'd server timer reads the last 512 KB of the agent's own
Telegram history, selects each agent conversational reply (provenance
`agent`, at most 30 minutes old, newer than its topic's watermark), pairs it
with the operator message it answers (same topic, earlier, within 6 hours),
secret-scrubs both before cutting them (reply 2,000, request 600 characters,
cuts disclosed in band), asks Jev (`jev-1.13.0`) one three-label question
(`needs_review` / `fine` / `cannot_tell`) in both option orders, and appends a
content-free row to `logs/jev-review-flag-shadow.jsonl`.
`GET /jev-review-flag/summary` reads the log. Files:
`src/core/JevReviewFlagShadow.ts` (new), `src/server/routes.ts` (one read
route), `src/commands/server.ts` (construction + start),
`src/config/ConfigDefaults.ts`, `src/core/types.ts`,
`src/core/devGatedFeatures.ts`, `src/scaffold/templates.ts` +
`src/core/PostUpdateMigrator.ts` (awareness card, both paths),
`src/server/CapabilityIndex.ts` (internal prefix).

## Decision-point inventory

No decision-point surface. Nothing is blocked, allowed, filtered, delivered or
routed. No code path reads the log except the summary route, which a person
reads.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Measurement blind spots,
named in the spec: Slack replies (not in this history); desk messages sent
through the operator's account can be picked as the request; replies logged
more than 30 minutes before the timer sees them (only possible if the server
was down) are not judged.

---

## 3. Level-of-abstraction fit

Right layer. The operator corrects what reaches Telegram, and the server
already keeps that history; reading it server-side needs no hook, no settings
migration and no per-framework work. It reuses `readJsonlTailLines`,
`scrubForStore`, `resolveDevAgentGate` and the feature-metrics recorder, and
follows the jev-circles-shadow shape (vault key, closed reason enums, daily
cap seeded from the log). It does not feed a gate: the point is to measure
before anything is shown.

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
threshold only labels rows in a research log; both orders' probabilities are
kept so the threshold can be moved after the fact. No action follows.

---

## 5. Interactions

- **Shadowing / double-fire:** none. It reads the Telegram history (append-only,
  written by TelegramAdapter) and writes only its own log. The other Jev
  shadows have separate logs, feature names and daily bounds.
- **Event loop:** one synchronous bounded read of at most 512 KB per minute
  (the same helper the 2026-06-22 event-loop fixes introduced), off every
  request path; nothing when disabled. Calls are sequential, so at most one is
  in flight.
- **Races:** a reply logged after a tick is seen at the next tick. Ticks never
  overlap (a `running` latch). Watermarks advance only past replies that were
  judged or failed at the vendor/scrub, so the daily cap never drops an
  eligible reply silently; seeding from the log at start means a restart
  judges nothing twice.
- **Feedback loops:** none. It never sends, so it never adds to the history it
  reads.

---

## 6. External surfaces

- **Other agents:** fleet agents get the code and the config block; the
  feature stays dark (dev gate) and they hold no TypeSafe key.
- **External systems:** on the development agent, a scrubbed reply (≤2,000
  characters) and request (≤600) go to TypeSafe (`api.typesafe.ai`), the
  vendor the other Jev shadows already use. Bounded by the daily cap (default
  3000 calls ≈ $0.45/day worst case; ~$0.05/day expected), one call at a time,
  and a 1.5 s abort.
- **Persistent state:** one append-only JSONL log (~300 bytes/row, a few
  hundred rows/day); the summary reads only the last 5 MB.
- **Operator surface:** none. The read route is informational (Bearer).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: each machine judges the replies its own Telegram
history holds (the sends relayed through it), and the measurement is a rate
that per-machine logs answer; scoring joins each machine's log to the same
machine's history by message id. No notices, no topic-following state, no
generated URLs.

---

## 8. Rollback cost

Pure code change. Kill switch: `intelligence.jevReviewFlagShadow.enabled:
false` (read live at the next tick, no restart). Full back-out: revert and
ship a patch; the log file can be left or deleted. No user-visible effect in
either direction.

---

## Conclusion

Clear to ship behind the dev gate. The review round moved the trigger from
the Stop hook to a server-side tail of the Telegram history, which removed a
hook change, a reply-logging race, a session-name mismatch and the
Claude-only limit; the remaining findings were local and are tested.

---

## Second-pass review (if required)

**Reviewer:** independent review subagent + codex-cli gpt-5.5 (one 80/20 round, 2026-10-05)
**Independent read: concur, after the trigger change and local fixes above**

Full record: `docs/specs/reports/jev-review-flag-shadow-convergence.md`.

---

## Evidence pointers

- `tests/unit/jev-review-flag-shadow.test.ts`, `tests/integration/jev-review-flag-shadow-routes.test.ts`, `tests/e2e/jev-review-flag-shadow-lifecycle.test.ts`.
- Live smoke through the real module, real history and real vendor
  (2026-10-05): 4 replies judged, 89–169 ms, all `fine`, both orders agreeing;
  no message text in the log.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. Not a self-triggered
controller in the `unbounded-self-action` sense: it never fires a restart,
retry, respawn, spawn, notify or kill; its only action is one bounded, capped
vendor call and a log row per agent reply.
