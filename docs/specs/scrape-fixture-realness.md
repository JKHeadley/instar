---
title: "Scrape/Parser tests must use REAL captured fixtures (the code=t lesson, structurally enforced)"
slug: scrape-fixture-realness
eli16-overview: scrape-fixture-realness.eli16.md
status: draft
author: echo
created: 2026-06-18
parent-principle: "Testing Integrity"
review-convergence: "2026-06-19T03:43:26.841Z"
review-iterations: 4
review-completed-at: "2026-06-19T03:43:26.841Z"
review-report: "docs/specs/reports/scrape-fixture-realness-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "echo (operator directive: Justin, topic 13481 — '#1 then #3 ... proceed autonomously')"
---

# Scrape/Parser tests must use REAL captured fixtures

## Problem statement

The `code=t` bug (2026-06-18) shipped because `FrameworkLoginDriver.parseArtifact` — a parser that turns the messy text of a live `claude auth login` tmux pane into a `{verificationUrl,…}` artifact — was tested ONLY against hand-authored CLEAN strings. The real pane hard-wraps the long OAuth URL across lines with no inserted space; the scrape stopped at the first wrap and kept only `…?code=t`. Every unit test passed because every test input was a tidy single-line string the author wrote. The defect reached the operator (the login link was a useless placeholder).

This is a recurring class, not a one-off: a parser/scraper consumes UNTRUSTED, real-world-messy external text (terminal panes, CLI output, provider pages, message bodies). Tested against clean author-imagined input, it passes while being blind to exactly the messiness that breaks it in production. The lesson currently lives only in prose; nothing structural stops the next parser from being tested against clean strings.

## Proposed design

Three pieces — a standard, a fixture convention, and a lint that ties them together. Precise by construction (a curated registry, not a heuristic over all tests), so false-positives are near-zero.

