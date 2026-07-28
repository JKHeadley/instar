# Captured fixtures — real-world-messy parser/scrape input

This directory holds **real captured output** used to test parsers and scrapers
that consume untrusted, real-world-messy external text (terminal panes, CLI
output, scraped HTML/text, emails/messages, logs, provider responses). It is the
golden-fixture pattern with a hardened **realness + redaction** contract.

Why this exists: the `code=t` bug (2026-06-18) shipped because
`FrameworkLoginDriver.parseArtifact` was tested only against hand-authored CLEAN
strings. The real `claude auth login` pane hard-wraps the long OAuth URL across
lines with no inserted space; the scrape stopped at the first wrap and kept only
`…?code=t`. Every test passed because every input was a tidy single line the
author wrote. See `docs/specs/scrape-fixture-realness.md` and the **Scrape/Parser
Fixture Realness** standard in `docs/STANDARDS-REGISTRY.md`.

## The convention

```
tests/fixtures/captured/<slug>/
  <name>.txt           # the structural capture (realness — never tidied)
  <name>.meta.json     # one-per-capture provenance + redaction sidecar
```

### 1. Structural bytes are sacrosanct — NEVER tidied

The capture preserves **every structural byte that matters to parsing**:
wrapping, ANSI escapes, spacing, line breaks, partial frames. These bytes ARE the
realness — they are exactly the messiness that breaks naive parsers in production.
They are never hand-cleaned, re-wrapped, re-indented, or normalized. The `code=t`
fixture preserves the hard line-wrap across the middle of the OAuth URL byte-for-
byte; that wrap is the thing the parser must survive.

### 2. Secrets are replaced with same-SHAPE, grammar-valid placeholders

A real capture often contains secrets (OAuth URLs with `client_id`/`state`,
tokens, usernames, emails, paths, session ids). Committing them raw is a leak. So
every secret VALUE is replaced with a **same-SHAPE placeholder**:

- **Same length** — so line positions and wrapping are byte-identical.
- **Same character class** — hex stays hex, base64url stays base64url, etc.
- **Delimiters and positions preserved** — a UUID keeps its `-` at the same
  offsets; a URL keeps its `/ ? & = . : %` structure.
- **Grammar-valid** — a redacted URL still parses via `new URL()`; percent-escapes
  and base64 keep their encoding form. The parser's real code path is exercised,
  never bypassed by a malformed placeholder.

Only the secret value BYTES are swapped — never structural bytes. The structural
shape the parser must survive is byte-identical; no real secret lands in the repo.
Use `scripts/redact-captured-fixture.mjs` (which carries its own unit tests) so
same-shape + grammar-valid redaction isn't hand-rolled and error-prone.

### 3. One sidecar per capture — `<name>.meta.json`

Each `.txt` carries a matching-basename `<name>.meta.json` with provenance:

```json
{
  "source": "where it came from (e.g. claude auth login pane)",
  "command": "the exact command that produced it",
  "capturedAt": "ISO-8601 timestamp",
  "machine": "the machine it was captured on",
  "redactions": [{ "what": "...", "strategy": "..." }],
  "redactionMethod": "tool-assisted | manual",
  "note": "anything a reviewer should know"
}
```

The lint (`scripts/lint-scrape-fixture-realness.js`) validates one-sidecar-per-
capture, the required fields, and that `capturedAt` parses as an ISO-8601 date.

## Loading a fixture in a test

Use the single sanctioned load path:

```ts
import { loadCapturedFixture } from '../helpers/loadCapturedFixture.js';
const pane = loadCapturedFixture('claude-url-code-paste', 'mac-mini-wrapped');
```

This is the only helper the realness lint recognizes, and it is what makes the
"the fixture actually reaches the parser" check reliably detectable.

## Registration

Parsers whose realness is enforced are listed in the `SCRAPE_PARSERS` registry in
`scripts/lint-scrape-fixture-realness.js`. Adding/removing an entry requires a
spec change. Any new or materially-changed parser of external free-form text MUST
either be registered there or explicitly justified as out-of-scope in its PR.
