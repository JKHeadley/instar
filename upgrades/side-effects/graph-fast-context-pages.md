# Side-Effects Review — fast default multi-page historical-context repair proof (CMT-1637)

**Version / slug:** `graph-fast-context-pages`
**Date:** `2026-11-11`
**Author:** `Echo (Opus implementation delegate)`
**Second-pass reviewer:** `fresh independent Opus session (2026-11-11): CONCUR on the code only; tests and timing were not part of that verdict`

## Summary of the change

Test-only. `tests/integration/conversation-graph-replication-contexts.test.ts` gains a default case that runs the same `exerciseHistoricalContext` ceremony as the opt-in 300-row case with 112 real rows. A new `wideIdentifiers` fixture option makes each row's raw operation/event id 80 characters (the `OP_ID_RE` / `EVENT_ID_RE` maximum) and the idempotency key 200 characters (the `opaque()` maximum). That way the shared materialization context still exceeds the production `GRAPH_CONTEXT_PAGE_BYTES` (128 KiB). New assertions run whenever `minPages >= 2`, so they also apply to the opt-in 300-row case: imported context file bytes > 128 KiB, every served page reports `pages >= 2`, `totalBytes > 128 KiB` and `pages === ceil(totalBytes/128 KiB)`, and indices 0..pages-1 are all served. The 300-row and 4000-row cases stay behind `GRAPH_HISTORICAL_CONTEXT_SCALE_PROOF=1`. The eight-row smoke is unchanged. Fix iteration 1 (section 10) also runs the two members' independent per-row store writes concurrently and adds content-free phase-timing logs. Tier 1, size SMALL, effort low.

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

---

## 9. Evidence update (pre-push measurement 2026-11-12, main merge 2026-11-14)

Section 8 stays as the record of the first checkpoint. This section adds what is known since.

- **First real execution (Studio, focused pre-push config):** the ordinary required pre-push check for head `77b9f38089` ran this file on the Studio (`m_03b30f5b…`) under `vitest.push.config.ts`. 2 passed, 2 skipped (the two opt-in cases, scale flag unset). The new 112-row case took 87.091 s, the eight-row smoke 10.133 s, and the file 97.225 s. The boundary assertions in the new case held on that run. This is NOT the official integration config, NOT the full suite and NOT a Local Verify result. Since 87.091 s > 60 s, the 60 s goal from section 5 was not met. The 180000 ms case timeout was not changed and is not proposed for change.
- **Manual targeted run:** still unexecuted (stopped while queued, exit 143, see section 8). Not counted.
- **Main merge:** `origin/main` at `7ff41d4589` was merged (no rebase, no force). The only conflict was the comment line above the opt-in 300-row case: main's #3090 says "Multi-page proof:" and this branch says "Multi-page proof at 300 rows:". The branch wording was kept. The resolved test file hash is `bdb997424022…`, the exact file the independent review concurred on. This PR changes no `src/` file (`src/` is byte-identical to the merged main `7ff41d4589`), so production bounds, including `GRAPH_CONTEXT_PAGE_BYTES = 128*1024`, are unchanged.
- **Lane budget (as written on 2026-11-14; superseded, see section 10):** the PR stays a draft, with no merge-throughput label, until the official Local Verify run on the updated head reports the new case's pass and the integration lane time, and the lane-budget condition is checked against that. A run on the M5 is not a Studio result.
- **Red hosted checks on the old head `77b9f38`:**
  - *Docs Coverage* failed repo-wide floors (overall 53% < 55%, route 54% < 55%, class 50% < 55%). This test-only change adds no capability, so it cannot cause or fix that.
  - *Unit Tests (node 20, shard 2/4)* failed in `tests/integration/graph-witness-chunks.test.ts:68`, a different file that this change does not touch.
  - Neither is evidence about this change. Both are tracked in the feedback queue. Docs Coverage is `fb-250e9f2d-f17`; the duplicate `fb-a5229e2e-d00` is being folded into it. The witness-chunks failure is related to `fbdcd9168f-dd8`, which records a different (M5) report; whether that ticket covers this hosted node 20 line-68 failure, and what caused it, is not proven, so it stays unresolved. No threshold was lowered. On the merged tree, `node scripts/docs-coverage.mjs --check` still fails only the route floor (54% < 55%), with this PR adding no route.
- **Proportion signal:** Tier 1, test-only plus docs. Effort is high for the size (a manual slot wait, an official-measurement route and a main merge) because of the shared integration lane budget, not because the code changed.

---

## 10. Required-gate failures, fix iteration 1, and the measured phase profile (2026-11-15 UTC)

