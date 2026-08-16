# Side-Effects Review — Promise Beacon Phase 1 Follow-ups

**Version / slug:** `promise-beacon-followups`
**Date:** `2026-04-19`
**Author:** `echo`
**Second-pass reviewer:** `not required` (follow-ups land the items explicitly deferred in `promise-beacon-phase-1.md`)

## Summary of the change

Lands the six items the Phase 1 side-effects review (`promise-beacon-phase-1.md`, §"Known limitations") explicitly deferred:

1. **`atRisk` non-terminal signal path** — `PromiseBeacon` gains an optional `classifyProgress` callback (Haiku-class verdict). A `stalled` verdict flips the commitment's non-terminal `atRisk` flag, emits a softer-toned heartbeat, and doubles the effective cadence. The classifier is a **signal**. The only auto-promotion to terminal `violated` remains the hard session-epoch mismatch, unchanged from Phase 1.
2. **Boot-cap enforcement** — `PromiseBeacon.start()` keeps the newest `maxActiveBeacons` (default 20, config: `promiseBeacon.maxActiveBeacons`). Overflow is mutated to `beaconSuppressed: true` with `beaconSuppressionReason: 'boot-cap-exceeded'`; status stays `pending` (non-terminal).
3. **`PATCH /commitments/:id`** — new route updating `nextUpdateDueAt`, `softDeadlineAt`, `hardDeadlineAt`, `cadenceMs`, `beaconEnabled`. Routes through `CommitmentTracker.mutate()`. Matches the POST creation validator (if `beaconEnabled` is effective, at least one of the three deadline markers must be effective). Rejects unknown fields (400). 409 on terminal-status commitments. Re-arms the live beacon timer when the effective commitment is still beacon-watched.
4. **Dashboard "Open Promises"** — new top-level Commitments tab. Lists beacon-watched pending + atRisk commitments (id, topic, cadence, heartbeat count, last-heartbeat, deadline markers, state badge) and a "Mark delivered" action wired to `POST /commitments/:id/deliver`. All content goes through `textContent` — XSS-safe, matches the PR Pipeline / Initiatives pattern.
5. **`<active_commitments>` session-start injection** — new `GET /commitments/active-context` endpoint returns a capped (≤20) snippet with a `+N more` footer. `src/templates/hooks/session-start.sh` curls it and injects the block before soul.md surfacing.
6. **PresenceProxy → shared `LlmQueue`** — PresenceProxy accepts an optional `sharedLlmQueue` config field. When wired, all tier LLM calls route through the shared queue on the `interactive` lane, giving PresenceProxy preemption authority over PromiseBeacon's background heartbeats and sharing the daily spend cap end-to-end. When omitted (back-compat for unit tests), the legacy internal queue is used unchanged.

Files touched:
- `src/monitoring/PromiseBeacon.ts` — `classifyProgress` hook, `maxActiveBeacons` cap, cadence doubling under `atRisk`.
- `src/monitoring/PresenceProxy.ts` — optional `sharedLlmQueue` wiring in `callLlm`.
- `src/server/routes.ts` — `PATCH /commitments/:id`, `GET /commitments/active-context`. `active-context` is registered BEFORE `/commitments/:id` so the literal path doesn't hit the :id handler.
- `src/commands/server.ts` — pass `sharedLlmQueue` + `maxActiveBeacons` through to PresenceProxy and PromiseBeacon.
- `src/templates/hooks/session-start.sh` — inject `<active_commitments>` block.
- `dashboard/index.html` — Commitments tab + `loadCommitments()` panel.
- `tests/unit/PromiseBeacon-followups.test.ts` — NEW (3 tests).
- `tests/unit/commitments-patch-route.test.ts` — NEW (6 tests, real express app).
- `tests/integration/PromiseBeacon-atRisk-to-violated.test.ts` — NEW (1 test, full signal→authority lifecycle).

## Decision-point inventory

- `PATCH /commitments/:id` validation — same shape as POST creation (beaconEnabled + topicId + ≥1 deadline marker). Explicit `null` in the body is an **overwrite**; an omitted key is a **preserve** (this is how a caller clears a field). Unknown fields → 400.
- `PATCH` on terminal-status commitments → 409, matches existing `deliver` guard.
- Boot-cap selection — newest-first by `createdAt`. Reduces the chance of silencing a fresh commitment the user just made.
- `classifyProgress` — invoked **inside** the LLM branch only (i.e., when the tmux snapshot has changed and a heartbeat would be generated anyway). It does not add a free-standing LLM call; it's a second enqueue on the `background` lane that the daily-cap / AbortController preemption rules already govern.
- `<active_commitments>` endpoint — opt-out is "no beacon-enabled commitments present" (snippet becomes empty string; the hook silently skips). No auth-only-for-this-route; inherits existing `/commitments` route auth posture.

