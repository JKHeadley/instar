---
title: "Latest Codex model defaults"
slug: "latest-codex-model-defaults"
author: "Echo"
parent-principle: "Verify the State, Not Its Symbol"
approved: true
approved-by: "Echo, after reviewing the six-round launch-scope convergence report"
review-convergence: "2026-11-24T02:21:37.374Z"
review-iterations: 6
review-completed-at: "2026-11-24T02:21:37.374Z"
review-report: "docs/specs/reports/latest-codex-model-defaults-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Latest Codex model defaults

## Problem statement

Codex conversations need a default that follows reviewed releases within a selected family. People must be able to keep an exact pin. A supported runtime configuration change must affect the next launch even if the session manager was constructed earlier.

The design applies [Verify the State, Not Its Symbol](../INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md) to config and catalog evidence. The [multi-machine standard](../STANDARDS-REGISTRY.md) applies to the release-provided default and preserved topic pins.

## Proposed design

### A. Launch defaults

Resolve `latest:sol` and `latest:astra` at use time against the Codex entries in the reviewed manifest packaged with Instar. The built-in default is `latest:sol`. Ordering compares numeric major and minor versions within one family and excludes preview and retired entries. The packaged manifest can be cached for the process lifetime. It establishes the supported release list, while installed CLI compatibility and account quota checks still apply at launch. A selector uses the existing older-CLI mapping when the newest release is incompatible, including GPT-6.2 Sol to GPT-6 Sol and GPT-6.2 Astra to GPT-6 Astra. Exact pins retain the existing CLI compatibility behavior. Validation applies to entries supplied by the request. A request containing a selector the installed catalog cannot resolve is refused before either config snapshot changes. A sibling-only edit preserves the untouched selector, including a saved selector that is currently degraded. Resolve the effective selector after applying the config layer. If either the inherited built-in selector or a saved selector cannot resolve, the dashboard, topic profile and both cloud launch paths use the existing built-in balanced model and the agent logs the degraded state. Catalog releases must carry compatibility evidence and extend the existing older-CLI mapping where needed. A missing catalog leaves exact pins usable. No scan result is admitted to the packaged list without normal manifest review.

Explicit caller and topic model choices, including local model bindings, keep precedence. Existing exact framework defaults are treated as pins because older records do not distinguish generated values from deliberate choices. A resolved stale framework pin remains in force and produces a deduplicated agent-side log warning. The topic profile, dashboard and both launch paths read the current runtime config through a getter. The authenticated config API validates the map and the supported Codex selectors, preserves sibling framework pins, and publishes the runtime update only after an atomic disk replacement. The operation updates the receiving machine and reports that scope in its response. The route serializes local writes in one synchronous read, merge, persist and publish section, including requests that also change governor settings. This phase changes the interpretation of the existing machine configuration and makes the packaged default identical on equivalent releases. This config API is a receiving-machine maintenance operation. SessionManager reads the updated config object at launch.

### Delivery scope and rollback

This implementation covers new launches and the existing local configuration boundary. Existing-agent scan migration, agent-wide policy distribution and automatic session switching are tracked in the [continuation design](latest-codex-model-defaults-continuation.md). Restoring an exact local config pin selects that model for future launches subject to the existing launch policies.

## Decision points touched

- Family sorting and source precedence — invariant; basis: enumerable-domain; evidence: Operator settings, reviewed release IDs, and numeric ordering define a closed selection domain.
- Validate and publish local changes — invariant; basis: irreversible-consequence; evidence: An invalid map or failed durable write must leave both the active configuration and its saved copy unchanged.

## Multi-machine posture

The packaged model catalog and built-in selector are unified by release. Topic pins continue through the existing Topic Profile transfer path. The existing machine override remains explicitly machine-scoped and visible to the existing default-model coherence check. Each machine applies its own CLI compatibility and account checks at launch. A conversation can inherit a different model after moving to a machine with a different explicit override. The existing coherence implementation registers the raw `defaultModel.codex-cli` policy in `src/core/machineCoherenceManifest.ts` and prohibits automatic direction for default-model rows in `src/monitoring/machineCoherenceEpisodeManager.ts`. It compares the configured selector or exact pin, independently of the model each local CLI can launch. The maintenance action selects a machine explicitly and keeps the existing write scope. An agent-wide preference would be a separate operation with an authoritative revision, as described in the continuation design.


## Frontloaded Decisions

1. Preserve ambiguous exact framework defaults as pins.
2. Resolve family selection for new launches from the reviewed catalog. Keep network observations informational.
3. Keep the local config update machine-scoped and explicit in the response.
4. Commit a validated local write to disk before publishing it to the running process.

## Verification

Prove launch and HTTP behavior with explicit and inherited selections, old CLI fallback, a runtime update with no restart, and local-model precedence. Verify a missing packaged catalog with both the built-in selector and an explicit pin. Verify sibling pin retention, overlapping local writes and durable-write failure without a runtime change.

## Maturation plan

- **test-agent-live:** Use the authenticated lifecycle harness, a synthetic catalog failure and the older-CLI mapping tests before committing.
- **dev-agent-live:** The release owner verifies the first new unpinned launch, exact pin and scoped override on a development install during normal Local Verify.
- **fleet:** Ships through the normal release once Local Verify passes. Existing exact pins retain priority.
- **graduation criterion:** Verify the actual new launch model, the profile and the coherence advertisement after a successful local edit, and verify a failed edit retains the previous selection.
- **dark-window:** None. The selected scope is a new-launch configuration default and has no session-switch actuator.
- **ladder:** not applicable: launch default ships with the release and adds no rollout flag

## Open questions

*(none)*
