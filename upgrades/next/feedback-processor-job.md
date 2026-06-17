## What Changed

The feedback-factory's clustering/triage pass (`processUnprocessed`) was built and parity-tested but only ever invoked by tests — so reports were ingested into the canonical store and never sorted. This wires it into a real, dev-gated capability per the approved migration spec (`docs/specs/feedback-factory-migration.md`, §191: "the processor job is actually constructed and scheduled, not dead code"):

- New `FeedbackProcessingService` exposing `stats()` (read) and `processNow()` (one clustering pass); it reloads the canonical store from disk at the start of every call so it sees rows the separate-process inbox drainer appended since boot.
- New routes `GET /feedback-factory/stats` (counts) and `POST /feedback-factory/process` (trigger), both `503` when the feature is dark.
- New built-in `supervision: tier1` job `feedback-factory-process` (recurring) that calls the trigger and validates the pass against the post-pass stats; ships `enabled: false` (fleet-dark) and installs for every agent on update.
- Dev-gated via `resolveDevAgentGate(feedbackFactory.processing.enabled)`: live on development agents, dark on the fleet (`enabled` omitted in defaults so the gate decides).

## What to Tell Your User

Nothing changes for fleet agents — this capability ships dark, so its routes stay off and its background job stays disabled until it is deliberately turned on. On a development agent it runs live, so the feedback-processing pipeline gets exercised and matured before any fleet rollout. If you operate the feedback factory and want to turn it on, enable feedback processing in your instar config.

## Summary of New Capabilities

- `GET /feedback-factory/stats` — read-only canonical feedback store counts (total, byStatus, clusters, dispatches, lastWriteAt).
- `POST /feedback-factory/process` — run one clustering/triage pass against the canonical store.
- `feedback-factory-process` job — recurring tier-1 processing pass, dark on the fleet.

## Evidence

- `npx tsc --noEmit` clean; all 16 instar-dev lints clean (incl. `lint-dev-agent-dark-gate`).
- Tests: 14 unit (`tests/unit/feedback-factory/processing-service.test.ts`), 5 integration (`tests/integration/feedback-factory-stats-route.test.ts`), 6 e2e + wiring-integrity (`tests/e2e/feedback-factory-process-lifecycle.test.ts`) — all green.
- Side-effects review: `upgrades/side-effects/feedback-processor-job.md` (second-pass review caught + fixed a stale-boot-store defect; reviewer re-concurred).