## 1. Over-block

- **`PATCH` unknown-fields 400** — can a caller accidentally hit this by sending `status` or `version`? Yes, but intentionally. The allowed set is `nextUpdateDueAt`, `softDeadlineAt`, `hardDeadlineAt`, `cadenceMs`, `beaconEnabled`. Any other field is either controlled by the tracker (`status`, `version`, `resolvedAt`) or never mutable post-creation (`topicId`, `type`, `userRequest`, `agentResponse`). Surfacing typos via 400 is correct; silent-ignore would invite "but I set cadence-ms and nothing happened" bug reports.
- **Boot-cap over-suppress** — if the cap is set too low, legitimate beacons get silently suppressed at boot. Mitigation: (a) default is 20 which is 2-3× typical concurrent commitment counts from spec expectations; (b) suppression is NON-terminal, status stays `pending`, and `beaconSuppressionReason` is visible in `GET /commitments`; (c) log line at startup; (d) dashboard Commitments tab renders the suppressed badge + reason.
- **atRisk cadence doubling** — if the classifier is noisy, cadence could stretch past usefulness. Mitigation: `atRisk` is never latched terminally — the next `working` verdict clears it naturally (the flag is set when `atRiskSignal=true` and preserves prev value otherwise). A follow-up could add an explicit clear path; acceptable for Phase 1.

Over-block risk: **low**. All surfaces are non-terminal or have clear error messages.

## 2. Under-block

- **PATCH doesn't guard `beaconEnabled: false → true` on an already-stored commitment without topicId/deadlines** — the effective-field validator (§3) checks both existing-and-new fields, so a PATCH can't sneak a beacon-enable past the Phase 1 POST validator. Covered by `PATCH rejects clearing all deadline markers` test and by the `topicId missing` branch (unreachable in practice because `topicId` is set at record time).
- **Session-start hook fail-open** — if the server is unreachable when the hook runs, `ACTIVE_COMMITMENTS=""`, and the block is silently omitted. This matches the hook's existing fail-open posture (other blocks behave identically). Acceptable: missing-block is less disruptive than a broken session start.
- **Classifier signal isn't persisted to audit** — Phase 1 audit log (`.instar/state/promise-beacon/audit.jsonl`) is spec §P27 but not yet implemented (flagged in Phase 1's "known limitations"). Deferred explicitly in this PR too. The `heartbeat.fired` EventEmitter event carries `atRisk` so downstream observability can subscribe.

Under-block risk: **low**, with one named further follow-up (audit log).

## 3. Level-of-abstraction fit

- `classifyProgress` belongs on `PromiseBeacon` — it's the beacon's decision whether to tag `atRisk`. Keeping this as an injectable callback (not a hard dependency) lets tests run without an Intelligence provider, and lets server.ts wire the real summarizer when `sharedIntelligence` is available.
- `PATCH /commitments/:id` belongs on `CommitmentTracker.mutate()` — single-writer invariant preserved.
- Dashboard panel belongs in the Commitments tab, not under the existing Initiatives tab. Commitments and initiatives are orthogonal concerns (minute-scale vs week-scale); conflating them would force one tab to carry two mental models.
- Session-start hook injection belongs via a server endpoint, not by reading `commitments.json` directly from the shell — the tracker's `getActive()` + cap logic lives where the other readers live.

Level-of-abstraction fit: **right layers**.

## 4. Signal vs authority compliance

- **`classifyProgress` is signal-only**. A `stalled` verdict sets the non-terminal `atRisk` flag, changes tone, and doubles cadence. It NEVER auto-transitions to `violated`. The integration test (`PromiseBeacon-atRisk-to-violated.test.ts`) verifies this in one pass: `stalled` → atRisk (status still `pending`) → session-epoch mismatch (hard corroboration) → `violated`. Spec Round 3 #1 compliance.
- **Boot-cap is non-terminal**. `beaconSuppressed: true` + status `pending`. No commitment is terminally mutated at boot. Spec Round 3 #2 compliance.
- **PATCH is authority** — the caller has the same auth posture as POST creation (the existing `/commitments` route already decides who can mutate). PATCH routes through `CommitmentTracker.mutate()` which preserves the CAS invariant #71 established.
- **Shared LlmQueue preemption** is a resource-contention decision, not a status-change decision. Preempting a background heartbeat only causes a templated fallback emission (spec §-"aborted caller can fall back to a templated response"), never a status mutation.

