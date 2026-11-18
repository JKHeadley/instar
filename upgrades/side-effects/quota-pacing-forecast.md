# Side-Effects Review — Quota pacing, step 1: reading history and forecast (read-only)

**Version / slug:** `quota-pacing-forecast`
**Date:** `2026-11-17`
**Author:** `Echo`
**Second-pass reviewer:** `not required (no gate, sentinel, guard, watchdog, session-lifecycle or messaging decision; read-only measurement)`

## Summary of the change

Adds a durable history of subscription quota readings (`src/monitoring/QuotaHistoryLedger.ts`), a pure forecast module (`src/monitoring/quotaPacing.ts`) and a read-only route `GET /quota-pacing` with a pool fan-out extracted from queue-pace into a shared helper. `QuotaPoller.pollAccount()` becomes a thin wrapper that records every read outcome, without changing its return value; the snapshot gains two additive flags (`measuredAtSynthesized`, `fableUnknown`). Dev-gated through `resolveDevAgentGate` (on for development agents, off on the fleet), with entries in `devGatedFeatures.ts` and `feature-ladders.json`, a FileClassifier sync exclusion, a CapabilityIndex entry and an awareness file. Tier 2 (spec converged in 3 rounds). Spec: `docs/specs/quota-pacing-forecast.md`.

## Decision-point inventory

No decision-point surface. The forecast and its verdicts are display-only measurements; nothing in this change reads them to block, allow, route, shed, swap or hold anything. The existing quota scheduler, placement, proactive swap and wall rescue are untouched and keep their authority.

- `QuotaPoller.pollAccount` — pass-through — wrapped to record outcomes; return value unchanged.
- `queuePaceRoutes` pool fan-out — pass-through — extracted to a shared helper; behaviour unchanged.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Measurement gaps (what the forecast cannot see) are disclosed as `unknown` / `cannot-tell` with a reason: five-hour lockouts are not modelled (`basis: "weekly window only"`), accounts are summed as equal-sized, usage of a shared account from outside this agent is invisible, and logins without an attested email are left out of runway supply.

---

## 3. Level-of-abstraction fit

Right layer. It is a detector-level measurement (pure arithmetic over readings the poller already takes), feeding nothing yet. It records at the one function every quota read passes through (`pollAccount`), rather than parallel to it, and reuses queue-pace's fan-out instead of writing a second one. A later judgment layer (spec step 5) is the intended consumer and will need its own spec.

---

## 4. Signal vs authority compliance

Complies. It produces signals only and holds no authority. The awareness text tells agents explicitly that it is a forecast, not an instruction, and must not be used to hold, shed or add work.

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic at a competing-signals decision point. The fixed values (display lines 85 and 50, freshness and slope spans, reset tolerance, retention) are classified in the spec's decision table as judgment-candidates with floors that can only yield `unknown`, a disclosed cut, or a display label, and the graduation review as arbiter.

---

## 5. Interactions

- **QuotaPoller:** the wrapper must return exactly what `pollAccount` returned before; the ledger call is try/caught and counted, so a ledger failure cannot change a poll. The two new snapshot flags are additive; `pollOne`'s `rateLimitCleared` and every existing reader ignore them (the Fable `percent: null → 0` coercion is left as is).
- **Account replication:** the two new snapshot flags are stripped in `projectAccountToMeta` before an account's quota crosses machines, because a peer's strict quota validator rejects unknown keys; the replicated projection stays exactly what it was, so older peers are unaffected.
- **State-coherence registry:** the history folder is declared (`coherent-on-demand`, append-only, merged on read over peer HTTP).
- **queue-pace:** the fan-out extraction must be behaviour-neutral; queue-pace's existing tests are the proof.
- **git-sync:** the new folder is excluded, so no merge conflicts across machines.
- **BackupManager:** not included by design (derived telemetry; rebuilds after restore).
- **Wiring location:** the ledger is built in `AgentServer.ts`, as queue-pace is, not in `server.ts`. It attaches after the poller has started, so a read in the first moments after boot is not recorded; the poller's first scheduled pass is 15 minutes after start, so in practice nothing is lost.
- **Atomic rewrites:** compaction and retire moves use `fs.promises.rename` because `SafeFsExecutor` has no rename and only a synchronous atomic write; deletions go through `SafeFsExecutor.safeUnlink`, and the destructive-op lint passes.
- **Timers:** compaction and the retired-file sweep run on an unref'd timer, outside the poll path; no race with the poll because one writer per file serializes appends and rewrites.

