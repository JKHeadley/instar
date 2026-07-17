# Side-Effects Review — Lifeline "reconnecting" notice (fix false "Server is restarting")

**Version / slug:** `lifeline-reconnect-notice`
**Date:** `2026-07-17`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `Echo (Phase-5 self-review — see below)`

## Summary of the change

The lifeline forwards inbound Telegram messages to the server and, when it cannot forward right now, queues the message and sends the user a heads-up. There are two distinct "couldn't deliver right now" states — the server is genuinely **down** (`supervisor.healthy === false`) versus the server is **healthy but this one forward failed** (transient 10s timeout / 5xx / 503-boot / connection blip, `supervisor.healthy === true` and `forwardToServer()` returned non-`ok`). The healthy-but-failed branch was sending the user the false, alarming `Server is restarting. Your message has been queued…` even though the server was confirmed up. Reported by peer agent Luna (Sagemind) 2026-07-17, verified against source; it also hit operator Justin directly.

Files touched:
- `src/lifeline/queuedNotice.ts` (new) — a pure helper `buildQueuedNotice(kind, queueLength, serverHealthy)` that centralizes the notice wording.
- `src/lifeline/TelegramLifeline.ts` — the four queue-ack call sites (text healthy-fail, text down, photo, file/document) now route through the helper; the two photo/file inline `if/else` blocks collapse to one call each.
- `tests/unit/lifeline/queuedNotice.test.ts` (new) — unit coverage.

## Decision-point inventory

- `TelegramLifeline` queue-ack wording (text/photo/file handlers) — **modified (wording/logic only)** — picks the user-facing notice string from the live `supervisor.healthy` verdict. This is a message-*wording* decision, not a message *block/allow* or delivery decision. No gating authority added, removed, or changed.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The change never suppresses, delays, or rejects a message; it only chooses the text of a heads-up that is already being sent (still gated by the unchanged `shouldSendQueueAck` rate-limiter). Message queueing/delivery is entirely unchanged.

---

## 2. Under-block

No block/allow surface — under-block not applicable. The queued message still enqueues and replays exactly as before; the only behavioral delta is the words in the notice.

---

## 3. Level-of-abstraction fit

Correct layer. The wording decision belongs precisely where the send happens — the lifeline handler that already holds the `supervisor.healthy` verdict and the queue length. The new helper is a pure string builder (lowest sensible level: no I/O, no decision authority). It does not re-implement or run parallel to any existing gate; it consumes a health verdict the caller already computed. Centralizing the three previously-duplicated sites into one tested function is a strict simplification (DRY), not a new abstraction competing with an existing one.

---

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change has no block/allow surface.

`buildQueuedNotice` holds ZERO authority: it neither restarts anything, nor decides whether to send, nor gates delivery. It is handed a health SIGNAL (`supervisor.healthy`, computed by the existing supervisor) and returns descriptive text. The authority to restart the lifeline remains entirely with the existing `RestartOrchestrator` / `LifelineDriftPromoter`; this change deliberately stops the notice from *asserting* a restart the system did not perform — i.e. it makes the user-facing text HONEST about the current state rather than claiming an action. No brittle logic gains blocking authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The wording is chosen from a single, enumerable boolean (`serverHealthy` true/false) — an invariant two-state fork, not a point where multiple live signals conflict. There is no arbiter needed and none added.

---

## 5. Interactions

- **Shadowing:** none. The notice send sits after `shouldSendQueueAck` (unchanged) and does not run before/after any gate whose outcome it could mask.
- **Double-fire:** none introduced. The version-skew path (`handleVersionSkew`, fired on a 426) is a separate code path and is untouched; this change does not add a second notice.
- **Races:** none new. `this.queue.length` is read at send time exactly as before; no new shared state is introduced (the helper is stateless/pure).
- **Feedback loops:** none. The text is terminal output to the user; it feeds nothing back into the forward/queue machinery.
- **Down-branch wording preserved byte-for-byte:** the `serverHealthy === false` output is identical to the previous inline strings (locked by a test), so any downstream that keys on that exact text (e.g. the duplicate-message dedup window) sees no change.

---

## 6. External surfaces

