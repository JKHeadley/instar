# Side-Effects Review — usage-wall rescue

**Version / slug:** `usage-wall-rescue`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

A session that sits at its subscription account's usage wall is now moved to an account with room and continues; it used to sit silently until the window reset (2026-11-04 incident, fb-6e43a66a-75d / fb-d2862f4d-b52). Four parts:

1. `rateLimitDetection.ts`: a separate, anchored, settled usage-wall signal (`detectUsageWall`, `evaluateUsageWallSettle`, `isPaneChromeLine`). `SessionWatchdog.checkUsageWall` emits `'usage-wall'`. The throttle decision is unchanged.
2. `src/core/UsageWallRescue.ts` (new): resolves the account a session is on (tag or explicit config home = proven identity; the default login = a candidate that is excluded as a target but never blamed), checks a proven identity's wall against its own fresh quota reading, and calls the existing reactive swap (`QuotaAwareScheduler.onQuotaPressure`) through one funnel with brakes. It also provides the spawn-account resolver (tag new spawns with the freshest-reading, most-room account; guard against a known-walled default login) and the standby wording.
3. `PresenceProxy.detectQuotaExhaustion` ignores Claude Code chrome lines (the auto-continue notice and status line made a live wall read as "recovered") and reads a bare reset time.
4. One switch, `subscriptionPool.wallRescue.enabled`, default `true` (operator-approved 2026-11-04), effective only with 2+ usable accounts. Existing agents get it through `applyDefaults` add-missing; an explicit `false` is kept. CLAUDE.md template, migrator text and CapabilityIndex corrected (they claimed the proactive swap covers untagged sessions). Read-only status route `GET /subscription-pool/wall-rescue`.

Tier 2 (default-on authority to restart sessions, fleet config migration). Size: about 20 files, roughly 1,700 added lines including about 800 lines of tests. Effort: spec review ran the full 6 rounds (internal reviewers plus a GPT-tier outside review each round) and a final verification; ⚠ at the cap, because each outside round found a narrower real edge in account identity and user wording. One commit attempt so far.

## Decision-point inventory

- Is the pane at a usage wall? — add (signal only).
- Move a walled session? — modify (existing reactive swap authority, newly reachable for walls, behind corroboration and brakes).
- Which account is the session on? — add (tag > explicit home > default resolver; unknown holds).
- Tag a new spawn / spawn guard — modify (`SessionManager` spawn-account resolver, previously unset unless `pinSessionsToPool`).
- Standby wording / direct notices — add.
- Legacy `autoSwapOnRateLimit: true` throttle swap — modify (now through the same funnel and brakes; resolves untagged sessions).

---

## 1. Over-block

The rescue holds (does not move) when: a proven account's fresh reading is under the soft threshold (`source-not-walled`, which also requests a coalesced re-poll), a proven account's blocking window resets within 15 minutes, the account cannot be resolved, the session is an untagged Codex session, or a brake applies. A real wall on a model-specific limit (e.g. an Opus-only weekly limit) that the binding-utilization reading does not reflect will read as `source-not-walled` and hold; that is today's behavior for that case, not a regression. The spawn resolver never picks an account without a fresh reading, so a newly enrolled, not-yet-polled account is skipped until its first poll.

## 2. Under-block

- A file whose first line is the exact banner, printed as the last thing on screen with nothing after it, can still read as a wall. The settle window and the fresh-reading corroboration bound the damage to one `--resume` restart.
- Proactive (pre-wall) moves of untagged sessions remain off by design (Q3).
- An untagged session's default-login answer is only a candidate: if it is wrong, the move still goes to an account with room (the candidate is excluded, never blamed). If the candidate is the only account with room, the session waits for the reset and the user gets the standard notice.
- More than 12 walled sessions on one machine in an hour: the excess waits for the next hour.

## 3. Level-of-abstraction fit

Detection lives with the existing throttle detector, and the watchdog only emits. Decisions live in one new module beside the scheduler. The move itself is the existing `onQuotaPressure`, which already owns selection and restart. Nothing is duplicated, and the reactive selection semantics (I6) are untouched.

