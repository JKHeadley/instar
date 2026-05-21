# Side-Effects Review — Capabilities Introspection

**Version / slug:** `capabilities-introspection`
**Date:** `2026-05-21`
**Author:** `Echo (instar-developing agent)`
**Second-pass reviewer:** `not required` (pure refactor; response shape preserved; no new decision-point surface)

## Summary of the change

Extracts `src/server/CapabilityIndex.ts` as the single source of truth for the /capabilities self-discovery surface AND the discoverability lint that PR #290 introduced. The /capabilities handler shrinks from ~440 lines of inline build logic to ~25 lines that iterate the index. The lint rewrites to import the registry directly instead of maintaining a parallel hand-written allowlist. Adds a CapabilityIndex unit-test file that pins module-level invariants.

Files touched:

- `src/server/CapabilityIndex.ts` — new module (the registry).
- `src/server/routes.ts` — /capabilities handler refactor.
- `tests/unit/capabilities-discoverability.test.ts` — switch from inline allowlist to imports.
- `tests/unit/CapabilityIndex.test.ts` — new module-level invariant tests.
- `src/data/builtin-manifest.json` — regenerated hashes.
- `upgrades/NEXT.md` — release notes.
- `docs/specs/capabilities-introspection.{md,eli16.md}` — spec + ELI16.

## Decision-point inventory

- /capabilities response builder — **modify (refactor)** — same output, different production path.
- Discoverability lint — **modify** — same invariant, different source of truth.

No new gate/block surface. No runtime decisions changed.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. The lint refuses CI for unclassified route prefixes (the desired behavior). A new route prefix that the author forgot to classify fails the lint with a precise error pointing at CapabilityIndex.ts.

---

## 2. Under-block

**What failure modes does this still miss?**

The lint catches the structural gap (prefix not classified) but does not validate the SEMANTIC correctness of a classification — a contributor could claim a public agent-facing route under INTERNAL_PREFIXES with a bogus reason and the lint would pass. The reason field is reviewer-enforced, not machine-enforced. Acceptable: the reviewer is the right authority for semantic intent; the machine's job is to ensure the choice is made and documented.

The CapabilityIndex.test.ts regression guard for the secrets entry's retrievalHint is intentionally narrow — it asserts the hint mentions `secret-drop-retrieve.mjs` and "NEVER prints the response body." A reviewer could weaken the hint in other ways that still pass the regex (e.g., remove the explicit warning against raw curl). That's a residual risk; the broader feature-delivery-completeness lint catches the related CLAUDE.md → /capabilities parity.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The CapabilityIndex module sits in `src/server/` alongside routes.ts and SecretDrop.ts. It depends on the route-context type via a `type-only` import to avoid a circular module dependency at runtime. The lint sits in `tests/unit/` and imports from `src/server/` as a regular dependency, which is the standard test-to-source direction.

A higher-level abstraction (e.g., deriving CAPABILITY_INDEX from the Express router at runtime) would not replace the classification step — the router doesn't carry semantic intent. The static registry is the right shape.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface at runtime.

The lint has CI-time block authority but only via the CI gate's enforcement; it emits a signal that a smart authority (the reviewer + branch protection) acts on. The lint's logic is straightforward set arithmetic — not a brittle heuristic.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** none. The /capabilities handler is the only consumer of the registry at runtime; the lint is the only consumer at test time.
- **Double-fire:** none. Each invocation produces a fresh map; no shared mutable state.
- **Races:** none. CAPABILITY_INDEX is a frozen const at module load; the build functions are pure.
- **Feedback loops:** none. /capabilities reads from the registry; nothing writes back.

The refactor preserves all existing consumers of /capabilities. Concretely verified: `tests/integration/view-tunnel-routes.test.ts` (privateViewer assertion), `tests/integration/publishing-routes.test.ts` (publishing assertion), `tests/integration/external-operation-safety-routes.test.ts` (externalOperationSafety assertion), `tests/integration/imessage-routes.test.ts` (imessage assertion) — all 76 cases pass unchanged.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Agents on the same machine:** see the same /capabilities response. Field names, nesting, values, iteration order all preserved.
- **Dashboard:** unchanged. The dashboard reads the JSON and renders selected fields; field names are stable.
- **External systems:** none touched.
- **Persistent state:** none introduced.
- **Timing / runtime conditions:** no measurable latency change. The iteration over CAPABILITY_INDEX is O(n) with n=~30; the prior inline literal was also O(n) at JIT eval time.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code change. Revert the three new files (CapabilityIndex.ts, CapabilityIndex.test.ts, the spec/artifact docs) and the routes.ts diff. The lint test reverts to its prior body. No persistent state, no agent-state repair, no user-visible regression during the rollback window.

Realistic rollback: revert + patch release. Under 5 minutes.

---

## Conclusion

This is a low-risk refactor that closes the parallel-surfaces gap introduced by PR #290. The /capabilities response shape is preserved byte-for-byte; the lint is now anchored to a typed module instead of a hand-maintained test allowlist; module-level invariants are pinned by a new test file. No second-pass review required.

---

## Evidence pointers

- Spec: `docs/specs/capabilities-introspection.md`
- ELI16: `docs/specs/capabilities-introspection.eli16.md`
- New tests: `tests/unit/CapabilityIndex.test.ts` (9 cases), refactored `tests/unit/capabilities-discoverability.test.ts` (84 cases). All green.
- Integration tests that exercise /capabilities (76 cases) pass unchanged.
- `npx tsc --noEmit` clean.
- Origin: 2026-05-21 case-study audit (topic 11141, follow-up #2 of two).
