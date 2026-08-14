# Side-Effects Review — alias-aware wiring invariant + the two hidden construction sites

**Version / slug:** `parallel-index-alias-aware`
**Date:** `2026-08-14`
**Author:** `Echo (instar agent)`
**Second-pass reviewer:** `peer audit by instar-codey (optional-dep-default-audit, 2026-08-14) — this change originates from its finding`

## Summary of the change

PR #1871 added `tests/unit/parallel-activity-index-wiring.test.ts`, asserting every `new ParallelActivityIndex(` in `src/` supplies `isRunning`. It scanned for the LITERAL class name and therefore missed two sites that bind the class under an alias:

```ts
const { ParallelActivityIndex: AHParallelActivityIndex } = await import(...)  // server.ts:14893
const ahActivityIndex = new AHParallelActivityIndex({ stateDir });            // :14896 — no isRunning
const { ParallelActivityIndex: SOActivityIndex } = await import(...)          // :15630
const soActivityIndex = new SOActivityIndex({ stateDir });                    // :15631 — no isRunning
```

The invariant PASSED in CI against a tree containing both. This change makes it resolve every local binding of the class before scanning, and wires `isRunning` at both sites. Found by `instar-codey`'s optional-dependency audit, which resolved the class through the TypeScript checker instead of matching its name as text.

## Decision-point inventory

No decision point is added or removed. One is **repaired at two further sites**: "does this topic have a live session?" The `SOActivityIndex` instance feeds `SeamlessOrchestratorEngine.reads.activeTopicsOnThisMachine`, which maps `running: a.running` — so that read could never report an active topic. The `AHParallelActivityIndex` instance consumes only `topicId`/`focus` today; wiring it is prophylactic, stated as such.

## 1. Over-block

Could a topic now be reported running when it is not? Only if the resolver mis-places a session; `runningTopicIds` counts only finite registry results, pinned by tests from PR #1870. The orchestrator is dryRun-first by config (`soDryRun = soCfg.dryRun !== false`), so even a wrong `true` changes a hint, not an action.

## 2. Under-block

The previous behaviour WAS the under-report at both sites. Residual: a live session whose topic the messaging registry cannot resolve stays false — correct, since no conversation is bound to it.

## 3. Level-of-abstraction fit

The wiring belongs at each construction site (only the bootstrap knows the resolver). The invariant belongs in a source-reading test, because an omitted constructor argument is not observable from behaviour — the default and the true answer are the same value. The alias resolution belongs inside that test's extractor, since the blindness was in HOW it identified the class, not in what it asserted.

## 4. Signal vs authority compliance

**Signal only.** `SeamlessOrchestratorEngine` is dryRun-first and the work-queue urgency is advisory. Nothing here gates, spawns, kills, or routes; no exit code, route, or authority changes.

## 4b. Judgment-point check (Judgment Within Floors standard)

None introduced. A registry lookup plus `Number.isFinite`; the test performs string/paren analysis. No heuristic, model call, or threshold.

## 5. Interactions

Blast radius measured: `runningTopicIds` gains two importers, both in `src/commands/server.ts`, joining `AgentServer.ts` and the two tests. The `ParallelActivityIndex` constructor signature is unchanged. All four `src/` construction sites now supply `isRunning`; the invariant enforces it under any local name.

## 6. External surfaces

None. No network call, new file at runtime, persisted state, credential, telemetry, or route.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new operator-visible text. The invariant's failure names the offending file, unchanged.

## 7. Multi-machine posture (Cross-Machine Coherence)

`SeamlessOrchestratorEngine` reasons about placement across machines, so a permanently-false `activeTopicsOnThisMachine` was a cross-machine coherence defect specifically. Correcting it makes the orchestrator's own input truthful; it remains dryRun-first and gates nothing.

## 8. Rollback cost

Very low. One source file, one test file, one commit; no migration, persisted state, config flag, or signature change.

## Conclusion

Ship. It repairs a guard that was blind in the same way as the defect it guards, closes the two construction sites that blindness hid, and the more consequential of the two feeds the placement orchestrator.

## Second-pass review

**This change IS the second pass**, performed by a peer agent rather than by me. `instar-codey`'s `optional-dep-default-audit` (tree `codey-audit-readonly`, commit `7e50a3f82`) reported 9 confirmed-unwired optional-dependency surfaces; item 1 is this one, and its "Positive Control" section states plainly that `ParallelActivityIndex.isRunning` "does **not** come back ALL-WIRED if 'every construction site in src/' is applied literally." I verified both sites in source myself before acting.

## Evidence pointers

- The blindness is demonstrated, not argued: on the pre-change tree the existing invariant passes **4/4** while two unwired aliased sites exist. After making it alias-aware it FAILS, naming `commands/server.ts` twice. After wiring, **5/5**.
- Consumption verified in source: `activeTopicsOnThisMachine: () => soActivityIndex.activities(Date.now()).map((a) => ({ ..., running: a.running }))`.
- A new test constructs the class under a renamed import and asserts the extractor finds it — it fails against the previous extractor.
- `tsc --noEmit` exit 0; 10/10 across the wiring suite and the no-silent-fallbacks ratchet (both new catches carry `@silent-fallback-ok` with reasons; the baseline is NOT raised).

## Class-Closure Declaration (display-only mirror)

Class: "a structural check that identifies its target by name and is therefore blind to renaming." Closed for this invariant only. **It is NOT closed generally** — other source-reading lints in this repo may match identifiers as text and were not audited here. Codey's audit also lists 8 further confirmed-unwired optional dependencies (`nicknameFor`, `purposeFor`, `ConversationRegistry.isJournalFsyncDisabled`, `ActiveWorkSilenceSentinel.isCleanIdlePrompt`, `TelemetryHeartbeat.agentCountFn`, `SessionManager.spawnAccountResolver`, `WriteAdmission.nicknameOf`/`selfNickname`) which this change does NOT address.
