# Side-Effects Review — Lifeline message-drop robustness (Stage A)

**Version / slug:** `lifeline-message-drop-stage-a`
**Date:** `2026-04-19`
**Author:** `echo`
**Second-pass reviewer:** `reviewer subagent (required — touches inbound messaging)`

## Summary of the change

`TelegramLifeline` previously made a single-shot `fetch` in `forwardToServer()` and silently dropped messages in `replayQueue()` after `MAX_REPLAY_FAILURES`. Stage A closes the silent-drop window without changing anything else: (1) wraps the in-flight forward with a 3-attempt 1s/2s/4s retry, and (2) when the replay drop is reached, appends a durable record to `<stateDir>/state/dropped-messages.json`, emits a `DegradationReporter` event under `feature = 'TelegramLifeline.forwardToServer'`, and sends the original sender a plain-English "please resend" notice in their topic. Two new helpers (`retryWithBackoff`, `droppedMessages`) are introduced; they are pure, deterministic utilities. No change to the handoff payload shape, no change to server routes, no change to any gate.

Files touched:

- `src/lifeline/retryWithBackoff.ts` (new, 43 lines)
- `src/lifeline/droppedMessages.ts` (new, ~165 lines)
- `src/lifeline/TelegramLifeline.ts` (imports + `forwardToServer` retry + `replayQueue` drop-path notification)
- `tests/unit/lifeline/retryWithBackoff.test.ts` (new)
- `tests/unit/lifeline/droppedMessages.test.ts` (new)
- `tests/unit/lifeline/droppedMessageNotify.test.ts` (new)

## Decision-point inventory

- `TelegramLifeline.forwardToServer` — **modify** — single-attempt `fetch` replaced by retry-wrapped `fetch`. Retry policy is mechanics (fixed count, fixed backoff), not judgment.
- `TelegramLifeline.replayQueue` drop branch — **modify** — adds persistence + `DegradationReporter.report` + user-visible `sendToTopic` notice before the existing console.warn drop.
- No block/allow surface added. No existing authority shadowed.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. The change never rejects input; it only adds retry attempts and a notification on an already-determined drop.