Sections 8 and 9 stay as written (section 9's measurement date is UTC; its merge and "as written" dates are the local Studio date). This section adds what happened since. Its times are UTC. All runs below are on the Studio under the focused `vitest.push.config.ts`, with `GRAPH_HISTORICAL_CONTEXT_SCALE_PROOF` unset. None of them is the official integration config, the full suite or a Local Verify result.

- **Required pre-push gate failed twice (2026-11-15 00:10:28Z–00:23:07Z, which was 2026-11-14 local; merged head `61341fca65`, test file unchanged from `77b9f38`):**
  - Attempt 1: the 8-row smoke passed in 9.226 s. The 112-row case hit its 180000 ms timeout (183.8 s wall). It had already passed the context-file `> 128 KiB` assertion and printed `{records:112, manifest:130352, sourceReferenceBytes:18816, stageBytes:1216562}`, so the time ran out in the later erasure-audit / restart / signed-peer repair part.
  - The hook's own retry: smoke 24.453 s; the 112-row case timed out again (188.9 s wall) before reaching that log line.
  - Both are real gate failures and the push was rejected (remote stayed `77b9f38`). **Their cause is unknown.** The test code was the same one that ran in 87.091 s at 2026-11-12 02:16Z. The merge brought in other main changes (main v1.3.1784, `7ff41d4589`) but did not change this fixture's algorithm. No phase timing existed then, and the smoke slowing 2.6x within one push run is not an explanation. Nothing here attributes the failures to machine load, to main, or to the code.
- **Fix iteration 1 (test-only; build state fixIterations 1/3, recorded with `playbook-scripts/build-state.py transition fixing`):**
  - In each history row, two pairs of steps on the two members' *separate* source stores now overlap: the origin's `attachPreparation` with the peer's `receive`, and the four member `recordCertificateReceipt` writes (each store still records ack A then ack B in order).
  - Source basis: each store serializes its own calls (`serial()`, `src/core/ConversationGraphReplication.ts`). `persist` stores a `structuredClone`. Origin and peer have separate state directories, locks, journals and leases (`tests/helpers/conversation-graph-runtime.ts`). Witness `acknowledgeCertificate` is a synchronous transaction on witness state only (`src/core/GraphWitnessService.ts`).
  - Every production call still runs once per row. Rows stay strictly sequential, and witness calls keep their order. No assertion, row count, identifier, timeout, page bound, opt-in case or `src/` file changed.
  - Content-free `phase()` timing logs (row count, phase name, phase milliseconds, running total milliseconds) were added.
- **Review:** a fresh independent Opus subagent (separate read-only context) CONCURRED on semantic equivalence. It noted two failure-path-only points, which were left unchanged:
  - If a witness acknowledgment throws synchronously on the second ack, the first ack's two receipt writes are not awaited, which could give an unhandled-rejection message.
  - If one side of the overlapped preparation/receipt pair rejects, the other side keeps running on its own store's queue unawaited, but with no unhandled rejection, because `Promise.all` handles both.

  In both cases the test still fails on the first error, so neither can produce a false pass. They are accepted as known reporting risks.
- **One targeted run of this file with fix iteration 1 (2026-11-15 00:45:39Z–00:47:47Z, normal targeted-lane slot, on top of `61341fca65`):** exit 0, 2 passed, 2 skipped (the 300- and 4000-row opt-in cases). Smoke 8.537 s. **112-row case 109.570 s.** File 118.1 s (Vitest duration 126.49 s). All boundary assertions held: context file > 128 KiB, ≥ 2 pages served, each page `pages ≥ 2`, `totalBytes > 128 KiB`, `pages = ceil(totalBytes/128 KiB)`, every index served. Phase profile:

  | phase | 112 rows | 8 rows |
  |---|---|---|
  | history built and certified | 39.238 s | 2.878 s |
  | erasure, membership change, staging, activation | 12.099 s | 1.128 s |
  | survivor and added-member boot, import, per-record verification | 39.460 s | 2.951 s |
  | restart and signed-peer repair | 18.360 s | 1.536 s |
  | final repaired-record assertions | 0.005 s | 0.002 s |

- **What this does and does not show:**
  - It shows the fixed fixture passes once at 109.6 s with all checks.
  - It does **not** show a speed-up, a regression or a cause. There is no paired baseline: no phase timing exists for the pre-fix code, and the 87.091 s run differs in main base, day and code.
  - The original 60 s goal was missed in every run (87.091 s, then 109.570 s).
- **Acceptance criterion now in force:** the delegated throughput owner replaced the old "integration lane about 27 minutes or less" condition, because the lane's shard count changed. The criterion is now the final official test-file duration: about 87 s is acceptable, and anything that adds minutes is reported to the owner before Ready. The 109.6 s / 118.1 s measurement and the phase table are part of what goes to the owner before any Ready decision. The PR stays a draft with no merge-throughput label. No official Local Verify result exists for any head with this fix.
