# Side-Effects Review — External-Hog Zombie Auto-Kill Sentinel

Spec: `docs/specs/external-hog-zombie-autokill-sentinel.md` (CMT-1901, converged 11 rounds, approved by operator 2026-07-03).
Build branch: `echo/external-hog-sentinel` off `JKHeadley/main` @ v1.3.748.
Tier: **2** (safety-critical, irreversible action — process kill).

## Phase 1 — Principle check (signal vs authority)

**Does this change involve a decision point?** YES — it gates an irreversible action
(killing an external OS process).

**Compliance:** The design is signal-vs-authority-COMPLIANT and this was the single
most-reviewed axis across 11 rounds. Split of authority:
- The **mechanical safety floor** is a VETO-ONLY hard-invariant guard on an
  irreversible action — the allowed "brittle blocker" class (a hard invariant guarding
  an irreversible action, per `docs/signal-vs-authority.md`). It can only ever BLOCK a
  kill (downgrade to alert); it can never trigger one.
- The **LLM classifier** holds the judgment authority (the smart gate) — kill/leave/
  alert — fed the deterministically-computed facts. Its authority is purely
  SUBTRACTIVE: `kill executes iff floor_pass && classifier === 'kill'`.
- The **observability floor** is a signal producer: every confirmed sustained hog that
  is not killed is surfaced; the model cannot suppress it.

This is the correct shape: brittle deterministic logic produces hard vetoes + signals;
the intelligent full-context gate makes the judgment call. Adding blocking authority to
a brittle check is exactly what the design AVOIDS — the floor never authorizes, only
refuses.

## Phase 2 — Plan (build location + interactions)

- **Build location (re-grounded):** FRESH worktree off `JKHeadley/main` @ **v1.3.748**
  (the agent-home checkout was 243 commits behind — building here would be stale). git
  remote = JKHeadley; per-worktree identity set by `instar worktree create`.
- **Re-grounding against master (all confirmed present):** `resolveOwningSession(pid,
  tree, tmuxPaneMap, maxHops)` (McpProcessReaper.ts:111); `parseProcTimeToSeconds`
  (SessionManager.ts:201) — the load-bearing parser to register in `SCRAPE_PARSERS`;
  `devGatedFeatures.ts` with `credentialRepointing` (the Posture-A precedent) + the
  sibling destructive killers `sessionReaper`/`agentWorktreeReaper`/`mcpProcessReaper`
  (DARK_GATE_EXCLUSIONS); `migrateDevGateTeethStrip` (PostUpdateMigrator.ts:1353,
  "Allowlist is HARDCODED"). `zombie-classify.json` benchmark brought into the branch
  (was not in master).
- **Interactions:** de-conflict with McpProcessReaper + SessionManager (exclude their
  pids from discovery + kill), suppress OrphanProcessReaper's legacy external-report for
  in-lane pids; ride the shared LlmQueue background lane + hostSpawnCap; wire into
  guard-posture + the Guard-Posture Tripwire.
- **Rollback path:** ships dev-gated dark-on-fleet + `dryRun:true` (kills nothing);
  live killing requires the PIN arm route. Back-out = disarm route (writes dryRun:true +
  invalidates the marker) or config `enabled:false`; no data migration; feature removal
  leaves inert leftover state (sampler snapshot, kill ledger, audit log).

## Phase 4 — Side-effects review (per-question)

_(Filled in progressively as slices land; this baseline commit is the spec + benchmark
+ plan artifacts brought into the branch — no runtime `src/` change yet.)_

1. **Over-block:** N/A for the baseline; the runtime design over-blocks toward NOT
   killing (every uncertainty → alert-never-kill), which is the safe direction.
2. **Under-block:** the narrow v1 allowlist deliberately does NOT auto-kill non-exthost
   hogs (they are surfaced, not killed) — an accepted, evidence-gated scope.
3. **Level-of-abstraction fit:** owns its own uid-scoped host-process discovery because
   the existing OrphanProcessReaper is structurally blind to the target class
   (framework-needle pre-filter). Correct layer.
4. **Signal vs authority:** compliant (Phase 1).
5. **Interactions:** de-conflicted (Phase 2).
6. **External surfaces:** new `GET/POST /external-hog*` routes (Bearer/PIN-authed);
   coalesced Telegram notice on the deterministic delivery path; guard-posture row.
7. **Multi-machine posture:** machine-local BY DESIGN (`hardware-bound-resource` — a host
   OS process is bound to one kernel); cross-machine visibility via each machine's own
   `GET /external-hog` + pool-scope `/guards`. Confirmed correct by review.
8. **Rollback cost:** low — disarm route / config flip; no migration.

## Slice log

### Slice 2 — config schema + dev-gate registration
Files: `src/core/types.ts` (the `externalHogSentinel?` interface), `src/config/ConfigDefaults.ts`
(defaults — `enabled` OMITTED, `dryRun: true`, all kill-gate knobs), `src/core/devGatedFeatures.ts`
(DEV_GATED_FEATURES entry with the credentialRepointing-style justification),
`tests/unit/external-hog-sentinel-config.test.ts`.
- **Side effects:** NONE at runtime — this slice adds a DORMANT config block + a registry
  entry. No code consumes it yet, so no behavior changes on any agent. It resolves the
  §7/§8 obligation that `enabled` be omitted (dev-gate) + registered in DEV_GATED_FEATURES
  (the #1001 wiring guarantee — auto-covered by `devGatedFeatures-wiring.test.ts`, 151 pass).
- **Over/under-block:** N/A (no decision logic yet).
- **Signal vs authority:** N/A (config only).
- **Multi-machine:** config is machine-local; the feature's posture is `hardware-bound-resource`.
- **Tests:** 6 focused (dev-gate live/dark, dryRun canary on both, enabled-omitted, all
  defaults, the `maxClassificationsPerScan < hostSpawnCap` invariant) + the 151-test wiring
  suite. Typecheck clean.

## Phase 5 — Second-pass review

REQUIRED (touches "sentinel"/"guard"/kill lifecycle). A dedicated reviewer subagent
audits this artifact once the runtime decision-logic slices (floor, classifier hookup,
kill funnel, arm/disarm) land — the config slice carries no decision logic to audit.
