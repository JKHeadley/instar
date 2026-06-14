# Side-Effects Review — Green-PR Auto-Merge Enforcement (Phase 7 becomes machinery)

**Version / slug:** `green-pr-automerge-enforcement`
**Date:** `2026-06-12`
**Author:** `echo`
**Second-pass reviewer:** `green-pr-automerge-secondpass subagent (high-risk: merge authority + gate + watcher)`

## Summary of the change

A background watcher (`GreenPrAutoMerger`) that merges a green, mergeable, non-held PR
this agent authored — so the merge survives session death (the prose "Phase 7" rule died
with the session that read it; this is machinery). It rides on a hardened
`scripts/safe-merge.mjs` (the act-time re-verifier), a pool-visible kill-switch
(`GuardLatchStore` on a new replicated `guard-latch` coherence-journal kind), a per-PR
failure ladder + circuit breaker, an identity contract, a floor-drift canary, and a Layer-2
session-exit nudge. Off fleet-wide (`DARK_GATE_EXCLUSIONS: deliberate-fleet-default`),
flipped on per dev agent with `expectedGhLogin`, repo-gated to an instar checkout with
`scripts/safe-merge.mjs` present. Spec: `docs/specs/green-pr-automerge-enforcement.md`
(converged round 7, approved). New modules: `src/monitoring/{GreenPrAutoMerger,MergeRunner,
GuardLatchStore,greenPrLogic,floorDriftCanary,greenPrAutomergeWiring}.ts`; `guard-latch` kind
in `CoherenceJournal.ts` + `JournalSyncApplier.ts`; Layer-2 helpers in `stopGate.ts`; six
routes in `routes.ts`; boot wiring in `commands/server.ts`; config/registry/migration in
`ConfigDefaults.ts`, `devGatedFeatures.ts`, `guardManifest.ts`, `PostUpdateMigrator.ts`,
`types.ts`.

## Decision-point inventory

- `GreenPrAutoMerger.tick` candidate gate — **add** — decides which PRs are merge-eligible
  (namespace + hold + mergeable + settled-green + protected-paths). Fail-toward-skip.
- `GuardLatchStore.isMergeAllowed` (dual-latch gate) — **add** — rollback + emergency-pause
  must BOTH be open; unreadable peers → arrive-disabled.
- `safe-merge` required-contexts cross-check — **add** — producer-bound floor; refuses on any
  unverifiable/missing/wrong-producer context.
- Layer-2 `greenPrBlock` (stop-gate hot path) — **add** — blocks a session ending with a
  green unmerged PR on its branch, ONCE, mode-independently. No runnable command in any variant.
- The existing stop-gate router hook — **modify** — gains a mode-independent greenPrBlock
  branch before the `mode === 'off'` early return (always-overwritten by migrateHooks).

## Over-block — legitimate inputs this rejects that it shouldn't

- A genuinely-green PR whose required-contexts cannot be FETCHED (gh/API hiccup) is refused
  (`refused:contexts-unverifiable`) rather than merged. Intended: fail-toward-skip. The PR
  stays open; the next tick retries; the hold-age backstop surfaces it if it rots.
- A PR whose CI floor was renamed out-of-band is refused until the floor-drift canary names
  the drift. Intended over-block (a drifted floor must not be merged around).
- A PR touching protected paths is never auto-merged even when green — routed to the operator.
  Intended (those PRs can mint hollow floor contexts; human eyes required).

## Under-block — failure modes this still misses

- **Stale-base merges (Decision 9, ratified):** `--admin` bypasses the up-to-date-branch
  requirement, so a PR tested against an older `main` can merge an untested integration.
  Bounded: textual conflicts never merge (`mergeable == MERGEABLE`), `main` re-runs full CI
  after every merge (Zero-Failure makes breakage owned + the audit names the merge), and this
  relocates the EXISTING manual-merge residual unchanged. A strict-base-freshness mode is on
  the fleet-promotion checklist.
- **Branch namespace is a filter, not provenance (Decision 8):** anyone holding the shared gh
  credential can name a branch `echo/…`; the floor's producer-bound CI contexts are what make
  a candidate "pre-approved by construction."
- **Multi-machine peer-latch READ is single-machine in this PR:** `readPeerLatches: () => []`.
  Outbound replication (the journal emit) works; the merged peer READ surface is a follow-up.
  Honest consequence: on a multi-machine pool a rollback set on machine A replicates outbound
  but machine B does not yet MERGE A's latch into its gate. The durable local file is the
  authoritative gate per-machine, and the lease serializes the ACT — so two machines never
  both merge — but a cross-machine STOP is not yet honored on the non-originating holder. This
  is disclosed; the dev agent runs effectively single-machine for merge authority today.

## Level-of-abstraction fit

Correct layer: a monitoring watcher (the ReleaseReadinessSentinel precedent) that drives the
blessed `safe-merge` wrapper. The watcher holds NO independent merge path and never trusts
safe-merge's exit code (independent `gh pr view` confirm, B10). The kill-switch rides the
existing coherence-journal replication + fenced lease (no new distributed primitive).

## Signal vs authority compliance

The watcher is Tier-0: the ONLY discretionary classification is hold/candidate status, and its
failure direction is fail-toward-skip (audited), never fail-toward-merge. Everything that
decides "is this change good" already happened upstream (spec process + gates + CI); safe-merge
re-verifies at act time. The Layer-2 `greenPrBlock` blocks ONCE on objective replicated state
(green candidate + exact branch match + staleness gate + armed gate) and fails open on every
error — it does not repeat the brittle-substring-with-blocking-authority pattern of the
stated-continuation guard it sits beside (that foundation tension is recorded in the spec, not
inherited).

## Interactions

