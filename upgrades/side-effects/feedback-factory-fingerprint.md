# Side-Effects Review — feedback-factory fingerprint port (Phase 1, increment 1)

**Slug:** `feedback-factory-fingerprint`
**Date:** `2026-05-26`
**Author:** Echo
**Spec:** `docs/specs/feedback-factory-migration.md` (converged v2, approved by Justin 2026-05-26)
**Scope:** Scar (b) only — the dedup fingerprinter. The first, foundational increment of the Phase-1 processor port. Other scars ((a) evidence gate, (c) false-merge/reopen/cycling, (d) lifecycle partitioning) and the processor-job wiring are subsequent increments.

## Summary of the change

Ports `compute_fingerprint` + its `extract_component` dependency (and the `SEVERITY_PREFIXES`/`SEVERITY_PHRASES` sets) from the reference `the-portal/.claude/scripts/feedback-processor.py` to TypeScript at `src/feedback-factory/processor/fingerprint.ts`. This is the single most correctness-critical port in the migration — it decides whether two reports are the SAME bug. Adds:
- `src/feedback-factory/processor/fingerprint.ts` — the port (pure functions, no I/O).
- `tests/unit/feedback-factory/fingerprint.test.ts` — Tier-1 behavioral + both-sides-of-boundary tests + golden-value CI anchors.
- `scripts/feedback-factory/fingerprint-parity.mjs` + `_py_fingerprint_ref.py` + `fingerprint-corpus.json` — the LOCAL parity gate that runs the REAL reference Python and asserts byte-identical output.

The module is **not wired into anything yet** — it is a standalone, importable building block. No route, no job, no behavior change for any agent or user.

## The byte-exact-port hazard and how it's handled

Per the spec, Python↔JS diverge on regex character classes, `\b`, `.lower()`, and encoding. The parity harness proved this empirically: a first cut diverged on a bare arabic-indic digit because Python's `\b\d+\b` is a Unicode word boundary while JS `\b` is ASCII-only. Fixed by emulating the Unicode boundary with lookarounds (`(?<![\p{L}\p{N}_])\p{Nd}+(?![\p{L}\p{N}_])`). After the fix: **33/33 corpus entries byte-identical to the reference Python**, including non-ASCII digits, em-dash, NBSP, Turkish İ/ı, German ß, hex hashes, and multi-version titles. Dawn's line-by-line review of the port remains a Phase-1 gate before any production cutover.

## Seven-dimension review

1. **Over/under-reach** — Pure functions, deterministic, no I/O, no global state. Not imported by any runtime path, so it cannot affect existing behavior. Risk is purely *equivalence to the reference*, addressed below.
2. **Level-of-abstraction fit** — Lives at the processor-logic layer (`src/feedback-factory/processor/`), the correct home for the ported scar logic per the spec's open/operated architecture.
3. **Signal vs Authority** — N/A; pure computation, no decision authority.
4. **Interactions** — None. New isolated module; nothing imports it yet. The parity scripts shell out to an external reference path (configurable via `PORTAL_PROCESSOR`) and are LOCAL-only (not CI), so they add no CI dependency on the reference checkout.
5. **Rollback cost** — Trivial: delete the module + tests + scripts. No data, no migration, no wiring to unwind.
6. **Migration parity** — N/A. New internal library code shipped in the package; touches no agent-installed file (`.claude/settings.json` / config / CLAUDE.md template / hooks / skills).
7. **Failure modes** — (a) Port diverges from the reference Python → caught by the parity harness (33/33 now) AND golden-value CI anchors in the unit test (so a future regex/encoding regression fails in CI even without the reference checkout). (b) Reference path absent → parity harness exits 2 with a clear message (it's a local gate, not CI). (c) An adversarial input not in the corpus diverges in production → mitigated by seeding the corpus with the known divergence classes; the corpus is extended as new classes are discovered, and Dawn's review is the human backstop.

## Tests

- Tier-1 unit (CI): `tests/unit/feedback-factory/fingerprint.test.ts` — `extractComponent` (dotted id, first-word fallback, [TAG] strip, whitelisted-vs-not severity prefix, empty); `computeFingerprint` (32-hex shape, version/int/hash collapse, internal-whitespace collapse, leading-whitespace component divergence, case-insensitivity, type+component incorporation, 3 golden anchors). 14 tests.
- Parity (local gate, evidence): `scripts/feedback-factory/fingerprint-parity.mjs` → **33/33 byte-identical** to the reference Python.
- No integration/E2E tier this increment: the module is not yet wired to a route or job; those tiers attach when the processor job + receiver land (subsequent increments). Documented here so the omission is a reasoned decision, not an oversight.
