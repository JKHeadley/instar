---
title: "FrameworkParitySentinel — design spec"
slug: "framework-parity-sentinel"
author: "echo"
status: "converged"
type: "infrastructure-spec"
eli16-overview: "framework-parity-sentinel.eli16.md"
supersedes: "specs/provider-portability/13-framework-parity-sentinel.md"
review-convergence: "2026-05-19T02:10:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T02:10:00Z"
review-report: "docs/specs/reports/framework-parity-sentinel-convergence.md"
review-deviation: "Infrastructure spec — not a Layer-3 primitive. Abbreviated convergence: the sentinel is a thin consumer of the existing rules registry, so most reviewer perspectives (canonical-shape, rendering correctness, drift detection) are absorbed by the per-primitive rules' converged specs. The sentinel's load-bearing decisions (cadence, concurrency, policy gating, event vocabulary) are documented and scoped narrow for v0.1 (building block; HTTP routes + server.ts wiring as follow-up)."
approved: true
approved-by: "Justin (pre-authorized 2026-05-18, autonomous-mode hybrid C)"
approved-date: "2026-05-19"
approval-note: "Pre-authorized after convergence + alignment check. Alignment verified: NOT a Layer-3 primitive (consumer of them); aligns with framework-functional-parity.md (load-bearing consumer of every parity rule); aligns with required-primitives-inventory.md (infrastructure, not in the primitive set); signal-vs-authority compliance (rules + remediationEnabled config own authority, sentinel emits signals); v0.1 building-block scope matches PR #252/#253/#254 precedent."
---

# FrameworkParitySentinel — design spec

## What this is

The **FrameworkParitySentinel** is the consumer of the Layer-3 parity rules registry. It walks the registry on its scan cadence (and on triggers), calls each rule's `verify()` per instance, surfaces drift via events + degradation reports, and (per rule's `remediationPolicy`) optionally calls `remediate()` to re-render canonical into the framework-native shape.

