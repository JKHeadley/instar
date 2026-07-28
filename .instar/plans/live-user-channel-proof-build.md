# Build Plan — Live-User-Channel Proof + Multi-Machine Transfer Fix

Spec: `docs/specs/live-user-channel-proof-standard.md` (CONVERGED iter 6, self-approved).
Worktree: `~/.instar/agents/echo/.worktrees/gold-standard-live-testing` (branch
`echo/gold-standard-live-testing` off `JKHeadley/main` v1.3.586).
Tracking: CMT-1568. Autonomous run topic 13481.

## Build order (each its own PR through full gates)

### A. Transfer fix (Task #5) — the real bug, highest value. IN PROGRESS.
Root cause: `SessionOwnershipRegistry` uses `InMemorySessionOwnershipStore` (no
cross-machine replication). Registry is already store-agnostic (`SessionOwnershipStore`
interface read+casWrite). Fix = durable + replicated store, off hot path.

Increments:
1. **`LocalSessionOwnershipStore`** (durable per-session persistence). Mirror
   `src/core/LocalLeaseStore.ts`: file-per-session JSON, atomic tmp+rename, in-memory
   Map cache, fast-forward CAS (`candidate.ownershipEpoch > current`). + unit test.
   → survives restart. ⟵ DOING FIRST.
2. **`OwnershipApplier`** — on each machine, consume REPLICATED peer placement journal
   entries (`peers/<machineId>.topic-placement.jsonl`, already replicated by the journal
   sync) and CAS-materialize the ownership record locally, so the target machine's
   `resolveOwnership` returns owner=self after a transfer. Runs on journal-apply tick
   (OFF hot path). Fenced by leaseEpoch (stale-lease placement discarded). + unit test.
3. **Wire** at `src/commands/server.ts:14612` — swap `InMemorySessionOwnershipStore` →
   `LocalSessionOwnershipStore`; wire the `OwnershipApplier` to the journal sync;
   keep `epochFloorOf` reading freshest journaled epoch. Dev-gated/dark per convention.
4. **False-positive surfacing** (§7.4) — `/pool/transfer` returns explicit
   `seatMoved:false` (not bare `ok:true`) when ownership didn't actually move.
5. **Crash-safety** (§7.3, §9.4) integration test: crash at each step → single-owner
   convergence + contended messages queue (not double-route).
6. Layered tests (unit/integration/e2e), zero-failure suite, side-effects review,
   PR through gates.

### B. Constitution standard (Task #2) — small, operator's explicit ask.
- Add "Live-User-Channel Proof Before Done" to `docs/STANDARDS-REGISTRY.md` (Rule /
  In practice / Earned from / Traces to the goal / Applied through — text in spec §3).
- Agent awareness: `src/scaffold/templates.ts` generateClaudeMd.
- Migration: `PostUpdateMigrator.migrateClaudeMd` / `migrateAgentMdSections` +
  `migrateConfig` for new dark flags. Idempotent, content-sniffed.

### C. User-role harness (Task #4) — the big new build.
Per spec §5: scenario matrix, real-account drive (B-class) via isolated demo channels,
signed artifact + per-machine hash-chained ledger segments, flake mgmt, Tier-1 supervisor
(semantic-only), layered tests incl. "alive" e2e. Reuse `test-as-self` throwaway-home.

### D. Completion gate (Task #3) — depends on C's artifact format.
Per spec §4: deterministic pre-check, block on objective facts only (declared userFacing
+ verified signed artifact), classifier signal-only, risk-category coverage, surface-
specific proof, dark→warn→veto. Hooks `CompletionEvaluator` / `UnjustifiedStopGate`.
Config `monitoring.liveTestGate` in `DEV_GATED_FEATURES`. Layered tests both sides.

### E. Apply standard to multi-machine FIRST (Task #6) — the bar.
Run harness over the transfer through Telegram AND Slack on a throwaway topic; signed
all-PASS artifact; deploy both machines.

## PROGRESS LOG (continuation state)