## 4. Signal vs authority compliance

Compliant. The pane classifier is a signal. Before it can lead to a move it is corroborated by an independent source (the poller's reading), and the move goes through the existing swap authority with brakes. The conformance gate flagged this point; the corroboration step and the brakes are the response. No LLM gate is warranted: the decision is deterministic routing over structured state, and the cross-model reviewer agreed.

## 4b. Judgment-point check

The point with competing signals (pane says it will auto-continue later, in-progress turn, restart cost) is resolved deterministically: a settled wall pane has no turn in progress, and a near reset holds. There is no open-ended judgment left to arbitrate.

## 5. Interactions

- **RateLimitSentinel:** untouched; a wall is still not a throttle. The legacy throttle swap now shares the rescue's dedupe, so a wall and a throttle cannot race into two moves.
- **ProactiveSwapMonitor:** unchanged code. Tagging spawns makes them eligible where an operator enabled it (dark by default). This is Frontloaded Decision 3 in the spec.
- **SessionRefresh:** unchanged; keeps its own restart rate cap and structured refusals, which surface as `failed`.
- **PresenceProxy:** new optional hook; absent → identical behavior. With the hook, wording comes from the same admission as the move.
- **pinSessionsToPool: true:** keeps its existing resolver (drain-first), unchanged.
- **Attention items:** the no-alternate item text is now plain words; same id and dedupe.

## 6. External surfaces

- Users with 2+ accounts: a walled conversation restarts on another account (via `--resume`), and new sessions start on pool accounts. Users with 0/1 accounts: no change.
- New plain notices into the session's conversation, only when it cannot be moved.
- New read-only route `GET /subscription-pool/wall-rescue`.
- Config: new key `subscriptionPool.wallRescue.enabled: true` added to existing configs.

## 6b. Operator-surface quality

No dashboard or approval surface touched — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design (`physical-credential-locality`): logins, the default credential slot and tmux panes live on one machine; a session is detected and moved only by the machine running it. Default-on is applied per machine by its own update and is effective per that machine's pool. Notices go from the machine running the session to that session's topic, so there is one voice per session. No new durable store or URL.

## 8. Rollback cost

Set `subscriptionPool.wallRescue.enabled: false` (read live, no restart). Code rollback is a revert and patch release; the leftover config key has no reader. Sessions already moved or tagged remain on valid accounts. No data migration to undo.

## Conclusion

Ships the operator-approved default-on rescue with corroboration and brakes on the one place it can restart sessions, and fixes the standby misread. Safe to merge after the full suite passes.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (spec rounds 1–6, final code verification, and this artifact)
**Independent read of the artifact: concern, then concur.** The first read found the artifact still described the pre-round-6 handling of default-login sessions and a stale round count. Both were corrected above (corroboration and the reset hold apply to proven identities only; a default-slot candidate is never blamed and is excluded as the target; 6 rounds). The reviewer re-read the corrected artifact and the code and replied: "Concur with the review." Per-round findings: `docs/specs/reports/usage-wall-rescue-convergence.md`.

## Evidence pointers

- `tests/unit/usage-wall-rescue.test.ts` — includes the fb-d2862f4d-b52 regression on a realistic pane (verified to fail without the chrome filter).
- `tests/integration/usage-wall-rescue-spawn.test.ts`, `tests/integration/usage-wall-rescue-route.test.ts`
- `tests/e2e/usage-wall-rescue-lifecycle.test.ts`
- `tests/unit/self-action-convergence.test.ts` — `usage-wall-rescue` registered.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action` (new self-triggered controller that can restart sessions).
- **`closure`:** `guard`
- **`guardEvidence`:** `{enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts (controller id usage-wall-rescue in src/testing/selfActionRegistry.ts), howCaught: under a wall that never clears and moves that always fail, decideRescueGate allows at most 5 moves per session before the 24h breaker, horizon-independent; a successful move resets the budget and the resumed pane no longer matches detectUsageWall (zero session lines after the banner), so the control loop settles.}`