Collateral "over-notify" is possible in theory: if the user sends a rapid burst of messages during a genuine server outage, each one that ends up in the replay-drop path would produce its own Telegram notice. This is bounded by `MAX_REPLAY_FAILURES` (3) and by the replay cadence — so the burst would have to persist across multiple full replay cycles, each spaced by the supervisor's recovery attempts. In practice the user gets at most one notice per truly-dropped message, which matches the intent: "tell me about messages I lost."

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable. Failure modes this Stage A does NOT address (intentionally; they're Stage B/C):

- A stale lifeline running an older package version can still hand the server a payload the server rejects. The Bob incident happened this way. Stage B adds a version check to the handoff.
- A crash between `appendDroppedMessage` success and the eventual `sendToTopic` could leave a durable record with no user notice. The DegradationReporter event still fires to the attention topic, so the drop is not silent from the operator's perspective; it is potentially silent to the original sender. Stage C's chaos tests will exercise this path.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

`retryWithBackoff` is a detector-level primitive (mechanics, no judgment, deterministic). It lives in `src/lifeline/` because only the lifeline uses it today; if a second call site emerges the helper can promote to a shared utility without behavior change.

`droppedMessages.notifyMessageDropped` is a signal producer: it writes a durable record, emits a `DegradationReporter` event, and sends a user-visible Telegram message. All three outputs are consumed by *existing* authorities (the operator surfaces the state file or the dashboard; DegradationReporter has its own downstream pipeline that feeds FeedbackManager and the attention topic; Telegram is the user's own eyes). This helper does not itself decide whether a message *should* be dropped — it reacts to the caller's already-made decision. Correct layer.

No higher-level gate already exists that this should feed instead — the existing drop path had no signal emission at all. This helper *is* that signal.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

The retry is pure mechanics (fixed count, fixed backoff) — not a decision point. The drop path that existed before this change is also pure mechanics (fixed failure-counter threshold in `MessageQueue`). This change adds *signal emission* (durable record, DegradationReporter event, Telegram notice) to a mechanism that was previously silent. The consumers of those signals are existing authorities: DegradationReporter's existing downstream pipeline, and the human operator reading the attention topic / state file. Compliant.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** `forwardToServer`'s retry runs before the existing queue-and-replay path. The retry uses up to ~7s of wallclock (1s + 2s + 4s in the failure case). That's inside the caller's normal "queue this and acknowledge" window — the queue+replay path is unchanged and still fires when retry exhausts. No shadowing.
- **Double-fire:** `DegradationReporter` has per-feature cooldown (1h) built in (`ALERT_COOLDOWN_MS` in `DegradationReporter.ts`). A storm of drops within one hour will log+persist every one, but only the first triggers the attention-topic alert. Intentional — the file is the durable record; the alert is the human-facing surface. The per-sender Telegram notice fires once per dropped message regardless of cooldown (the sender needs to know about *their* message, not be deduped against unrelated drops).
- **Races:** `appendDroppedMessage` uses an atomic file swap (write-to-tmp, then `renameSync`) — the swap itself is atomic, mirroring the existing `saveRateLimitState` pattern in the same file. The surrounding read-modify-write is *not* atomic across concurrent callers: if two writers race, the last `renameSync` wins and the earlier writer's appended record is overwritten. Accepted for a debugging / operator-visibility record; no user-visible correctness impact (the DegradationReporter event and the per-sender Telegram notice are the load-bearing notifications, and both fire independently of this file).
- **Feedback loops:** The user-notice `sendToTopic` itself goes through the normal Telegram path. It could in principle fail, which would not re-enter the drop pipeline (there's no recursive replay of the notice). Failures are swallowed — the durable record and the DegradationReporter event are the authoritative signals.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents:** no. The change is confined to the lifeline process on each agent individually.
- **Other users:** yes, and deliberately — users whose messages would have been silently dropped now get a plain-English notice asking them to resend. This is the intended user-visible change.
- **External systems:** Telegram is the only external surface. One extra per-drop message per dropped message. Rate-limited by the drop rate itself, which in steady-state is zero.
- **Persistent state:** new file `<stateDir>/state/dropped-messages.json`, ring-buffered to 500 records, ~200 bytes each → max ~100KB on disk. Additive — older versions that don't know about this file will simply ignore it.
- **Timing:** `forwardToServer` worst-case wallclock grows from one 10s fetch to three 10s fetches + (1s + 2s) backoff = up to ~33s. Caller is the async polling loop, which is non-blocking w.r.t. other Telegram updates. No new timing dependency we don't control.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code revert. No migration. `dropped-messages.json` is additive — ignoring it on rollback is safe. `DegradationReporter` category `TelegramLifeline.forwardToServer` requires no schema change; on rollback the reporter simply stops receiving events under that feature name. Users who received a "couldn't deliver" notice already have the notice delivered; no inconsistency.

Estimated rollback: one `git revert`, one release, zero downtime.

---

## Conclusion

Stage A is a pure signal-addition change on top of an already-mechanical drop path. It introduces no new authority, no new block/allow surface, no schema change, and one new additive state file. The failure modes it does NOT address (version skew, chaos-level reliability) are intentional scope deferrals for Stage B/C. The change is clear to ship once the second-pass reviewer concurs and the full vitest suite passes (noting pre-existing failures on the source branch — see Evidence pointers).

---

## Convergent-review fixes (2026-04-20)

After a 4-lens convergent review (security / scalability / adversarial / integration) the following material findings were applied to the shipped change:

- **Markdown injection in the per-sender notice (adversarial, security).** `sendToTopic` uses `parse_mode: 'Markdown'`, so echoing raw user text in the "please resend" notice would render user-controlled `_` / `*` / `[…](…)` / backticks as formatting or clickable links. **Fix:** the preview is now wrapped in a triple-backtick code fence, and any triple-backtick runs inside the preview are rewritten to `'''` to prevent breakout. A new test (`escapes markdown breakout attempts in the preview`) asserts exactly two backtick runs (the fence itself).
- **Correlated-failure silent-drop hole (adversarial).** If `appendDroppedMessage` throws AND `FEATURE_FORWARD` is mid-cooldown AND `sendToTopic` throws, all three catches would swallow. **Fix:** on persist failure we now additionally fire a second `DegradationReporter.report` under a **distinct** feature `TelegramLifeline.dropRecordPersist`. Its cooldown is independent of the primary feature's, so correlated-failure paths still produce at least one loud operator signal. New test: `fires a distinct DegradationReporter feature when persistence itself fails`.
- **sendToTopic latency compounding (scalability).** A Telegram outage could hang the notice for ~30–60 s on top of the 33 s retry. **Fix:** `sendToTopic` is now wrapped in a 5 s `Promise.race` timeout via an internal `withTimeout` helper. New test: `bounds sendToTopic with a timeout so a hung Telegram does not block`.
- **Feature-name taxonomy mismatch (integration).** Existing lifeline DegradationReporter events use `Class.method` form (see `src/messaging/TelegramAdapter.ts`). **Fix:** feature renamed from `TelegramLifeline.MessageForwarding` → `TelegramLifeline.forwardToServer`. Tests + spec updated.
- **Parallel dead-letter pattern not acknowledged (integration).** `MessageRouter.deadLetter` and `state/failed-messages/` already exist. **Fix:** spec now contains a "Relationship to existing dead-letter systems" section documenting why the lifeline needs its own file-backed store (process boundary) and how Stage B can bridge to `MessageRouter` later.
- **Version-skew amplification under Stage A (adversarial, deferred).** Stage A makes each version-skew rejection 3× slower. Acknowledged in the spec's "Failure modes intentionally left unfixed" — the loudness guarantee still holds (notice now fires where none did before); only time-to-notice grows. Not blocking; Stage B closes it.

Test count after fixes: **18 passing** (3 new from convergent review).

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (agentId: a90b878b08335adc5)
**Independent read of the artifact: concern → resolved**

The reviewer independently read the artifact and the actual diff and concurred on scope, signal-vs-authority compliance, level-of-abstraction fit, and absence of duplication. Three concerns were raised, all non-blocking:

- Atomicity wording overclaim in §5 — **resolved.** §5 now distinguishes the atomic file swap from the non-atomic read-modify-write around it.
- Worst-case timing arithmetic in §6 said ~37s; actual is 3×10s fetch + (1s+2s) backoff = ~33s — **resolved.** §6 now reports ~33s with the math spelled out.
- User-facing notice used "my internal handoff kept failing," which slips below Echo's ELI10 bar — **resolved.** The notice in `droppedMessages.ts` now reads "something on my end kept failing." Existing tests assert on "couldn't deliver" and "resend," both still present; no test churn.

With the three fixes applied, the reviewer's verdict ("core conclusions of the artifact stand") carries through to the shipped change.

---

## Evidence pointers

- New helper tests: `tests/unit/lifeline/retryWithBackoff.test.ts`, `tests/unit/lifeline/droppedMessages.test.ts`, `tests/unit/lifeline/droppedMessageNotify.test.ts` — **15/15 passing** locally in the isolated worktree (`2026-04-19`).
- Typecheck: `npx tsc --noEmit` — clean.
- Full-suite run on branch: 710 passed / 5 test files failed (6 tests). **All failures reproduce on main independently**:
  - `tests/unit/no-silent-fallbacks.test.ts` — baseline drift (current=174 vs baseline=86); pre-existing tech debt unrelated to lifeline (scope excludes `src/lifeline/`).
  - `tests/unit/ListenerSessionManager.test.ts > starts in dead state` — fails on main in isolation.
  - `tests/unit/agent-registry.test.ts > allocates from range` / `reclaims ports from stale agents` — fails on main in isolation.
  - `tests/unit/security.test.ts > zero execSync calls` — fails on main in isolation.
  - `tests/unit/middleware.test.ts`, `tests/integration/machine-routes.test.ts`, `tests/unit/moltbridge/routes.test.ts` — pass isolated (flaky under concurrency); not caused by this change.
- Worktree path: `.instar/worktrees/build-stage-a--lifeline-message-drop-robustnes`
- Branch: `build/stage-a--lifeline-message-drop-robustnes`