- Shares the stop-gate hot-path response with the UnjustifiedStopGate; greenPrBlock is computed
  LAZILY (only when the snapshot has candidates) and is mode-independent, so it does not depend
  on the UnjustifiedStopGate mode (which ships `off`).
- Adds a journal kind: the `guard-latch` kind is closed-schema in both the writer
  (`CoherenceJournal`) and the receiver (`JournalSyncApplier`) — a peer's forged guard-latch
  entry is schema-rejected like any other kind.
- One aggregated attention item with a machine-stable id (`green-pr-automerge:aggregate`) — does
  NOT create per-PR topics (the notification-flood burst-invariant bound).

## External surfaces

- Merges PRs on GitHub (the one durable external side-effect — ratified at the approval gate;
  the operator-token admin merge already happened manually via the same script since June 9).
- Six new HTTP routes (`/green-pr-automerge*`); `/enable` + `/pool-disarm` are dashboard-PIN
  gated (operator authority), `/rollback` + `/hold` + `/tick` are Bearer.
- Reporter hook payload gains `cwd` (always-overwritten template; free fleet-wide).

## Multi-machine posture (Cross-Machine Coherence)

| Surface | Posture | Why |
|---|---|---|
| `state/green-pr-automerge.json` | machine-local BY DESIGN | attempt ledger; the ACT is lease-serialized |
| `state/green-pr-automerge-latches.json` | machine-local authoritative + journal-replicated | durable STOP survives restart; emit replicates outbound |
| `guard-latch` journal kind | pool-replicated (outbound) | a STOP/marker propagates to peers |
| peer-latch READ (merged gate) | single-machine in this PR (follow-up) | disclosed under-block above |
| Layer-2 snapshot | machine-local (holder only) | sessions on a non-holder get no belt; Layer 1 on the holder is the guarantee |
| Aggregated attention id | machine-stable | lease makes dual-raise impractical; stable id makes it harmless |

## Rollback cost

- Runtime: `POST /green-pr-automerge/rollback` (Bearer, anyone can STOP) disarms instantly;
  `dryRun: true` and `enabled: false` are config levers. Fleet default is off regardless.
- Code: revert the PR. No data migration — the new state files are additive and machine-local;
  the new `guard-latch` journal kind is additive (readers ignore unknown kinds). The hook
  template changes are always-overwritten, so a revert restores the prior templates on the next
  migration.

## Tests

- Unit (123 new): safe-merge hardening (27), guard-latch store (13), pure logic (31),
  orchestrator (14), merge runner (12), floor-drift (9), Layer-2 helpers (11), + the journal
  suites pass with the new kind (35).
- Integration (6): the routes over the real HTTP pipeline — 503 unwired → 200 wired
  (feature-alive), rollback gate closing, PIN gating, the warm-up→merge tick flow.
- Honest gap vs the spec's full test list: a real-AgentServer-boot E2E and a dedicated
  chaos-interleaving integration test are NOT in this PR — the route-level integration proves
  the feature is alive through the real `createRoutes` pipeline, and the restart/orphan and
  latch-partition paths are covered at the unit tier (MergeRunner orphan reap; GuardLatchStore
  absorbing/unreadable). Flagged for a follow-up E2E hardening pass.

## Second-pass review

**Verdict: CONCUR.** An independent reviewer audited the artifact against the code (safe-merge,
GreenPrAutoMerger, GuardLatchStore, MergeRunner, stopGate, the boot wiring), adversarially
hunting for a path to an unintended merge. Findings:
- No path to an unintended merge. The act path is gated in strict order every tick
  (lease → single-flight → dual-latch gate → breaker → warm-up → candidate → identity →
  contract probe → live re-fetch → spawn); safe-merge is the independent act-time authority and
  refuses on red/missing-e2e/wrong-producer-floor/head-moved/unverifiable. The empty-rollup edge
  (`statusCheckRollup:[]` passing the cheap list filter) is caught and refused at act time by
  safe-merge — the non-authoritative filter never causes a merge.
- Fail direction is fail-toward-SKIP on every traced path (candidate, protected-paths-unverifiable,
  identity unconfigured/unresolved/mismatch, gather/runner exceptions, every safe-merge error exit).
- Identity contract enforced before acting (default `expectedGhLogin:''` → skip every act).
- Dual-latch read every tick; unreadable peers arrive-disabled; rollback Bearer, re-arm PIN-gated.
- B10 independent confirmation at both safe-merge and the watcher.
- Layer-2 is signal-not-authority, fails open, no variant emits a runnable command.
- Wiring integrity confirmed (repo-gate → 503; real deps; same latch instance backs act + Layer 2).
- Two non-blocking observations, both fail-safe: the Layer-2 hot path hardcoded `tickIntervalMs`
  (FIXED — now read from config) and a rollback landing mid-spawned-attempt does not abort that one
  bounded attempt (disclosed; lease + single-flight bound it to one).

## CI hardening (registry + ratchet parity)

Full-suite triage surfaced four registry/parity gates, all addressed: the new `guard-latch`
journal kind updated the `CoherenceJournal.getOwnAdvert` test enumeration; the six routes were
registered in `CapabilityIndex` (`/capabilities` discoverability); the migrator CLAUDE.md section
was tracked in the feature-delivery-completeness parity test (migrator-only, like Release
Readiness); and the ~20 new fail-toward-skip `catch` blocks were annotated `@silent-fallback-ok`
(with the dead `isFile` probe in `resolveBranchFromCwd` removed) so the no-silent-fallbacks ratchet
stays at its baseline. Three other full-suite reds were confirmed NOT from this change
(sharedStateRoutes passes in isolation — cross-talk; sign-instar-lockfile + the npm-pack
packageTemplateShape fail on local signing-key / `proper-lockfile` resolution; two e2e narratives
are pre-existing). CI's clean room is the authority.