- **Other agents / install base:** ships in the instar package `dist/`; every agent gets the corrected wording when it updates and its lifeline restarts onto the new version. No migration needed — the lifeline is compiled package code, not an agent-installed file (`.claude/settings.json`, config defaults, CLAUDE.md template, hook scripts, or built-in skills), so `PostUpdateMigrator` is not involved.
- **Telegram:** the only external-visible change is the improved notice text a user reads when a forward transiently fails. No API shape, topic, or delivery-path change.
- **Persistent state:** none. No schema, ledger, or state-file change.
- **Timing/runtime:** the branch is selected from the live `supervisor.healthy` at send time — same input the old code had at the same spot.
- **Operator surface (Mobile-Complete):** no operator-facing actions added or touched. This is a USER-facing message, not an operator action/approval/grant surface.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. This change touches a **user-facing** Telegram notice, not a dashboard renderer, approval page, or grant/revoke/secret-drop form. (For completeness on the user-facing text quality: the new notice leads with the real state in plain language — "I'm having trouble reaching my server right now — your message is queued (N in queue) and I'll deliver it as soon as I reconnect." — exposes no raw internals, and is honest rather than alarming.)

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The lifeline is a per-machine process: each machine's lifeline forwards to that machine's own server and its `supervisor.healthy` verdict is about the local server. The notice is emitted by whichever machine actually received and tried to forward the user's message, so there is no cross-machine state to replicate or proxy. It emits a user-facing notice, but one-voice gating is not newly needed: the send is already governed by the existing per-topic `shouldSendQueueAck` rate-limiter and the pre-existing duplicate-message suppression window — this change alters only the words, not the send cadence or the number of voices. No durable state (nothing to strand on topic transfer) and no generated URLs.

---

## 8. Rollback cost

Pure code change — revert the two source files (and the new helper/test) and ship as the next patch. No persistent state, no data migration, no agent-state repair, no user-visible regression during the rollback window (worst case is the old wording returns). One-line-scale back-out.

---

## Conclusion

The review confirms a tightly-scoped, low-risk wording/logic fix with no decision-point authority, no block/allow surface, no persistent state, and no multi-machine coherence hazard. The design change made during review was to extract the wording into a single pure helper (rather than edit three inline strings), which both makes the fix unit-testable in isolation and removes the duplicated photo/file `if/else` — closing the "three copies drift apart" failure mode structurally. The genuinely-down wording is preserved byte-for-byte to avoid any downstream dedup/text-matching side effect. Scope was deliberately held to the three reported sites; the drift-promoter threshold question and the callback-query down-message were left untouched (flagged to the reporter as separate items). Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** Echo (self, Phase-5 — the change touches the messaging/lifeline path)
**Independent read of the artifact: concur**

Concur with the review. Re-verified independently: (1) the only remaining `Server is restarting` string in `TelegramLifeline.ts` is the callback-query genuine-`!supervisor.healthy` branch (out of scope, and at least plausibly-true in a down state); (2) all four queue-ack sites now route through `buildQueuedNotice`; (3) the down-branch bytes are unchanged (test-locked); (4) no self-triggered action is added — the notice is a one-shot response to an inbound user message, not a self-firing loop. No concern raised.

---

## Evidence pointers

- `npx tsc --noEmit` — clean (exit 0).
- `npx vitest run tests/unit/lifeline/queuedNotice.test.ts` — 8/8 pass.
- `npx vitest run tests/unit/lifeline/` — 18 files / 160 tests pass (no regression).
- `pnpm build` — dist compiles; `dist/lifeline/queuedNotice.js` present; exactly 1 `Server is restarting` remains in `dist/lifeline/TelegramLifeline.js` (the intentional callback-down site).

---

## Class-Closure Declaration (display-only mirror)

Not a self-triggered controller and not a fix to an agent-authored artifact (prompt/hook/config/skill/standards text). This is a fix to compiled TypeScript runtime behavior — a one-shot, user-message-driven notice, not a loop/monitor/sentinel/reaper/scheduler/recovery path. `unbounded-self-action` class: `n/a` — one-shot user-driven action, not a self-triggered loop.
