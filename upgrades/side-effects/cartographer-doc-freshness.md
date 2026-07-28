# Side-Effects Review — Cartographer Doc-Freshness sweep (spec #2, Tier 2)

**Version / slug:** `cartographer-doc-freshness`
**Date:** `2026-06-10`
**Author:** `Echo`
**Spec:** `docs/specs/CARTOGRAPHER-DOC-FRESHNESS.md` (converged 4 iterations, approved)
**Second-pass reviewer:** `not required — single-author build; convergence (4 rounds) covered the adversarial direction; this review covers the seven dimensions on the as-built code`

## Summary of the change

Adds the three-tier doc-freshness enforcement on top of spec #1's `CartographerTree`:
(1) a Tier-1 inline write route `POST /cartographer/node/refresh`; (2) a Tier-2
in-process `CartographerSweepPoller` + reusable `CartographerSweepEngine` that
authors stale/never-authored node summaries on a LIGHT model routed OFF Claude;
(3) a Tier-3 CI ratchet (`scripts/cartographer-freshness.mjs`). All ship dark
behind `cartographer.freshnessSweep.enabled` AND `egressAcknowledged`.

Two changes touch EXISTING critical code and carry the most risk; the rest is new
files behind a dark gate.

## Files touched

- `src/core/CartographerTree.ts` — ADD spec-#2-owned node fields + helper methods (`committedContent`, `patchNodeMeta`, `freshnessHealth`, public oid accessors). Spec #1 behavior unchanged (additive fields, preserved across `scaffold()`).
- `src/core/IntelligenceRouter.ts` — ADD a `defaultFramework` getter (read-only, additive).
- `src/commands/server.ts` — EXTRACT the reaper's inline `pressure()` to the shared `HostPressureSampler` (behavior-preserving) + construct the dark-gated poller.
- `src/monitoring/HostPressureSampler.ts`, `src/core/CartographerSweepEngine.ts`, `src/core/cartographerSummary.ts`, `src/monitoring/CartographerSweepPoller.ts` — NEW.
- `src/config/ConfigDefaults.ts` — nested `freshnessSweep` key (deep-merge backfills existing agents; no migrateConfig needed).
- `src/core/componentCategories.ts` — register `CartographerSweep → 'job'`.
- `src/server/routes.ts` — the Tier-1 write route + health backlog metric.
- `src/server/CapabilityIndex.ts`, `src/core/PostUpdateMigrator.ts` — discoverability + CLAUDE.md migration (Agent Awareness + Migration Parity).
- `scripts/cartographer-freshness.mjs`, `.github/workflows/ci.yml` — Tier-3 ratchet + CI job.

## 1. Over-block

The sweep's routing probe refuses to author whenever it would resolve to the
default (Claude) framework. The "over-block" risk is that a correctly-configured
off-Claude agent still gets refused — but the probe tests the REAL router's
`for()` result (tested against the real `IntelligenceRouter`, not a stub), and the
escape `allowClaudeFallback` exists. A refusal is the SAFE direction: it leaves
nodes never-authored and reports, rather than silently spending Anthropic quota.

## 2. Under-block

Could the sweep author on Claude despite the probe? The probe runs at the START of
each tick before any author call, closing the three silent-to-Claude paths
(missing category entry / unmapped `job` / missing binary). The one residual
window — a binary vanishing BETWEEN the tick probe and an author call — is
documented as a deployment precondition (`componentFrameworks.fallback: 'none'`),
and even without it the next tick's probe + the breaker surface it rather than
authoring on Claude across ticks. Secrets under-block: deny-globs + a content
tripwire (`redactForLiveTail`) + committed-only reads; a unit test asserts a
planted credential file is never passed to an author call.

## 3. Level-of-abstraction fit

`CartographerTree` owns storage/staleness; the engine owns the author loop + all
brakes; the poller owns cadence/breaker; the route owns the one write surface. The
`HostPressureSampler` sits at the single host-pressure chokepoint both the reaper
and the sweep now share. No layer reaches across — the engine takes injected deps
(router/queue/pressure/lease) and is fully unit-testable.

## 4. SessionReaper behavior-preservation (the riskiest change)

`server.ts` previously computed reaper pressure inline (os.freemem/loadavg +
`computePressure`). I extracted that EXACT computation to
`HostPressureSampler.sampleHostPressure` and made the reaper's `pressure()` dep
delegate to it. The math is byte-identical (same freePct, same loadPerCore, same
`computePressure`, same default thresholds 1.0/1.5). A unit test
(`host-pressure-sampler.test.ts`) pins the behavior-preserving contract:
`sampleHostPressure(t).tier === computePressure(sampleHostPressureInputs(), t).tier`.
The reaper's own test suite remains green (verified). Risk: a future edit to the
sampler now affects BOTH consumers — that is the intended single-definition win,
and the contract test guards it.

## 5. Failure modes / load (the exact footgun this feature fights)

The feature exists to NOT become the background-LLM load source instar keeps
fighting (the 96×/day breaker-storm). Brakes, all unit-tested: lease-gate (standby
authors zero — no multi-machine N× burn), reentrancy flag (no stacked ticks),
dual per-pass bound (node count AND cents), mid-tick CPU re-sample (curtail at
moderate, break at critical), idle-aware cadence backoff, a breaker that backs off
+ reports ONCE + re-escalates per window (never silent, never give-up-quietly),
per-node quarantine, and `LlmAbortedError` treated as backpressure (a chatty user
can't trip the sweep's own breaker). The within-tick cursor can never exceed the
per-tick caps (corrupt → one extra cheap re-scan). Default-OFF means zero load
until an operator opts in.

## 6. Security / data egress

Enabling the off-Claude sweep transmits committed source content to a third-party
framework's provider. This is gated behind a SEPARATE `egressAcknowledged: false`
(default) — distinct from `enabled` — so turning on freshness is never silently
turning on whole-repo third-party egress. Summaries are treated as an injection
vector on OUTPUT: instruction-shaped content is neutralized before persist, and
child summaries are re-delimited as untrusted data at every internal consumption
point (the hard contract on spec #5's navigator). The Tier-1 write route applies
full path validation (encoded-traversal included), the same deterministic quality
bar as the sweep (no lower-validation backdoor), and a write-rate bound.

## 7. Migration / compatibility (Migration Parity)

`freshnessSweep` is a nested key under the existing `cartographer` block — the
deep-merge add-missing path backfills it to existing agents (no `migrateConfig`
block needed; verified by the nested-default mechanism). The CLAUDE.md affordance
ships via BOTH `migrateClaudeMd` (existing agents, keyed on the own marker "Keep
the map true", idempotent) AND is registered in the feature-completeness test's
legacy-migrator allowlist (consistent with spec #1's cartographer classification).
The new route is in `CapabilityIndex`. Rollback: disabling the flag stops the
poller; cursor/index/measurement files remain inert on disk; the route 503s. No
migration reversal needed. Merge order: this PR must land AFTER spec #1 (#1041,
already on main) — the branch was rebased onto post-#1041 main and imports
`CartographerTree` from `src/core`.
