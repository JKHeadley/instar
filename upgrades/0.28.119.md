# Upgrade Guide — v1.0.5

<!-- bump: patch -->

## What Changed

Lands the FrameworkParitySentinel — the class that walks the Layer-3 parity rules registry (Skill / Hook / Memory), runs each rule's verify() per instance, and routes drift to events (or to remediation, per the rule's declared policy).

v0.1 ships the sentinel as a building block — class + 12 unit tests. HTTP routes (GET /api/framework-parity/status, POST /api/framework-parity/scan) and server.ts boot integration are deferred to a focused follow-up PR. This matches the precedent set by Skill / Hook / Memory parity rules: each shipped as a registry building block first, with operational wiring as a separate step.

Key safety locks: per-rule remediationPolicy is the authority (flag-only never auto-remediates; mirror-trust does); the sentinel-level remediationEnabled config can DOWNGRADE mirror-trust to flag-only but never UPGRADE flag-only. Memory's sacrosanct status is preserved unconditionally. Concurrent scan calls short-circuit to prevent pileup. User-edit-conflict refuses remediation and emits a structured event.

Five new events: parity:gap-found, parity:remediated, parity:remediation-refused, parity:orphan-found, parity:scan-complete. Persistent state at .instar/state/framework-parity-sentinel.json with per (primitive × instance) cursors.

Spec at specs/instar-foundations/framework-parity-sentinel.md (converged + approved). ELI16 companion + convergence report alongside. Original 2026-05-18 proposal at specs/provider-portability/13-framework-parity-sentinel.md is now superseded — left in place for historical reference, frontmatter unchanged.

## What to Tell Your User

- "The piece that runs the cross-framework drift checks is now built. It walks the parity rules every 30 minutes (when wired into the server, coming next), spots when your canonical files have drifted from their rendered forms on Claude or Codex, and either re-renders or flags the drift for you — based on the rule's safety policy."
- "Memory stays sacrosanct: the sentinel will never auto-regenerate your AGENT.md, USER.md, or MEMORY.md. If they're corrupted, you get a structured alert pointing at the repair procedure."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| FrameworkParitySentinel class | Import from src/monitoring/FrameworkParitySentinel.js. Construct with projectRoot + stateDir + enabledFrameworks. Call scan() for one pass or start() for interval mode. |
| Per-instance scan cursors | sentinel.getStatus() returns the per (primitive × instance) cursor state — used by the upcoming HTTP route. |
| Five EventEmitter events | parity:gap-found, parity:remediated, parity:remediation-refused, parity:orphan-found, parity:scan-complete. |

## Deferred (Tracked Follow-ups)

- HTTP routes (GET /api/framework-parity/status, POST /api/framework-parity/scan).
- server.ts boot integration (construction + start + RouteContext wiring).
- Integration + E2E tests (land with the HTTP wiring).
- chokidar source-change watcher (v0.2).
- Per-instance POST /api/framework-parity/remediate route (v0.2 — pending trust integration).
- Conversational-action layer wiring (Step 6 of the rollout).