Compliance: **clean**.

## 5. Interactions

- **PresenceProxy + PromiseBeacon shared queue** — now share (a) per-topic proxy mutex (already from Phase 1) AND (b) daily LLM spend cap + concurrency. PresenceProxy tier messages can abort a PromiseBeacon background heartbeat in flight; the aborted heartbeat emits a templated fallback. No new double-post risk; the ProxyCoordinator already serializes emissions.
- **Boot-cap + PATCH** — a PATCH that re-enables a beacon on a commitment that was `beaconSuppressed: 'boot-cap-exceeded'` does not automatically unsuppress. This is intentional: the cap is a whole-system invariant, so unsuppression should happen explicitly via a tracker-level clear (future follow-up) or via a restart that picks up the new cap value. In practice the dashboard "Mark delivered" on pending commitments brings the active count down, and the next restart re-arms.
- **Session-start hook + compaction-recovery hook** — both inject identity/context at start time. The `<active_commitments>` block is small (≤20 entries × ~100 bytes) so token impact is bounded (<3kB). No interference with the soul.md surfacing that runs after.
- **Dashboard Commitments tab + CommitmentTracker events** — the tab is pull-based (Refresh button + on-tab-activate). No websocket/SSE wiring in this PR; consistent with the Initiatives tab. Follow-up could subscribe to commitment events for live updates.

## 6. Rollback cost

- **Partial revert (just PATCH)** — remove the route block. CommitmentTracker.mutate() stays; no state migration.
- **Partial revert (just classifier)** — remove the `classifyProgress` config path. Existing callers don't wire it, so the code is inert without the hook.
- **Partial revert (just boot-cap)** — remove the overflow block in `start()`. The `maxActiveBeacons` field becomes unused; the flag on any already-suppressed commitment stays (non-terminal, harmless — the next re-evaluation clears `beaconSuppressed`).
- **Partial revert (just PresenceProxy migration)** — delete the `sharedLlmQueue` config branch in `callLlm`. The legacy queue stays in place; all existing tests pass unchanged.
- **Full revert** — revert the PR. No data migrations. Suppressed beacons with `beaconSuppressionReason: 'boot-cap-exceeded'` become orphan flags (non-terminal; tracker ignores an unknown suppression reason).

Rollback cost: **low**. Every change is additive on optional config.

---

## Known limitations / scoped-out pieces

Explicitly NOT in this PR:

- **Audit log (spec §P27)** — `.instar/state/promise-beacon/audit.jsonl` with heartbeat / verdict / atRisk transition records. Deferred from Phase 1; still deferred.
- **`paused` status (spec §"session-restart paused")** — 30-min non-terminal hold on session-UUID mismatch before promoting to `violated`. Not in this PR; still the Phase-1 hard-violation path (immediate on mismatch).
- **Explicit `atRisk` clear endpoint** — the flag is currently only cleared implicitly when `classifyProgress` returns `working` (via the `...prev` + conditional write). A dedicated clear-path (e.g., via PATCH `atRisk: false`) is a follow-up.
- **CommitmentSentinel (Phase 2)** — shadow-mode summarizer that reads sessions and makes unattested signal-only verdicts at a broader scope. Phase 2 scope, not this PR.
- **Live dashboard updates** — the Commitments tab is pull-based (Refresh). SSE subscription is a follow-up.

## Evidence the change works

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/unit/PromiseBeacon.test.ts tests/unit/PromiseBeacon-followups.test.ts tests/unit/commitments-patch-route.test.ts tests/unit/LlmQueue.test.ts tests/unit/ProxyCoordinator.test.ts tests/integration/PromiseBeacon-lifecycle.test.ts tests/integration/PromiseBeacon-atRisk-to-violated.test.ts "tests/unit/presence-proxy"` — 65/65 pass.
- `npx vitest run tests/unit/CommitmentTracker*.test.ts` — 69/69 pass (no regression from the new PATCH route or `atRisk` mutate path).