1. **A registered standard** in `docs/STANDARDS-REGISTRY.md` under the Testing Integrity family: *"A parser of untrusted real-world text is only as good as the realness of its test input. Every registered scrape/parser must have a test that FEEDS it a structurally-real captured fixture (genuine wrapping/ANSI/spacing/line-breaks preserved) and asserts on the result — not a hand-authored clean string."* Crystallizes the `code=t` lesson with its story, and names the **registration trigger** (codex #1 / panel m4): any new or materially-changed parser that consumes terminal output, CLI output, scraped HTML/text, emails/messages, logs, or provider responses MUST either be added to `SCRAPE_PARSERS` or explicitly justified as out-of-scope in its PR.

2. **A real-captured-fixture convention** under `tests/fixtures/captured/<slug>/`:
   - The capture as a `.txt` that preserves every **structural** byte that matters to parsing — wrapping, ANSI, spacing, line breaks, partial frames. These are the realness; they are NEVER hand-tidied.
   - **Secret-redaction policy (codex #2 — load-bearing).** A real capture often contains secrets (OAuth URLs with `client_id`/`state`, tokens, usernames, emails, paths, session ids). Committing them raw is a leak. So secrets are replaced with **same-SHAPE placeholders** — identical length and, critically, identical WRAPPING/positioning — so the structural realness the test exercises is untouched while no real secret is committed. (The `code=t` fixture: the OAuth URL's `client_id`/`state` become same-length placeholder chars; the hard-wrap across lines — the thing the parser must survive — is preserved exactly.) Every redaction is recorded in the sidecar.
   - **One sidecar per capture** (codex #4): `<name>.meta.json` matching the `.txt` basename, with required fields `{ source, command, capturedAt (ISO-8601), machine, redactions: [...], note }`. The lint validates one-sidecar-per-capture, the required fields, and a parseable ISO timestamp.
   - A README in the dir states the rule: structural bytes are sacrosanct; only secrets are placeholder-swapped (same shape); each capture carries provenance. This IS the golden-fixture pattern (codex #5), with a hardened realness+redaction contract.
   - The `code=t` WRAPPED fixture currently inlined in `framework-login-driver.test.ts` is migrated here as the first entry (provenance: `claude auth login`, Mac Mini, 2026-06-18; redactions: client_id/state).

3. **A lint** `scripts/lint-scrape-fixture-realness.js` driven by a curated `SCRAPE_PARSERS` registry (same pattern as other lints' allowlists — adding/removing an entry requires a spec change). Each entry is `{ parserSymbol, fixtureSlug, testFile, testName }`. For each registered parser the lint verifies (M2/M3/codex #3 — the realness must be EXECUTED, not merely co-located):
   - (a) `tests/fixtures/captured/<slug>/` exists with ≥1 `.txt`, each with a valid matching `.meta.json` (fields + ISO timestamp).
   - (b) `testFile` contains a test named `testName`, and **within that test's body** all three hold: a load via the shared helper `loadCapturedFixture('<slug>', …)`, the loaded value passed as an argument to a `parserSymbol(...)` call (a required test SHAPE — a syntactic convention, NOT a data-flow analyzer; codex r3 #1), and at least one `expect(...)` on the parse result. The shared `loadCapturedFixture` helper (a small test util) is what makes (b) reliably detectable and is the single sanctioned load path. The lint matches a TINY CANONICAL FORM (it is a syntactic matcher, not a general AST data-flow analyzer; the registered test must be written this way), e.g.:
   ```ts
   it('parses the REAL wrapped Mac Mini login pane', () => {
     const pane = loadCapturedFixture('claude-url-code-paste', 'mac-mini-wrapped');
     const art = FrameworkLoginDriver.parseArtifact(pane, 'url-code-paste');
     expect(art!.verificationUrl).not.toBe('https://claude.com/cai/oauth/authorize?code=t');
   });
   ```
   The matcher accepts the registered `parserSymbol` as a member expression (`Cls.method`) or a bare/aliased call; tests that want enforcement conform to this shape.
   - **Execution closure:** that named realness test is a normal unit test, so the existing `npm test`/CI suite RUNS it and requires it to PASS. The lint guarantees the test exists + feeds-and-asserts; the suite guarantees it passes. Together they execute the lesson rather than grep for it. Residual honestly owned: the lint can't prove an assertion is non-trivial (a deliberately weak `expect`) — that stays a review concern, but the bar is now "feeds the real bytes to the parser and asserts + passes," not "mentions both."
   - **Close-the-Loop signal (panel m4 / codex #1):** the lint ALSO scans `src/` for exported symbols matching `parse*`/`scrape*` that are not in `SCRAPE_PARSERS` and emits a non-blocking WARNING ("register-or-justify") — a signal that re-surfaces the registration decision, never a block (Signal-vs-Authority).
   - **Wiring (M1 — corrected):** the lint is added to the `"lint"` script `&&`-chain in `package.json` (the canonical battery that `npm run lint` / CI `ci.yml` run), with a `lint:scrape-realness` + `:staged` pair matching the existing convention, and invoked directly in `scripts/pre-push-gate.js` alongside the other two direct lints so a `npm run lint` regression can't silently drop it.

The registry SEEDS with the one parser we know consumes untrusted terminal text: `FrameworkLoginDriver.parseArtifact`. Growth is deliberate (spec-gated + the register-or-justify warning), so the lint never guesses which tests are "scrape tests" — it enforces realness for parsers explicitly registered, which is exactly the set where the risk is known to bite.

## Decision points touched
- New lint — a build-time pass/fail over a CURATED registry. Per **Signal vs. Authority**: a brittle low-context filter only signals, but a hard-blocking lint is legitimate when its false-positive surface is near-zero by construction — which a curated allowlist gives (identical posture to `lint-no-direct-llm-http` and `lint-dev-agent-dark-gate`, both hard-block on curated lists). The register-or-justify check is signal-only (warning). No runtime behavior, no block/allow on messages or sessions.
- New standard in the registry; new fixture convention directory.
- No runtime code changes; no config flags.

## Frontloaded Decisions
- **FD1 — Registry, not heuristic.** The lint enforces realness ONLY for parsers in a curated `SCRAPE_PARSERS` registry (spec-gated to grow), never a heuristic over "all tests that look like parsers." This makes false-positives near-zero (the failure mode that would make the lint hated and disabled) and keeps the lint honest: it enforces a known risk on a known set, and the registry's growth is the deliberate act of saying "this parser eats untrusted text."
- **FD2 — Structural bytes are real-and-sacrosanct; only secrets are placeholder-swapped (same SHAPE).** The realness that matters is structural — wrapping, ANSI, spacing, line breaks, partial frames — and those are NEVER tidied. But a real capture carries secrets (OAuth `client_id`/`state`, tokens, usernames, emails, paths, session ids), and committing them is a leak (codex #2). So secrets are replaced with same-SHAPE placeholders, defined operationally (codex r2 #2): preserve length, line positions/wrapping, delimiter characters (`/ ? & = . : %` and the like), encoding boundaries, and parser-relevant character classes — i.e. swap only the secret VALUE bytes for inert chars of the same class, never structural bytes — AND the redacted value must stay GRAMMAR-VALID (codex r3 #2): a redacted URL still parses as a URL, percent-escapes/base64 keep their encoding form, so the parser's real code path is still exercised, not bypassed by a malformed placeholder. The structural shape the parser must survive is byte-identical; no real secret lands in the repo. A small redaction helper script (`scripts/redact-captured-fixture.mjs`) handles the common classes (URL query values, tokens, ANSI-adjacent secrets, usernames, paths) so same-shape+grammar-valid redaction isn't hand-rolled error-prone; each `redactions[]` entry records what was redacted, the replacement strategy (e.g. `client_id value → same-length [a-f0-9] placeholder, delimiters preserved`), AND `redactionMethod: tool-assisted|manual` so a hand-redacted fixture is visible in review. Because the redaction helper is now part of the realness chain, it carries its OWN unit tests (gemini #2) proving it preserves structural bytes (length, wrapping, line positions) and grammar-validity (a redacted URL still parses; encoding form intact) — a redaction bug must not silently produce a passing-but-fake fixture. The README + provenance make a hand-fabricated "fixture" detectable in review. The lint checks the fixture EXISTS, is loaded-and-fed-and-asserted (§3b), and has valid provenance; it cannot prove the un-redacted bytes were genuinely real (a review concern) — but the bar is now "a provenance-stamped structural capture fed to the parser and asserted," not "a clean string inline."
- **FD3 — Seed scope is one parser, with a structural register-or-justify trigger (not an open-ended someday).** Only `FrameworkLoginDriver.parseArtifact` is registered initially (the one we KNOW bit us). The lint does not retroactively demand captures for every parser — that would be an unbounded migration. The standard names the concrete REGISTRATION TRIGGER (any new/materially-changed parser of external free-form text → register or justify-in-PR), and the lint's `parse*`/`scrape*` register-or-justify WARNING re-surfaces the common case structurally (Close-the-Loop). Honest coverage (codex r2 #3): the exported-symbol warning catches the common shape but misses inline/method/private parsers, so it is a BACKSTOP, not full coverage — the standard's PR register-or-justify trigger (review-assisted) is the primary mechanism; the warning reduces reliance on memory, it does not replace the review check. Nothing here is left unfinished: the standard + convention + lint + the seed entry ship COMPLETE and enforcing; the registry is the standard's allowlist, designed to grow via a structural trigger (not a postponed promise).
- **FD6 — Realness is EXECUTED via a shared loader, not grepped (M2/M3/codex #3).** A co-occurrence check (test mentions the parser AND a fixture path) is gameable — the fixture might never reach the parser. So a single sanctioned helper `loadCapturedFixture(slug, name)` is the only load path, and the lint requires, inside the registry-named test, that the loaded value flow into the `parserSymbol(...)` call with an `expect` on the result. The test runs in the normal suite (so it must PASS). Lint = exists-and-feeds-and-asserts; suite = passes. To keep the data-flow check implementable and non-brittle (codex r2 #1), the lint enforces ONE explicit supported pattern as a CONVENTION (not a general data-flow proof): within the named test, `const <v> = loadCapturedFixture('<slug>', …); const <r> = <parserSymbol>(<v>…); expect(<r>)…`. A registered test must conform to that shape (loader→var→parser-arg→expect on the result); the lint matches that shape, and a test that wants realness-enforcement simply writes it that way. The residual (a deliberately trivial assertion) stays a review concern, owned honestly.
- **FD7 — Lint wiring is the real battery (M1 — corrected).** The lint is added to the `"lint"` `&&`-chain in `package.json` (what `npm run lint` and CI `ci.yml` actually run) + a `lint:scrape-realness`/`:staged` pair, and invoked directly in `scripts/pre-push-gate.js` next to the other direct lints. (The earlier draft wrongly named `instar-dev-precommit.js`/"Repo Invariants"; that file runs zero lints.)
- **FD8 — Sidecar is one-per-capture, validated (codex #4).** Each `.txt` has its own `<name>.meta.json` (matching basename) with `{source, command, capturedAt(ISO), machine, redactions[], note}`; the lint validates one-per-capture + required fields + a parseable ISO timestamp, so a stale/missing/shared sidecar fails.
- **FD4 — Multi-machine posture.** Machine-local by design: this is a build-time lint over the source tree + fixtures committed to the repo; it has no runtime surface, no state, no cross-machine behavior. Every machine that builds the repo runs the identical lint over the identical committed fixtures.
- **FD5 — The migrated fixture must keep proving the bug.** Migrating the inlined WRAPPED fixture from `framework-login-driver.test.ts` to `tests/fixtures/captured/` must preserve the existing test's assertion (the de-wrapped URL is the full URL, NOT the `code=t` head fragment). The test loads the fixture from disk instead of an inline const; the assertion is unchanged. This guarantees the realness convention and the regression guard reinforce each other.

## Open questions
*(none)*
