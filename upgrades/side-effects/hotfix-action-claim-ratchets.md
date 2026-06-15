# Side-Effects Review — Unbreak main: register #1178's action-claim surfaces in the CI gates

**Version / slug:** `hotfix-action-claim-ratchets`
**Date:** `2026-06-15`
**Author:** `Instar Agent (echo)`
**Tier:** 1 (green-the-build hotfix — two test-allowlist additions + two small no-behavior-change runtime fixes for an already-dark feature)

## Summary of the change

PR #1178 added the action-claim follow-through sentinel (dark by default) but merged with four red tests because it never registered its surfaces in four CI gates: the CLAUDE.md migrator section and migrator hook were unparired (`feature-delivery-completeness`, `migration-parity-hooks`), the `/action-claim` route prefix was unclassified (`capabilities-discoverability`), and its generated hook used a top-level `const _r = require` alias that the `no-bare-require-in-generated-hooks` gate bans. A red `main` blocks every PR via update-branch — this is the literal blocker for the whole open backlog. This change fixes all four fix-forward.

## Decision-point inventory

- `legacyMigratorSections += 'Action-Claim Follow-Through Sentinel'` — accepts the dark/signal-only migrator awareness section as migrator-only (matching the cartographer / "Honest progress messaging" entries).
- `INSTALL_VS_MIGRATE_KNOWN_GAPS += 'action-claim-followthrough.js'` — accepts the dark, dev-first hook as migrator-only-for-now with a "add to installHooks() at fleet rollout" follow-up (matching `free-text-guard.sh` / `skill-usage-telemetry.sh`).
- `INTERNAL_PREFIXES += { prefix: 'action-claim', ... }` — classifies the `/action-claim/observe` ingest route as internal/agent-invisible. This is the `capabilities-discoverability` lint's option (b): the route is a hook→server ingest for a dark sentinel, not an agent-facing capability, so suppression is the correct call (not surfacing it in `/capabilities`).
- `getActionClaimFollowthroughHook` rewrite — moved `fs`/`path` loading to `await import('node:fs')` / `await import('node:path')` inside the async stdin handler; moved the config-read + `enabled` gate inside that handler too. Same behavior (signal-only, always `exit(0)`, dark unless `messaging.actionClaim.enabled`), ESM-host-safe.

## 1. Over-block
None. The two allowlist additions only ADD entries (never tighten). The `INTERNAL_PREFIXES` addition only SUPPRESSES `/action-claim` from `/capabilities` discovery — it cannot reject any request, and the route was never agent-facing. The hook rewrite changes module-loading mechanics only; it cannot reject a legitimate turn (it still always `exit(0)`).

## 2. Under-block
The `INTERNAL_PREFIXES` entry means `/action-claim` will never be surfaced in `/capabilities` — intentional and correct (it is an internal ingest for a dark sentinel; the agent-facing payoff is the silent follow-through commitment, documented in the CLAUDE.md template, not a discoverable endpoint). The migrator-only posture for the section/hook means new agents won't get them until the tracked fleet-rollout follow-up — bounded and intentional (action-claim is dark, so a new agent missing the dark hook is a no-op until the feature is enabled fleet-wide).

## 3. Level-of-abstraction fit
Correct layer for all four. The ratchet allowlists and `INTERNAL_PREFIXES` ARE the designed acceptance surfaces for migrator-only awareness sections, deferred-install hooks, and internal routes — used here exactly as the existing entries do. The hook rewrite uses the blessed ESM-safe pattern already documented in `getHookEventReporterHook` and required by the `no-bare-require` gate. No new mechanism.

## 4. Signal vs authority compliance
Compliant. None of the four fixes adds runtime decision/blocking logic. The two allowlists + `INTERNAL_PREFIXES` are build-time CI classifications. The hook remains strictly signal-only (posts to `/action-claim/observe`, always `exit(0)`, never blocks a turn) — the rewrite preserves that exactly; it only changes how `fs`/`path` are imported.

## 5. Interactions
The two allowlist entries and the `INTERNAL_PREFIXES` entry are independent additions adjacent to existing entries — no ordering/shadowing concerns. The hook rewrite keeps the same observable contract, so the server-side `/action-claim/observe` consumer is unaffected. Verified: all four previously-red tests pass (261/261), the action-claim-referencing `CommitmentTracker-externalKey-dedupe` (3) still passes, and `tsc` is clean.

## 6. External surfaces
The route-prefix classification removes `/action-claim` from `/capabilities` output (it was never meant to be there). The hook rewrite changes the on-disk generated hook content for `action-claim-followthrough.js` — but that hook is migrator-installed, dark by default, and the change is byte-different-but-behavior-identical. No API/schema/message change. Invisible to users and other agents; the intended external effect is `main` CI going green.

## 7. Multi-machine posture (Cross-Machine Coherence)
N/A — build-time CI gates + a machine-local generated hook + an internal same-machine ingest route. No replication / proxy / transfer surface. Machine-agnostic.

## 8. Rollback cost
Trivial: revert the commit (the four gates go red again — the pre-change state). No migration, no runtime state, no data change. The proper forward path for the two deferred-install entries (not a rollback) is the tracked follow-up: add `action-claim-followthrough.js` to `installHooks()` + shadow the section in the template at fleet rollout.
