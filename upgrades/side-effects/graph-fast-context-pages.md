# Side-Effects Review — fast default multi-page historical-context repair proof (CMT-1637)

**Version / slug:** `graph-fast-context-pages`
**Date:** `2026-11-11`
**Author:** `Echo (Opus implementation delegate)`
**Second-pass reviewer:** `fresh independent Opus session (2026-11-11): CONCUR on the code only; tests and timing were not part of that verdict`

## Summary of the change

Test-only. `tests/integration/conversation-graph-replication-contexts.test.ts` gains a default case that runs the same `exerciseHistoricalContext` ceremony as the opt-in 300-row case with 112 real rows. A new `wideIdentifiers` fixture option makes each row's raw operation/event id 80 characters (the `OP_ID_RE` / `EVENT_ID_RE` maximum) and the idempotency key 200 characters (the `opaque()` maximum). That way the shared materialization context still exceeds the production `GRAPH_CONTEXT_PAGE_BYTES` (128 KiB). New assertions run whenever `minPages >= 2`, so they also apply to the opt-in 300-row case: imported context file bytes > 128 KiB, every served page reports `pages >= 2`, `totalBytes > 128 KiB` and `pages === ceil(totalBytes/128 KiB)`, and indices 0..pages-1 are all served. The 300-row and 4000-row cases stay behind `GRAPH_HISTORICAL_CONTEXT_SCALE_PROOF=1`. The eight-row smoke is unchanged. Tier 1, size SMALL, effort low.

## Decision-point inventory

No runtime decision point is added, modified or removed. The test only exercises existing ones (context-capacity refusal, historical-materialization verification, erasure refusal, signed-peer readiness/repair).

---

## 1. Over-block

No block/allow surface — over-block not applicable. The test's own new assertions could fail only if the context did not cross 128 KiB. That would be a fixture-sizing error and would show up loudly, not as a false pass.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Coverage boundary differences from the 300-row case: the context is estimated (not measured) at about 1.15 pages instead of about 2.6, so 2 pages are exercised rather than 3. A bug that shows only on a third or later page (as opposed to any non-first page or the final short page) is still only caught by the opt-in cases. Each row's ids are at the maximum valid length rather than UUID-length. The default smoke case still covers the short-id shape.

---

## 3. Level-of-abstraction fit

The change is fixture sizing inside an existing integration test. It reaches the real page boundary through valid production inputs instead of a page-size mock or a runtime seam. That is the right layer.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

Tests only. No runtime authority, config, endpoint or limit is introduced.

---

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

---

## 5. Interactions

Shares the integration lane with every other file. The aim is to give the lane back a default multi-page proof at a fraction of the 347 s cost of the 300-row case; whether it does is decided by the official Local Verify measurement on the draft PR (CMT-1637), not by this document. The case timeout is 180000 ms, so a run between 60 s and 180 s would still pass; the 60 s goal is checked by reading the measured per-file time, not by the test itself. The test uses the existing private-interface HTTP servers and temp directories with the existing `afterEach` cleanup, so no new shared state is added. It does not change the lane deadline or any design cap on main.

---

## 6. External surfaces

None. No agent-visible behaviour, no CLAUDE.md template or migration change, no network beyond the existing local test servers.

---

## 6b. Cross-machine posture

The test builds separate real logical machine identities, each with its own state directory, signing keys and private-interface HTTP server, and they talk over signed HTTP. All of them run on ONE physical test host. This exercises the real multi-member protocol (signing, staging, witness activation, import, signed-peer repair), but it is not a physical cross-machine or fleet proof. The test's temp directories and artifacts are machine-local by design and are removed by the existing `afterEach` cleanup. The change ships no persistent state, no new replication path, no user notices, no URLs, no authority and no config defaults, so nothing differs between machines once installed. When the official Local Verify run reports timing, it must name the machine that actually ran it; a run on the M5 must not be described as a Studio result. This is test coverage of existing behaviour, not a Threadline Witness or first-contact implementation.

---

## 6c. Installed awareness and migration parity

No new running-agent capability, endpoint, CLAUDE.md template section, config default, hook script or built-in skill is added or changed. Installed agents run nothing new, so `generateClaudeMd()` and the `PostUpdateMigrator` paths (settings, config, CLAUDE.md, hooks, skills) need no update: scaffold and migration changes do not apply. The release note uses the internal-only marker for the same reason.

---

## 7. Rollback cost

Revert the test-file diff and the three documents. No data, config or migration to undo. Rollback removes the new 112-row default case and returns the default run to the eight-row single-page smoke only; the 300-row case stays opt-in. So a revert loses default multi-page coverage again. It does not restore full multi-page coverage by default.

---

## 8. Evidence and honesty (initial draft checkpoint, 2026-11-11)

These notes record the evidence at the initial draft checkpoint. They stay accurate as history after later gates run; the official run's results live in its own record.

- Ordinary `npm run build`: exit 0 (2026-11-12 01:31:17–01:31:27 UTC). The four frozen file hashes were the same before and after, and git status did not change. The native verification session for it finished successfully in 3 turns.
- A separate, narrow typecheck used a custom tsconfig that extends the repo `tsconfig.json` and includes only this test file. It is NOT the normal build, and it did NOT pass: it reported 4 errors, the same 4 as the unmodified file at `bbfd1b1f1` (ConflictStore/ScopeVerifier argument shapes and an implicit-any `packet`). The edit adds no new errors. Vitest does not typecheck.
- Fresh independent Opus review: completed successfully in 13 turns, verdict CONCUR on the code only. It checked the wide ids against `OP_ID_RE`, `EVENT_ID_RE` and `opaque()`, and the page-observer wrapper. It did not run the test.
- The original implementation helper and its follow-up both stopped at their turn caps (`error_max_turns`, 29 and 7 turns). Their partial output was checked by the review; they are not counted as completed passes.
- One manual targeted run of this test file (scale flag unset) waited about 17.7 minutes for a suite-lane slot held by another Local Verify run. At 01:44:47 UTC the primary session checked that the process was its own and still queued, then stopped it with SIGTERM, following the delegated owner's recommendation (option 2: measure on the official run instead). Exit 143. No case ran, so there are no counts, no timing and no assertion failure. The executor did not know who sent the signal; the primary's cancellation record shows it was this planned change of route, not a watchdog. It was not re-run by hand.
- Plan at this checkpoint: a normal draft PR against main with the opt-in parent change (#3090) and the new 112-row default case, without the merge-throughput label. The official Local Verify unit, integration and E2E run must show the actual case passes, its per-file time and the machine (CMT-1637). CMT-1637 closes only after merge with that passing run.
- The size figure (about 1347 bytes per row, 112 rows ≈ 151 KB plus fixed activation/lease bytes) is an estimate from the entry shape, not observed. The new file-size assertion is what proves it.
- Under 60 s on the Studio is a goal, not a result. Nothing here claims the test passed, is fast, or has shipped.
- Scope: this is not first-contact or Threadline Witness work. It grants no authority and changes no config. The 300/4000-row opt-in cases and the production 128 KiB page bound are unchanged.
