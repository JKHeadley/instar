---
user_announcement:
  - audience: agent-only
    maturity: experimental
---

## What Changed

Added the **External-Hog Zombie Auto-Kill Sentinel** (CMT-1901) — a background watcher that surfaces sustained EXTERNAL CPU hogs (broad observability) and auto-kills exactly one narrow class: orphaned Electron editor extension-host wrappers (the 2026-07-03 VS Code MongoDB-extension zombie that pinned ~2.2 cores for ~24h). The intelligence decides kill/leave/alert WITHIN a mechanical veto-only safety floor; a kill fires iff `floor_pass && classifier==='kill'` — the model can only ever SPARE a process, never widen the target set. Kill-SAFETY is carried entirely by the deterministic floor (same-uid non-root, orphaned-owner, launchctl-unmanaged, sustained N-window CPU, code-defined allowlist class, a kill-time CPU re-confirm); the model carries EFFECTIVENESS.

Ships **dev-gated DARK on the fleet, watch-only `dryRun` on a development agent** (`monitoring.externalHogSentinel.enabled` OMITTED → `resolveDevAgentGate`; `dryRun:true` is the kill-safety canary). Nothing is killed until a deliberate **PIN-gated arm**. New routes: `GET /external-hog` (status), `POST /external-hog/arm` (PIN-gated — a Bearer token cannot arm a real kill), `POST /external-hog/disarm` (Bearer — the safe direction). New config block `monitoring.externalHogSentinel` (enabled dev-gate-resolved; dryRun + kill-gate knobs via applyDefaults; a dev-gate strip migration for existing agents). Registered in `/guards` (dev-gated), and in the CLAUDE.md agent-awareness template.

## What to Tell Your User

Nothing on the fleet — the feature ships **dark**: every route 503s and it is a strict no-op until deliberately enabled. On an agent where it is live, it is **watch-only**: it observes and reports sustained CPU hogs but kills nothing until the operator arms it with their dashboard PIN — and even armed, only the one narrow orphaned-editor-helper class, never anything else.

## Summary of New Capabilities

- **Observability**: `GET /external-hog` reports sustained external CPU hogs (killed or left-alive) plus the durable arm state and an honest guard posture (`on-stale` when blind, never a false `on-confirmed`).
- **Operator control (dashboard PIN)**: arm the live kill with `POST /external-hog/arm` (PIN-gated; the marker binds the PIN consent to the current allowlist-class content-hashes) and disarm back to watch-only with `POST /external-hog/disarm`. A disarm can never be silently un-done (epoch monotonicity — returning to live-kill needs a fresh PIN arm).

## Evidence

Built across 25 independently-reviewed checkpoints. ~246 external-hog unit/integration tests across 23 modules + a Tier-3 "feature is alive" E2E over the real `AgentServer` (GET 200 with a live status, the arm→disarm→re-arm epoch lifecycle, dark → 503, Bearer + PIN auth). **6 real bugs were caught by mandatory second-pass reviews of kill-adjacent code** (a fail-OPEN floor invariant, a false-HIGH CPU reading, a brake-off breaker, an invisible-hog drop, a non-boolean-laundering gate, and shell-caught deferral tracking) plus 1 self-caught §4.5 kill-time CPU re-confirm gap. Spec: `docs/specs/external-hog-zombie-autokill-sentinel.md` (converged 11 rounds + operator-approved).
