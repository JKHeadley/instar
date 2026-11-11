# Side-Effects Review — Unified usage ledger, full-suite fixes

**Version / slug:** `unified-usage-ledger-suite-fixes`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

The full unit suite on the merged head (3,502 files) found four failures caused by this branch; all are fixed here.
- `intelligence-provider-usage-contract.test.ts` and `codex-cli-provider-execjson.test.ts` pinned the exact `onUsage` payload; the additive `detail` field broke `toEqual`. The assertions now compare the folded fields with `detail` set aside (unchanged contract), and `detail` is asserted in `ClaudeCliIntelligenceProvider-jsonParse.test.ts`.
- `storage-error-response-ratchet.test.ts` flagged `usageRoutes.ts` returning `err.message` from a catch. The only error passed through is `UsageQueryError`, whose text is written for the caller; it now carries an explicit `userText` field and the route sends that, so no OS or database message can reach a response.
- `feature-ladders-coverage.test.ts`: `usage.ledger` (the spec's named ladder) gets an entry in `src/data/feature-ladders.json` — standard risk, dev-agent-live then fleet, 7-day soaks, measured from an hourly `fired` / `error` the ingest tick now records to the shared feature-evidence log (`AgentServer`), rate-limited to one each an hour.

- The e2e suite (4,046 tests) found that the holder's first usage pull ran at boot, adding a `/usage/rollup` request to peers that `mobile-remote-media-alive` and `mobile-slack-holder-proxy-alive` count exactly. The first pull now runs one minute after boot on an unref'd timer (then every 5 minutes as before); a boot pull was never needed, and this keeps startup lighter.

- `SqliteRegistry-wiring.test.ts` requires every file that opens a SQLite handle to be catalogued; `UsageLedger.ts` (which registers its handle in the constructor since Slice 1) is now listed as a long-lived store. Found by Local Verify on 6504931c7; it was in the local full-suite failure list but cut off by a truncated listing.

Remaining full-suite failures (48 tests in `MacDesktopHostCapture`, `MacDesktopHostIdentity`, `desktop-displays`) fail identically on `origin/main` on this machine (checked in a clean checkout); they are environmental and unrelated.

## Decision-point inventory

None.

## 1. Over-block / 2. Under-block

Not applicable.

## 3. Level-of-abstraction fit

Evidence goes through the shared `featureEvidence` recorder like every laddered feature.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

Evidence rows are signal for the maturation ladder; they gate nothing at runtime.

## 4b. Judgment-point check (Judgment Within Floors standard)

None.

## 5. Interactions

At most two evidence rows an hour per machine.

## 6. External surfaces / 6b. Operator-surface quality

A 400 `bad-query` answer's text is unchanged.

## 7. Multi-machine posture (Cross-Machine Coherence)

Evidence is per machine, as for every ladder.

## 8. Rollback cost

Trivial.

## Conclusion

Safe.

## Evidence pointers

- The four suites and the two e2e files pass after the fix; the full integration suite (803 files, 6,716 tests) passes; `npx tsc --noEmit` exit 0; desktop failures reproduced on a clean `origin/main` checkout.