This spec supersedes the earlier proposal at `specs/provider-portability/13-framework-parity-sentinel.md`. The proposal pre-dated the rules-registry architecture; this spec is rewritten to match what actually shipped in Skill / Hook / Memory primitive PRs (#252, #253, #254).

## Architectural context

The Layer-3 functional primitives that have shipped to-date:

| Primitive | Rule | Registry entry | Notes |
|---|---|---|---|
| Skill | `skillParityRule` | yes | full canonical-source + render + verify + remediate + orphan cleanup |
| Hook | `hookParityRule` | yes | v0.1: session-start event only; mechanical extension to other events |
| Memory | `memoryParityRule` | yes | verifier-only; flag-only policy; throwing remediate (Memory sacrosanct) |
| Agent | (deferred) | no | rule pending Codex subagent surface research |
| Tool | (substrate-bound) | no | TOOL_NAME_MAPPING table imported directly by other renderers |

The sentinel reads `listParityRules()` from `src/providers/parity/registry.ts`. New primitives' rules surface automatically when registered.

## Responsibilities

The sentinel is responsible for:

1. **Per-rule, per-instance verification** — for each rule in the registry, for each instance the rule's `listInstances()` returns, call `verify()` and collect mismatches.
2. **Orphan detection** — for each rule, call `listOrphans()` to surface rendered files with no canonical counterpart.
3. **Remediation routing** — per rule's `remediationPolicy`:
   - `mirror-trust`: apply `remediate()` if the agent's trust level allows automated mutation in this scope.
   - `flag-only`: never call `remediate()`. Always surface as a structured alert.
4. **State persistence** — record per-rule scan cursor (`lastScanAt`, `lastSourceMtime`, `lastResult`) in `.instar/state/framework-parity-sentinel.json`.
5. **Event emission** — `parity:gap-found`, `parity:remediated`, `parity:remediation-refused`, `parity:orphan-found`, `parity:scan-complete`.
6. **HTTP surface** — `GET /api/framework-parity/status` (registry × instance state), `POST /api/framework-parity/scan` (force a pass), `POST /api/framework-parity/remediate?rule=<id>&instance=<name>` (explicit scoped remediation).
7. **Degradation reporting** — on persistent unresolved gaps, emit a Degradation entry so it surfaces in the agent's existing monitoring channels.

The sentinel is NOT responsible for:

- Implementing parity rules (that's the rule's job).
- Defining what canonical means for any primitive (that's the spec's job).
- Mutating canonical files (only renderings, only via `remediate()`, only when policy allows).
- Backfill migration (separate one-shot tool for the existing-agent installed base).

## Triggers

Three trigger paths feed the sentinel:

1. **On framework-enable** — when a framework becomes active for an agent (e.g. `instar route` adds Codex), invoke a full scan + remediate pass scoped to that framework's matrix cells.
2. **On source-change** — filesystem watcher on the canonical roots each rule declares (`.instar/skills/`, `.instar/hooks/`, `.instar/AGENT.md`, etc.). When canonical changes, re-render via `remediate()` for the affected instance.
3. **On interval** — every N minutes (default 30), scan rules whose `expectedFrequency` includes interval-only. Catches drift from manual edits to rendered files.

## Staleness model

Per-rule cursor in state file. For each rule × instance, track `lastSourceMtime`. On interval pass:

- `new`: instance not in the cursor map. Always scanned.
- `stale`: current source mtime > recorded `lastSourceMtime`. Scan + maybe remediate.
- `fresh`: current source mtime ≤ `lastSourceMtime`. Skip.

On full-scan (framework-enable or explicit `/scan` POST), every instance is scanned regardless of staleness.

## Trust + safety

- **Remediation policy is per-rule, not per-sentinel.** A rule shipped as `mirror-trust` can be downgraded to `flag-only` via a config override, but never the reverse without an explicit operator action.
- **User-edit-conflict short-circuits.** If `verify()` returns `reasonCode: 'user-edit-conflict'`, the sentinel emits `parity:remediation-refused` with the conflict details and never auto-remediates. The operator must resolve the conflict (either accept the user edit by updating canonical to match, or reject by manually re-rendering with `--force`).
- **Orphan removal is opt-in.** `listOrphans()` always runs; `removeOrphans()` is gated behind a separate config flag (`orphans.autoRemove: true|false`) and never fires on the first pass after a framework change (operator might intentionally have hand-authored renderings during the transition).
- **No-op for Memory.** Memory's `remediationPolicy: 'flag-only'` means the sentinel never calls remediate() on Memory. Verifier output surfaces as a structured degradation pointing at the documented repair procedure.

## v0.1 scope

The first sentinel ship covers:

1. Registry walker (consume `listParityRules()`, iterate, collect verify results).
2. State file persistence (`.instar/state/framework-parity-sentinel.json`, atomic writes).
3. Interval trigger (single setInterval; no chokidar watcher yet).
4. `GET /api/framework-parity/status` + `POST /api/framework-parity/scan` routes.
5. EventEmitter wiring (5 events listed above).
6. Degradation reporter integration.
7. Tests: registry walk produces expected matrix; verify mismatches surface as events; flag-only policy never calls remediate; mirror-trust calls remediate when policy + trust allow; state file round-trips; HTTP routes return the expected shape.

Deferred to v0.2:

- chokidar source-change watcher.
- Per-instance `POST /api/framework-parity/remediate?rule=<id>&instance=<name>` endpoint.
- Trust-level integration for mirror-trust gating (v0.1 hardcodes "allow" pending trust system wiring).
- Backfill migration of existing-agent installed base (separate one-shot tool).

## Alignment with foundational specs

- **`framework-functional-parity.md`**: The sentinel is the load-bearing consumer of every Layer-3 primitive's parity rule. Without it, the rules exist but are never run; with it, the cross-framework drift detection promised by the foundational spec becomes operational.
- **`required-primitives-inventory.md`**: The sentinel is NOT a Layer-3 primitive — it's infrastructure that consumes them. Lives under `src/monitoring/`, not `src/providers/parity/`.
- **`docs/signal-vs-authority.md`**: The sentinel emits signals (`parity:gap-found`); the rules' `remediationPolicy` and the operator's trust level are the authority. The sentinel never decides to mutate; it routes based on declared policy + trust.

## Implementation slice for this PR

1. This concept spec + ELI16.
2. `src/monitoring/FrameworkParitySentinel.ts` — the sentinel class (constructor, scan(), routing, state I/O, event emission).
3. State file schema + atomic writer.
4. Route handlers: `GET /api/framework-parity/status`, `POST /api/framework-parity/scan`.
5. Bootstrap wiring in server.ts (construction + interval start + degradation reporter wire-up).
6. Tests: unit (registry walk, state I/O, policy routing); integration (HTTP routes return expected matrix); e2e (real registry + real canonical roots → real verify results round-trip).
7. NEXT.md + side-effects review + trace.

## Open design points

- **Interval default**: 30 min matches the proposal estimate. Configurable via `.instar/config.json` under `frameworkParity.scanIntervalMs`.
- **Single-machine assumption**: the sentinel runs in the server process; only one instance per machine. Multi-machine drift between cloned agents is out of scope (git-sync handles it).
- **First-scan idempotency**: on cold-start with no state file, every instance is `new` and gets scanned. Acceptable — the operation is bounded by registry size × instances per rule, which is small (order of 10s).
