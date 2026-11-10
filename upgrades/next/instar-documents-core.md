## What Changed
Adds the core library for Instar Documents (spec `docs/specs/instar-document-viewer.md`): the signed, replicated row format, per-machine chains, the deterministic fold with per-reader visibility, the access rule, the on-disk store (ingest, pending re-check, purge, prune, export and merge-restore), and the text algorithms (projection, anchoring, word diff, content-defined chunking). Nothing imports it yet: no route, config, hook or migration changes, so agents behave exactly as before.

## What to Tell Your User
Nothing changes yet. This is the groundwork for commentable documents, which will reach you in a later update.

## Summary of New Capabilities
- None user-visible yet: an inert library under `src/documents/`, wired by later steps behind the `documents` switch.

## Evidence
- `tests/unit/documents-core.test.ts` (row format, chains and signatures, fold order independence, causal order, concurrent versions, move disclosure, 2b visibility, cascade, access table).
- `tests/unit/documents-store.test.ts` (append and peer ingest in any order, tampering and standing refusals, pending re-check, purge and prune, byte paging, export and merge-restore, refused rows keep chain position, forks).
- `tests/unit/documents-projection.test.ts`, `documents-anchor.test.ts`, `documents-diff.test.ts`, `documents-chunker.test.ts`, `documents-reference.test.ts` (golden corpus, anchoring states and property test, diff round-trip and minimality against an LCS reference, fuzzy matching against brute force, chunk identity and boundary stability).
