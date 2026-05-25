# Side-Effects Review — Emergency-stop on the lifeline forward path

**Version / slug:** `emergency-stop-forward-path-wiring`
**Date:** `2026-05-24`
**Author:** `echo`
**Second-pass reviewer:** `not required (single localized, fail-open route addition; spec-driven)`

## Summary of the change

Wires the existing `MessageSentinel` emergency-stop/pause intercept into `POST /internal/telegram-forward` (the lifeline ingress path) so that lifeline-owned-polling agents — which never run `TelegramAdapter.processUpdate()`, where the intercept currently lives — actually honor "stop everything". Before this, those agents (e.g. echo) delivered emergency-stop messages to the session as normal text and nothing halted a running/wedged session. One file touched: `src/server/routes.ts` (a ~50-line block inserted after request validation, before message logging/routing). Reuses the existing `ctx.telegram.onSentinelKillSession`/`onSentinelPauseSession` callbacks and `stopAutonomousTopic`; adds no new kill logic. Spec: `docs/specs/emergency-stop-forward-path-wiring.md`.

## Decision-point inventory

- `MessageSentinel.classify` (existing authority) — **pass-through** — its verdict is unchanged; this change only routes the verdict to an action on a path that previously ignored it.
- `/internal/telegram-forward` routing decision — **modify** — adds an emergency-stop/pause short-circuit before the existing `onTopicMessage`/registry-inject routing. Normal messages are unaffected.
- Session kill / pause / autonomous-clear — **pass-through** — reuses `onSentinelKillSession`, `onSentinelPauseSession`, `stopAutonomousTopic` exactly as the `processUpdate` path does.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Only messages the sentinel classifies as `emergency-stop` or `pause` are intercepted (not routed to the session). That is the intended behavior and matches the already-live `processUpdate` path. The classifier's own over-block surface is unchanged (live-tested: a long sentence merely containing "stop" → `normal`, routed normally). A false-positive emergency-stop would terminate the session — but (a) the classifier already gates this with word-count + exact/regex/LLM disambiguation, and (b) the user can simply send a new message to respawn; no data loss (resume UUID is saved by `onSentinelKillSession`). No new over-block beyond what `processUpdate` already exhibits.

---

## 2. Under-block

**What failure modes does this still miss?**

- A genuinely-wedged classifier (LLM provider down) → fail-open → the emergency-stop is NOT honored (message routes normally). This is the deliberate trade: never block delivery. The deterministic exact/regex patterns ("stop", "cancel", "halt") do not require the LLM, so the most common emergency phrasings still classify without a provider.
- Non-Telegram lifeline paths (none currently) would need the same treatment.
- This change does not address the still-dark `processUpdate`-only assumption for any *other* per-message safety hook; scope is the sentinel only.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The smart authority (`MessageSentinel`, LLM + deterministic patterns) already exists and already owns the decision. This change is pure routing: it ensures the authority's verdict reaches the action on the server-side ingress path that lifeline-owned agents use. It does not re-implement classification (would be the wrong layer); it consumes the existing authority's output. It places the intercept at the server route layer — the correct single choke-point for the lifeline path, mirroring where `processUpdate` sits for the adapter-poll path.

---

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change produces no new block/allow logic; it routes an existing smart-gate (`MessageSentinel`, LLM-backed with deterministic patterns) verdict to its action.

The sentinel remains the sole authority. The forward route is a consumer of its verdict, not a new detector. No brittle logic gains blocking authority. (And the action is fail-open: a classifier error degrades to normal delivery, never to a wrong block.)

---

## 5. Interactions

- **Shadowing:** The new block runs AFTER the version-handshake (426/400 still short-circuit first) and BEFORE message logging + `onTopicMessage` routing. It does not shadow the handshake. It intentionally shadows routing for emergency-stop/pause (that's the point) — confirmed `logInboundMessage` is skipped for intercepted messages, which is acceptable (an emergency-stop need not be logged as a conversational turn; the kill is logged to the server log).
- **Double-fire:** For lifeline-owned agents, `processUpdate` does not run, so there is no double-intercept. For adapter-poll agents, the forward route is not used, so again no double-fire. The two paths are mutually exclusive per deployment mode. No agent runs both for the same message.
- **Races:** `onSentinelKillSession` already encapsulates resume-UUID save + kill (its existing concurrency behavior is unchanged). `stopAutonomousTopic` is idempotent (best-effort, try/catch). Session resolution reads the registry file read-only.
- **Feedback loops:** None. The intercept terminates routing; it does not feed back into the sentinel.

---

## 6. External surfaces

- **Other agents on same machine:** none — server-local route logic.
- **Install base:** ships to every agent via the normal server build. Adapter-poll agents are unaffected (path unused); lifeline-owned agents gain the (intended) emergency-stop. No agent-installed file (hook/config/template) changes → no `PostUpdateMigrator` work.
- **External systems:** on emergency-stop/pause the route now sends one Telegram message ("Session terminated." / "Session paused." / "No active session to stop."), matching the `processUpdate` user-facing copy. No new external endpoints.
- **Persistent state:** none added. Reads `topic-session-registry.json` read-only; `onSentinelKillSession` writes the resume-UUID map exactly as today.
- **Response shape:** the route now may return `{ ok:true, sentinel:'emergency-stop'|'pause', killed|paused }` instead of `{ ok:true, forwarded:true }` for intercepted messages. The lifeline treats any 200 as delivered; the new fields are additive and ignored by existing callers.

---

## 7. Rollback cost

Pure code change in one route, fail-open by design. Back-out = revert the block; behavior returns to current (sentinel dark on the forward path). No persistent state, no schema, no migration, no agent-state repair. The fail-open guarantee means even a bug in the block degrades to "behaves like today" (message routes), never to blocked delivery — so the rollback urgency is low even if a defect ships.

## Conclusion

The review produced no design changes — the fix is a faithful port of the already-tested `processUpdate` intercept to the lifeline ingress path, consuming the existing sentinel authority, fail-open. The only behavioral change is that emergency-stop/pause now fire for lifeline-owned agents, which is the intended P0 safety fix. Integration tests cover both sides of every boundary (kill/pause/normal/fail-open/no-session) plus a wiring-integrity assertion that classification precedes routing (the guard whose absence caused the original drift). Clear to ship. Live end-to-end verification (real Telegram "stop everything" terminating a real session) occurs post-deploy, since it requires the merged build running; pre-merge proof is the integration suite exercising the real route handler.

---

## Second-pass review (if required)

Not required — single localized, fail-open route addition with full test coverage and no new decision logic.

---

## Evidence pointers

- Reproduction (pre-fix): live `POST /sentinel/classify` returns `emergency-stop` for "stop everything"; code trace shows `/internal/telegram-forward` (the live path for lifeline-owned echo) had zero sentinel references → message routed as normal.
- Post-fix proof: `tests/integration/telegram-forward-sentinel-intercept.test.ts` — 6/6 green (emergency-stop kills + not-routed; pause; normal-routes; fail-open-routes; no-session; wiring-integrity classify-before-route).
