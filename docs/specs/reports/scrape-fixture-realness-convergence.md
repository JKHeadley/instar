# Convergence Report — Scrape/Parser tests must use REAL captured fixtures

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex, gpt-5.5) ran and **succeeded on every round** (4 rounds). A Gemini (gemini-2.5-pro) pass also ran successfully on the final spec. Both are genuine outside-the-Claude-family opinions. Internal reviewers (security/adversarial + decision-completeness/lessons panel) and the code-backed Standards-Conformance Gate (22 standards) also ran.

## ELI10 Overview

Yesterday's broken sign-in link (`code=t`) wasn't bad code — it was a bad TEST: the code that reads the messy real login screen was only ever tested against tidy made-up text, so it never saw the line-wrapping that broke it in the real world. This change makes "test it against the REAL captured thing" a rule the build enforces, so the next reader-of-messy-text can't slip through the same way.

It adds three things: a written standard, a folder of real captured samples (`tests/fixtures/captured/`) with provenance notes and a strict rule that you never tidy them, and an automatic checker (a lint) that keeps a short, deliberate list of "readers of messy text" and refuses the build if any of them lacks a test that actually FEEDS it a real captured sample and checks the result. It starts with exactly the one reader that caused yesterday's bug, and grows one reviewed entry at a time so it's accurate from day one and never noisy.

## Original vs Converged

The original spec was directionally right (standard + fixture convention + registry-driven lint) but had real holes that 4 rounds + an internal panel closed:

- **Wiring was factually wrong.** It claimed the lint would run in the pre-commit hook and a CI "Repo Invariants" job — neither runs lints. Corrected: the lint joins the `package.json` `"lint"` chain (what `npm run lint`/CI actually run) + the pre-push gate.
- **The check was gameable.** Originally it only required a test to "mention the parser AND a fixture path" — which doesn't prove the fixture ever reaches the parser. Converted to a single sanctioned `loadCapturedFixture` helper + a required canonical test SHAPE (loader→var→parser-arg→expect) that the existing test suite actually runs and must pass — so the realness is EXECUTED, not grepped.
- **Committing real captures would leak secrets.** The biggest external catch: real login captures contain OAuth URLs with `client_id`/`state`, tokens, usernames. Added a secret-redaction policy: structural bytes (wrapping/ANSI/spacing) are sacrosanct, but secret VALUES are swapped for same-shape, grammar-valid placeholders (a redacted URL still parses), recorded per-redaction in a sidecar, via a tested helper script.
- **Registry growth was prose-only.** Added a concrete registration trigger in the standard + a non-blocking `parse*`/`scrape*` "register-or-justify" warning (a structural backstop, honestly scoped: it can't catch inline/private parsers, so the PR review check remains primary).

## Iteration Summary

| Iteration | Reviewer(s) | Verdict | Material findings | Changes |
|-----------|-------------|---------|-------------------|---------|
| 1 | codex; internal panel (security/adversarial + decision-completeness/lessons) | codex MINOR; **panel: 2 material** | wiring-wrong (M1), gameable-grep (M2/M3), secret-leak (codex #2), registry-trigger, sidecar-per-capture | feed-and-assert via helper; redaction policy; corrected wiring; registration trigger; FD6–FD8 |
| 2 | codex | MINOR | 0 new material (refinements) | exact test pattern; same-shape operational def; close-the-loop honesty |
| 3 | codex | MINOR | 0 new (stable repeats) | required-shape framing; grammar-valid redaction |
| 4 | codex | MINOR | 0 new (identical to r3) | canonical-form example; redaction helper + tool-assisted metadata |
| — | gemini + conformance gate | gemini MINOR; gate: 1 (documented residual) | 0 material | redaction-helper unit tests (gemini); the Structure-vs-Willpower registry-growth residual is owned (FD3) |

## Full Findings Catalog (by theme)

- **Lint wiring wrong (panel M1)** → `package.json` lint chain + pre-push gate. RESOLVED.
- **Gameable co-occurrence grep (panel M2/M3, codex #3)** → `loadCapturedFixture` helper + canonical test shape, executed by the suite. RESOLVED.
- **Secret leakage in committed captures (codex #2)** → same-shape, grammar-valid redaction + sidecar `redactions[]` + tested helper. RESOLVED.
- **Sidecar validity (codex #4)** → one-per-capture, matching basename, required fields + ISO timestamp. RESOLVED.
- **Registry growth / Close-the-Loop (panel m4, codex #1, conformance Structure-vs-Willpower)** → registration trigger in the standard + non-blocking register-or-justify warning; residual (inline/private parsers need review) owned honestly in FD3. RESOLVED to the extent feasible without an unbounded heuristic (which FD1 deliberately rejects).
- **Redaction helper correctness (gemini #2)** → the helper carries its own unit tests. RESOLVED.
- **Signal-vs-Authority (panel m3)** → hard-block justified by curated-registry precision (sibling-lint posture); register-or-justify is signal-only. DOCUMENTED.
- **Jargon density (gemini #1)** → cosmetic; the ELI16 companion carries the plain-English entry point; the spec retains review-provenance tags for the convergence audit. NON-MATERIAL.

## Convergence verdict

**Converged at iteration 4.** Codex rounds 3 and 4 produced the identical refinement set (the stabilization signal) with no new material finding; the internal panel's two material flaws and codex's secret-leak catch are all resolved; gemini and the conformance gate added only a minor (now-fixed) and a documented residual. `## Open questions` is empty. Ready for approval + build.
