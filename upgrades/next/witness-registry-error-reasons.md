# Upgrade Guide — vNEXT

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

`instar-witness` (the standalone `witness` CLI in `packages/witness`, not Instar server code): when the registry answers with an error status other than 422, the command now prints the reason the registry returned (`reason`, or `error.message`) instead of the first 300 characters of the raw response body. A body with no usable reason still prints the raw text as before. Exit codes are unchanged. Closes #2354.

## Evidence

- New tests in `packages/witness/test/registry.test.mjs` failed on the unfixed code (7 failures, each printing raw JSON) and pass after the fix; the full witness suite passes 81 of 81.
- Read-only check against the live registry: it answered `400 {"ok":false,"reason":"..."}`, and the fixed CLI printed `registry answered 400 to lookup: subject and issuer must be DIDs`.