Branch `echo/gold-standard-live-testing`. Committed so far:
- ✅ Spec CONVERGED (6 rounds, cross-model) + self-approved + report + ELI16 (commit 34e4f3010).
- ✅ A1 durable `LocalSessionOwnershipStore` + 8 unit tests (restart-survival proven) — 91a04b01f.
- ✅ A4 `/pool/transfer` `seatMoved` false-positive surfacing — e60400405. (tsc clean.)
- ✅ B incr-1 constitution standard in STANDARDS-REGISTRY.md — 98f3fba97.

### UPDATE — transfer fix is CODE-COMPLETE + tested (2026-06-15 late)
Committed on branch (af0e9a8e0 + crash-safety): A1 durable store, A2 OwnershipApplier,
A3 wiring (dev-gated `multiMachine.durableOwnership`, registered in DEV_GATED_FEATURES),
A4 seatMoved false-positive, A5 crash-safety. 18 tests green, dark-gate lint clean, tsc
clean, dev-gate wiring test green. NOT "done" until task 6 LIVE proof + deploy.

### UPDATE 2 — foundation COMPLETE (17 commits, 37 tests green)
- ✅ Task 1 spec, Task 2 constitution+migration (DONE), Task 5 transfer fix code-complete (18 tests).
- ✅ §4.4 `LiveTestArtifactStore` — signed, hash-chained per-machine ledger segments,
  canonical-hash anti-hallucination (8 tests). The contract gate+harness share.
- ✅ §4 `LiveTestGate` core veto logic — allow/veto/nudge, surfaces+risk-categories,
  Signal-vs-Authority (hard veto only on declared userFacing+no-artifact), mode ladder (11 tests).

### UPDATE 3 — ALL structural cores built + tested (18 commits, 43 tests green)
- ✅ §4.4 `LiveTestArtifactStore` (8), ✅ §4 `LiveTestGate` (11), ✅ §5 `LiveTestHarness` core (6).
  Harness→artifact→gate end-to-end proven in a unit test with a fake driver.

### UPDATE 4 — gate WIRED LIVE (20 commits, 49 tests). Tasks 1,2,3 DONE; 5 code-complete; 4 core done.
Gate is wired into POST /autonomous/evaluate-completion (dev-gated dry-run), 6 route
wiring-integrity tests green. ALL structural build is done. What's left is EXECUTION:

EXECUTION PHASE (needs real adapters / a live deploy — do with care/fresh context):
1. **Task 4 real ChannelDrivers:** implement `ChannelDriver` (send/awaitReply/isDemoChannel)
   against the real Telegram + Slack adapters (src/messaging/TelegramAdapter, SlackAdapter);
   `awaitReply` = poll the adapter's message history for the agent's reply after the sent id;
   `responderMachineId` from the pool/ownership. Demo channels from config liveTest.demoChannels
   (signed bindings §5.3). Playwright driver for dashboard. ToS-sanctioned modes (§5.4).
2. **Task 6 LIVE proof (THE BAR):** build dist; deploy Laptop+Mini (test-as-self or real);
   enable multiMachine.durableOwnership (dev-gate already live) + restart; run the harness
   over the transfer through Telegram AND Slack on a throwaway topic → assert a reply genuinely
   served FROM the Mini after a Laptop→Mini transfer (seatMoved:true, responderMachine=mini) →
   signed all-PASS artifact. THIS is what the run is judged on.
