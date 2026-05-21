# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- minor = internal refactor with new test surface, no behavioral change -->

## What Changed

**refactor(capabilities): /capabilities and its lint now share one source of truth — src/server/CapabilityIndex.ts.**

PR #290 surfaced the discoverability gap that started the 2026-05-21 case study. PR #292 closed the workaround-reflex side by retiring the unsafe Secret Drop retrieval pattern. This release closes the last loose end: the /capabilities handler used to be a 440-line hand-curated object literal in routes.ts, and the discoverability lint kept a parallel hand-written INTERNAL_ALLOWLIST. Two surfaces had to stay in sync; nothing structurally enforced the sync.

After this release:

- A new module, src/server/CapabilityIndex.ts, holds the full registry — one entry per capability with a typed build function plus an INTERNAL_PREFIXES allowlist for operator-only routes.
- The /capabilities handler in routes.ts shrinks from ~440 lines of inline logic to ~25 lines that iterate the index.
- The discoverability lint in tests/unit/capabilities-discoverability.test.ts imports CAPABILITY_INDEX and INTERNAL_PREFIXES directly instead of duplicating policy in test code.
- A new CapabilityIndex unit-test file pins module-level invariants: every entry key is unique, every prefix is unique across the registry, INTERNAL_PREFIXES has a reason on every entry, and the secrets entry continues to surface the hardened-retrieval hint.

The response shape is unchanged. Every key that appeared in /capabilities before still appears with the same nested fields. Existing consumers (agents, dashboard, integration tests) see identical output.

## What to Tell Your User

No user-visible behavior change. Adding a new top-level route prefix to instar now requires a single deliberate classification in CapabilityIndex.ts — either claim it under a CAPABILITY_INDEX entry (surfaces it to agents) or add it to INTERNAL_PREFIXES with a one-line reason (skips discovery). The lint refuses unclassified prefixes at CI time, so the next primitive cannot slip through silently.

## Summary of New Capabilities

For the agent: nothing new at runtime. The /capabilities response carries the same data; the way it is produced is now a single iteration over a typed array.

For contributors: a new file to maintain, but only when adding or renaming top-level route prefixes. The compiler enforces shape; the lint enforces classification.

## Evidence

Behavioral parity verified:
- The 76-case integration suite that touches /capabilities (tests/integration/view-tunnel-routes.test.ts, tests/integration/publishing-routes.test.ts, tests/integration/external-operation-safety-routes.test.ts, tests/integration/imessage-routes.test.ts) passes unchanged.
- The discoverability lint shrunk from 81 cases (with a hand-written allowlist) to 84 cases that read from the source-of-truth module. All green.
- New CapabilityIndex.test.ts pins 9 invariants on the registry itself. All green.

Spec: docs/specs/capabilities-introspection.md
ELI16: docs/specs/capabilities-introspection.eli16.md
Side-effects: upgrades/side-effects/capabilities-introspection.md

Origin: 2026-05-21 case-study audit (topic 11141, follow-up #2 of two).
