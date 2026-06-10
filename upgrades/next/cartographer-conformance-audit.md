<!-- bump: minor -->

## What Changed

Adds the **Standards Enforcement-Coverage Audit** (spec #3 of the
cartographer-conformance project) — the constitution's named-but-unbuilt
"registry-wide conformance gate," scoped to the version that is cheap, deterministic,
and useful immediately. Ships **dark** behind `cartographer.conformanceAudit.enabled`.

For each standard in `docs/STANDARDS-REGISTRY.md`, the audit reads the enforcement
mechanism the standard's own prose names (a test, a lint, a gate, a route) and
**verifies that mechanism actually exists on disk**, then classifies each standard's
enforcement strength (a CI ratchet is stronger than a gate, than a lint, than a
design doc, than nothing). It surfaces the GAPS — standards with no verifiable
structural guard — and, louder, **dangling references**: a standard that cites a
guard which no longer exists. It is the founding principle "Structure beats
Willpower" made measurable: which rules are guaranteed, and which are still wishes.

The core is fully deterministic — local file reads only, zero token cost, zero
egress, identical output every run — exposed via two owner-gated read routes
(`GET /conformance/coverage`, `GET /conformance/coverage/health`) and guarded by a CI
ratchet (an enforced-ratio floor that can only rise, plus a hard zero ceiling on
dangling references). An optional language-model enrichment pass for fuzzy cases is a
structural stub, off by default; the deterministic coverage is always the authority.
A slow optional job recomputes and raises ONE aggregated note only when a new gap
appears. Two earlier designs (a per-file language-model audit, then a narrowed
variant) were rejected at review as intractable and then as a no-op respectively.

On its first run against the live constitution it surfaced a genuine dangling
reference — the "Know Your Principal" standard cited a spec path that does not exist
— which this change repairs to cite the real artifacts (a one-line citation
correction, no rule content changed).

## What to Tell Your User

- **Which of your agent's rules are actually guaranteed?**: "I built a check that goes
  through every rule in the agent's constitution and confirms whether a real,
  automatic guard exists for it — a test, a lint, a gate — or whether it's still just
  a sentence someone has to remember. It surfaces the rules that are still only
  wishes, so each one becomes a guard worth building. It's off by default and costs
  nothing to run. On its very first pass it already caught one rule pointing at a
  guard that had been moved."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Per-standard enforcement coverage map | GET /conformance/coverage (opt-in; off by default) |
| Coverage health + gap list + dangling-ref count | GET /conformance/coverage/health |
| Filter coverage | GET /conformance/coverage?family=…&kind=…&status=gap |
| CI enforcement-coverage ratchet | `node scripts/standards-coverage.mjs --check` |
