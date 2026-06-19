<!-- slug: scrape-fixture-realness -->
<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Structurally enforces the `code=t` lesson (the broken account-follow-me sign-in link, 2026-06-18): a parser of untrusted real-world text must be tested against a byte-for-byte REAL captured fixture, not a hand-authored clean string. Adds a Testing-Integrity standard, a `tests/fixtures/captured/` convention (structural bytes sacrosanct; secrets swapped for same-shape, grammar-valid placeholders via a tested redaction helper; one provenance sidecar per capture), and a registry-driven lint `scripts/lint-scrape-fixture-realness.js`. Each registered parser (seeded with `FrameworkLoginDriver.parseArtifact`) must have a test that loads a captured fixture through the single `loadCapturedFixture` helper, feeds it to the parser, and asserts — and the suite runs that test, so the realness is executed, not grepped. A non-blocking `parse*`/`scrape*` register-or-justify warning re-surfaces new parsers. The original `code=t` capture is migrated to disk (secrets redacted, hard-wrap preserved). No runtime code changes.

## Evidence

- `tests/unit/lint-scrape-fixture-realness.test.ts` (10) — both boundary sides: the shipped registry entry passes; tampered cases (missing test, removed loader, missing/invalid sidecar) fail.
- `tests/unit/redact-captured-fixture.test.ts` (8) — same-length, line-position/wrap preservation, redacted URL still parses, length-changing redaction rejected.
- `tests/unit/framework-login-driver.test.ts` (17) — the migrated realness test loads the disk fixture, asserts the full de-wrapped URL ≠ `code=t`.
- `node scripts/lint-scrape-fixture-realness.js` exits 0 (seed entry clean + register-or-justify warning); `npm run lint` (full battery) exits 0; `tsc --noEmit` clean.
