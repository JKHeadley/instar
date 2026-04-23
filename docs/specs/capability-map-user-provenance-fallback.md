---
slug: capability-map-user-provenance-fallback
review-convergence: converged
approved: true
approved-by: dawn
iterations: 1
---

# Capability Map — User Provenance Fallback

## Problem

`CapabilityMapper.classify()` has five possible provenance values (`instar`, `agent`, `user`, `inherited`, `unknown`) but never assigns `user`. Everything not matched as `instar`/`inherited`/`agent` falls through to `unknown` and shows up in drift reports as "unmapped."

Agents have reported this as a bug: the `capability-map/drift` endpoint lists ~104 agent-local skills, scripts, jobs, and context segments as unmapped even though they're fully functional user-authored capabilities in the agent's own `.claude/` directory. The drift signal becomes noisy and the `userConfigured` count in the summary stays at zero.

Reported clusters:
- `cluster-capability-map-has-104-unmapped-capabilities` (medium, 2 reports)

## Root Cause

All scanners (`scanSkills`, `scanScripts`, `scanJobs`, `scanContextSegments`, `scanHooks` flat/custom, etc.) set `provenance: 'unknown'` as a pre-classify default. `classify()` then checks three rules — builtin manifest, evolution proposal linkage, custom hook directory — and any capability that matches none of them keeps its pre-classify `'unknown'`.

The semantic gap: "not in the shipped bundle and not linked to an evolution proposal" for an agent-local file means "user-authored." That's exactly what the `user` provenance value was added for, but the classifier never reaches the assignment.

## Fix

Add a final fallback in `classify()`: if the capability still carries the initial `'unknown'` provenance after all rules run, assign `'user'`. Preserve any non-`unknown` provenance pre-set by a scanner (e.g. the `hooks/instar/` subdir hardcodes `instar`) so existing behavior doesn't regress.

Also extend `classificationReason` in the persisted manifest to label the new case as `'agent-local config directory'`.

## Approach

Single-file edit in `src/core/CapabilityMapper.ts`:

1. Change the final `return cap;` in `classify()` to conditionally promote `'unknown'` → `'user'`.
2. Extend the `classificationReason` ternary in `persistManifest()` to cover the `'user'` case.

Update the existing drift test `reports unmapped capabilities (unknown provenance)` to assert the new behavior — mystery skill is classified as `user`, not left in `drift.unmapped`.

## Risk

LOW. Purely additive classification — no scanner logic changes, no manifest schema changes, no public API surface changes. Revert cost is a one-liner.

## Out of scope

- Expanding the builtin manifest to cover previously-unmapped stock capabilities. That's a separate, higher-touch change that would churn the persisted manifest across every agent on every upgrade.
- Reclassifying already-persisted `unknown` entries in each agent's `capability-manifest.json` — the next scheduled `refresh()` will re-classify them naturally; no migration needed.

## Approval context

Author: Dawn, `instar-bug-fix` autonomous job (AUT-6010-wo, 2026-04-22).
Retrospective single-iteration convergence per `.claude/grounding/jobs/instar-bug-fix.md` (LOW-risk fallback classification rule, no adapter surface touched). Spec authored alongside the implementation to satisfy the `/instar-dev` pre-commit gate.
