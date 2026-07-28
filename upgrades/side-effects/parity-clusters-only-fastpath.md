# Side-Effects Review — Parity-pass clusters-only fast path (#948 fix)

**Slug:** `parity-clusters-only-fastpath`
**Date:** `2026-06-08`
**Author:** `echo`
**Tier:** 1 (below risk floor — AgentServer is a fleet/server surface; declared Tier-1 because the change is a single additive opt-in field + one early-loop break, fail-safe, no behavior change to any existing path, fully unit-covered)

## Summary of the change

`HttpParitySource` gains an opt-in `clustersOnly?: boolean`. When set (and `captureRaw` is NOT), `prepare()` stops after page 0 — Portal returns the COMPLETE cluster set on every page (verified live: offsets 0/70k/143k and `limit=1` all return all 1,370 clusters), so paginating the full 145K-row feedback table to collect clusters is wasted work that blows the single-flight max-hold budget (#948). `AgentServer`'s `runParityCheck` closure now passes `clustersOnly: true`. Two new unit tests added.

## Decision-point inventory

1. **`clustersOnly` set AND `captureRaw` set?** → `captureRaw` wins; full pagination (the import rehearsal needs every feedback row). Guarded by `if (this.config.clustersOnly && !this.config.captureRaw) break;` and asserted by the "captureRaw overrides" test.
2. **`clustersOnly` set, `captureRaw` not?** → break after page 0; snapshot = page-0 clusters (= all clusters).
3. **`clustersOnly` unset (default)?** → unchanged behavior; existing pagination + stop-signal intact.

## Over-block

Nothing legitimate is rejected. The flag only short-circuits a fetch loop after it already holds the complete cluster set; it changes neither the parity comparison nor any error path. A caller that wrongly set `clustersOnly` on a path needing feedback would get an empty feedback snapshot — but the only caller that sets it (parity-pass) never reads feedback, and `captureRaw` callers are explicitly exempt.

## Under-block

The fast path trusts Portal's documented + empirically-verified contract that all clusters arrive on every page. If Portal ever changed to page clusters across requests, `clustersOnly` would under-collect. Mitigation: it's verified live today, the comparison surfaces any missing cluster as a divergence (fail-loud, not silent), and reverting is a one-line flag removal.

## Level-of-abstraction fit

Right layer: the option lives on the fetch adapter that already owns pagination; the call-site decision (parity needs clusters only) lives in the `AgentServer` closure that already constructs the source. No new module, no new machinery.

## Blast radius

Tiny. New optional field defaulting to off → every existing construction is unaffected (import rehearsal, tests, any other reader). Ships in dist; no migration. Reversible by dropping the flag at the one call site or the field.

## Failure mode

Fail-safe. If the flag misbehaved, the worst case is the parity-pass seeing fewer clusters → a divergence is reported (loud), never a false "clean pass." It cannot fabricate a green parity window. The import/integrity path is wholly untouched.