3. **PR/merge (Task 7):** PR the branch through the full instar-dev gate (husky, decision-audit,
   docs-coverage ≥2, no-silent-fallbacks tags DONE, feature-delivery DONE, eli16 PR body ≥200
   chars under ## ELI16, dark-gate golden map, capability index). Ships DARK (dev-gated) — the
   flag flip to enabled is gated on the live proof. Zero-failure suite + deploy both machines.
   NOTE: green-pr-automerge / native auto-merge = the merge path (gh pr merge --auto --squash).

### (resolved) KEY INTEGRATION DESIGN POINTS — gate wiring DONE; harness/proof remain:
- **Artifact signing key (gate wiring):** the harness SIGNS with, and the gate VERIFIES
  with, an Ed25519 key. FIRST increment (dev dogfood, dry-run, same machine): use the
  MACHINE IDENTITY keypair (MachineIdentity.sign/verify) — harness + gate on the same
  machine share it, no cross-machine key resolution needed. Cross-machine verify (gate on
  machine B verifying machine A's harness artifact → resolve A's pubkey from mesh/identity)
  is a TRACKED FOLLOW-ON, not needed for the dev dogfood. Find the machine privkey in the
  server wiring (grep MachineIdentity / identity keypair in src/commands/server.ts).
- **Gate veto wire point:** `POST /autonomous/evaluate-completion` (routes.ts:4153-4173).
  After `verdict = completionEvaluator.evaluate(...)`, if `verdict.met===true` AND the gate
  is enabled, run `liveTestGate.evaluate({featureId: slug(condition), userFacing: body.userFacing,
  goalText: condition, mode})`; if `.blocks` → override to `{met:false, reason: gate.reason}`.
  dry-run/warn → don't override, include would-block telemetry. Construct
  liveTestGate+store in server.ts gated by resolveDevAgentGate(config.monitoring?.liveTestGate?.enabled),
  register in DEV_GATED_FEATURES, add to routes ctx. + wiring-integrity test + e2e "alive".
- **Real ChannelDrivers (task 4):** implement `ChannelDriver` (send/awaitReply/isDemoChannel)
  against the real Telegram + Slack adapters; demo channels from config `liveTest.demoChannels`
  (signed bindings §5.3). Playwright driver for dashboard. ToS-sanctioned modes (§5.4).
- **Task 6 LIVE proof:** build dist, deploy Laptop+Mini, enable durableOwnership + run the
  harness over the transfer through Telegram AND Slack → signed all-PASS artifact = THE BAR.

### (historical) original remaining list:
- **Task 3 wiring:** hook `LiveTestGate` into the autonomous completion path
  (CompletionEvaluator / UnjustifiedStopGate `U_LEGIT_COMPLETION`) so a user-facing run
  can't resolve "done" without a verified artifact. Config `monitoring.liveTestGate`
  (mode dry-run default; register in DEV_GATED_FEATURES). 3-tier tests incl. e2e "alive".
- **Task 4 harness:** `LiveTestHarness` core = scenario-matrix runner over an INJECTED
  `ChannelDriver` (send/awaitReply/isDemoChannel) → writes the artifact via the store;
  structural guard refuses volatile/permission on a non-demo channel (§5.3); Tier-1
  supervisor for NL-only expects (§5.6); flake mgmt (§5.5). Build the core testable with a
  FAKE driver first, then the REAL Telegram + Slack drivers (demo channels) + Playwright
  dashboard driver. "alive" e2e is the key test.
- **Task 6 LIVE proof (THE BAR):** build dist on this branch, deploy to Laptop + Mini
  (or test-as-self), enable `multiMachine.durableOwnership` (dev-gate already flips it
  live on dev), run a real Laptop↔Mini transfer, confirm a reply genuinely served from
  the Mini + `seatMoved:true`. Ideally via the Task-4 harness; a careful manual live
  test is acceptable as the first proof. THIS is what the run is judged on.
- **Task 2 incr-2 (migration parity):** generateClaudeMd (templates.ts) + PostUpdateMigrator
  .migrateClaudeMd/.migrateAgentMdSections so existing agents get the standard text.
  (No ConfigDefaults `enabled:` line added — golden line-map gate not affected.)
- **Task 4 harness** (big): per spec §5. **Task 3 gate**: per spec §4. Then PR everything
  through gates + zero-failure suite + deploy.

### (historical) original increment list:
1. **A2 `OwnershipApplier`** (the delicate cross-machine heart — do with care/fresh context).
   - READ FIRST: `src/core/CoherenceJournal.ts` (emitPlacement + how peer streams are written),
     and the journal sync applier that writes `peers/<machineId>.topic-placement.jsonl` (grep
     JournalSyncApplier / peer stream reading). Need the exact API to READ replicated peer
     placement entries on the receiving machine.
   - Implement: on a tick (off hot path), read peer placement entries, and for each
     `{topic, owner, epoch}` newer than the local ownership record, CAS-materialize a local
     ownership record (status active, ownerMachineId=owner, ownershipEpoch=epoch) via the
     registry's `cas`/store. Fence: discard a placement whose leaseEpoch is below current
     (stale-lease guard). This is what makes the target machine resolve owner=self after a move.
   - Unit test: peer placement entry → local ownership materialized; stale epoch ignored.
2. **A3 wire** server.ts:14612 swap InMemory→LocalSessionOwnershipStore (dir e.g.
   `.instar/ownership/local/`); construct + tick the OwnershipApplier; keep epochFloorOf.
   Dev-gated/dark per convention.
3. **A5 crash-safety integration test** (§7.3/§9.4): crash at each transfer step →
   single-owner convergence + contended messages queue (not double-route).
4. Then B incr-2 (CLAUDE.md template generateClaudeMd + PostUpdateMigrator.migrateClaudeMd/
   migrateAgentMdSections + migrateConfig for the standard — watch the golden line-map gate),
   then PR the transfer fix + standard through gates (NOT before A2/A3 — the store isn't wired
   yet, so a PR now wouldn't actually fix the transfer).
5. Then Task 4 harness, Task 3 gate, Task 6 live proof.

## Key wiring facts (from grounding)
- Swap point: `src/commands/server.ts:14605-14617`.
- `emitPlacement` wrapper: server.ts:14716-14741; CAS sites: 14748-14751.
- Reconciler emitPlacement wiring: server.ts:14683-14694.
- `SessionOwnershipStore` interface + FSM: `src/core/SessionOwnership.ts`,
  `SessionOwnershipRegistry.ts`. `CoherenceJournal.emitPlacement`: CoherenceJournal.ts:680.
- Lease fencing: `FencedLease.ts` / `LeaseCoordinator` leaseEpoch.
- Tests pattern: `tests/unit/SessionOwnership.test.ts`, `MeshRpc.test.ts`.

## Gate checklist (instar-dev) — clear BEFORE push
husky shim, decision-audit (causalAutopsy in trace JSON), docs-coverage ≥2 CLAUDE.md
mentions per new feature, no-silent-fallbacks tag on new routes, feature-delivery-
completeness, eli16 (PR body ≥200 chars under ## ELI16), dark-gate golden line-map
(recompute on ConfigDefaults edits), capability index for new routes, migration parity.
Self-approve specs (standing pre-approval). Green-PR auto-merge / native auto-merge is
the merge path (`gh pr merge --auto --squash`).

### UPDATE 5 — Zero-Failure verified (21 commits)
Full UNIT suite run: green. The single transient (hook-events-route.test.ts) PASSES IN
ISOLATION (18/18) — a flaky port-binding race under parallel route tests, NOT a regression
(flake-requires-pass-in-isolation rule). All 49 new tests green. tsc + dark-gate lint +
dev-gate wiring + no-silent-fallbacks all clean. The whole structural foundation is
PR-READY (ships dark/dev-gated).

NEXT (execution phase — careful, fresh context):
1. PR the branch through the instar-dev gate. The merge is SAFE deploy: agents auto-update
   to the merged version; durableOwnership (dev-gate) goes live on the dev agents on their
   next restart. PR-body needs ## ELI16 ≥200 chars. Watch husky-shim-in-raw-worktree, CI
   dispatch on push, golden line-map, capability index. Spec tags present (review-convergence
   + approved). Push target: JKHeadley repo, branch echo/gold-standard-live-testing; PR vs
   JKHeadley/main; merge via native auto-merge (gh pr merge --auto --squash, EchoOfDawn).
2. Task 4 real ChannelDrivers (Telegram sendToTopic + read telegram-messages.jsonl /
   getRecentMessages ~line 3520 for the reply; Slack adapter; responderMachine from pool).
3. Task 6 LIVE proof (THE BAR) on a throwaway topic, post auto-update: transfer Laptop↔Mini,
   assert reply served FROM mini (seatMoved:true), signed all-PASS artifact.
