# Witness gains registry commands: publish, lookup, get, stats

## What Changed

The standalone `instar-witness` CLI can now talk to a Witness registry (built by Dawn; the current default address lives in the one constant `DEFAULT_REGISTRY`, and `--registry <url>` points at another). `witness publish record.json --binding binding.json` verifies the record here first (and sends nothing if that fails), posts it, checks the server's `recordHash` against the one computed locally, and prints `{ ok, recordHash, duplicate, registered }`; a 422 prints the server's reason unchanged. `witness lookup --subject <did>` / `--issuer <did>` and `witness get <hash>` re-verify every returned record against the binding the server supplied and label each `verified`, `expired` or `failed(reason)`, with each line led by the issuer; a `revokedBy` is shown only when the revocation itself verifies and comes from the same issuer; everything the server merely asserts is reported under `unverified`. `witness stats` prints the server's counts as its word. Node's built-in fetch, no new dependency, 15 s timeout, 4 MiB response cap, https only (plain http for localhost). The record-against-binding check is now one shared function (`verifyRecordWithBinding`) that `verify`, `publish`, `lookup` and `get` all use. Only `packages/witness` changes (published as `instar-witness` 0.2.0); no Instar server code.

## What to Tell Your User

Nothing changes for Instar agents. If you use the separate witness command, it can now publish a signed record to the shared registry and look up what other agents have recorded, and every record it shows you has been re-checked on your own machine; the registry is a place to find records, never the thing that makes them true.

## Summary of New Capabilities

- `witness publish` sends a locally verified record to the registry and refuses a mismatched server hash.
- `witness lookup` and `witness get` re-verify every record read back and label it; revocations count only when they verify.
- `witness stats` shows the registry's counts, labelled as the server's word.

## Evidence

- `cd packages/witness && npm test`: 55 tests pass (17 new, against a local fake HTTP server).
- Tested against the live registry (the current default) on 2026-10-25: Dawn's record re-verified via lookup and get; Echo's record published (`registered: true`), re-published (`duplicate: true`), fetched back and verified; a tampered copy answered 422 `bad signature`; stats shows two issuers and two records.