---

## 6. External surfaces

- New route `GET /quota-pacing` (owner bearer only; not on phone or team routes). Peers call `?scope=local` over the existing bearer fan-out.
- New files under `.instar/state/quota-history/` and a tick log `logs/quota-pacing.jsonl`.
- Awareness entry reaches every agent's instructions on update; on fleet agents the route answers 503 and the entry says so.
- The `quota-pacing/1` schema is a published interface; changes bump the schema.
- No messages are sent; no external service is called beyond the existing peer fan-out.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface touched (no dashboard, approval page or form). Not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Unified, proxied on read. Each machine keeps the readings it took itself; `GET /quota-pacing` defaults to pool scope and merges every machine's per-login summaries by provider-attested identity, ranking fresh over stale and live over usage-file readings. A machine that does not answer is named in `sources`. The history folder is excluded from git-sync because it is merged live. No notices, so no one-voice gating; no URLs generated; no durable state tied to a topic.

**Status surfaces:** `GET /quota-pacing` (new) reports its own coverage, stale reasons and sources per machine. `/capabilities` gains the CapabilityIndex entry.

---

## 8. Rollback cost

Low. Turning `subscriptionPool.pacing.enabled` off stops all writes and sweeps and makes the route answer 503; no other behaviour depends on it. A code revert removes the route and ledger; the poller wrapper returns to the direct function with no data migration. Leftover history files are inert and can be deleted by hand. No config migration was added, so nothing to undo in config.

---

## Conclusion

Read-only, dev-gated measurement with no decision authority. Clear to ship once the three test tiers and the test-agent rung pass.

---

## Test-agent rung (pre-merge)

A throwaway agent (built from this branch, dev gate on, no messaging, a disabled pool entry) served all three route forms with 200 over 494 rows seeded from the real headley Codex usage files. Evaluated at 2026-11-17 14:20Z the account reads `will-leave-unused` (central 47%, 24-hour slope 0.24 %/h), about 16 hours before its reset; at the later 18:38Z cut the usage files hold no readings (they record only when the account is used) and the forecast correctly says it cannot tell. Fixed-window check, Codex: 0 reset moves beyond 5 minutes in a full cycle of 8,898 readings (jitter within 9 seconds). Claude: no stored reading history exists yet, so its check happens on the development agent. The rung found one wording bug (no placeable account read as "tight"; a start already under the line named the current time as future), fixed with tests in this change.

## Evidence pointers

- Spec and convergence report: `docs/specs/quota-pacing-forecast.md`, `docs/specs/reports/quota-pacing-forecast-convergence.md`.
- Tests: `tests/unit/quota-pacing.test.ts`, `tests/unit/quota-history-ledger.test.ts`, the poller wiring test, `tests/integration/quota-pacing-routes.test.ts`, `tests/e2e/quota-pacing-alive.test.ts`.

## PR3330 route-neighbour repair (2026-11-18)

The forecast mount had been inserted between queue pace and skill learning, breaking the existing source wiring guard (649 characters apart, limit600). Move quota pacing after skill learning instead: distance311. Each router remains mounted once; both use disjoint explicit paths, with no router-wide middleware, so this restores the existing arrangement without changing request handling or tests. No new decisions, over-block/under-block surface, external contract, migration, or cross-machine state. Reverting this three-line reorder fully reverses the repair. Existing route bearer/PIN checks are untouched. Direct red/green source assertions reproduce the old guard failure and confirm the new layout. Full-suite Local Verify remains the merge condition; the separate machine-wedge lifecycle failure needs a rerun before any verdict.

Independent review: parent Echo inspected both route builders and the diff on2026-11-18; concurs that explicit disjoint routes and no router-wide middleware preserve matching and authority. TypeScript noEmit passed; full Local Verify and lifecycle rerun remain pending.
