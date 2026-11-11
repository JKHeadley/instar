# Side-Effects Review — Unified usage ledger, Slice 3 (equivalent API prices)

**Version / slug:** `unified-usage-ledger-slice3`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Third build slice of `docs/specs/unified-usage-ledger.md`: the "what would this have cost at API list price" figure.

- **Price authority (`src/core/routingPriceAuthority.ts`).** New door class `list-equivalent` for doors named `<provider>-list`. Points gain an optional `cacheWritePerMtok` (validated ≥ 0) plus `sourceUrl` and `retrievedAt`. The manifest gains `modelFamilies` (reported-model prefix → list door + priced model, longest prefix wins). Two new read methods: `listEquivalentFor(model)` and `canonicalPointAt(door, model, ms)` — the latter reads canonical manifest points only, never the machine-local overlay or the observed cache, so every machine values the same usage identically.
- **Manifest (`scripts/routing-prices.manifest.json`).** 16 points on two new doors, `anthropic-list` (10 Claude models) and `openai-list` (6 GPT models), copied from the providers' published pricing pages on 2026-11-10 with the page link and retrieval time on each point. Doors `anthropic-list` and `openai-list` carry no freshness SLA (a published list price stays in force until superseded).
- **Pricing (`src/monitoring/usagePricing.ts`, new).** `priceBucket` applies `input·p_in + cache_read·p_cache_read + cache_write·p_cache_write + output·p_out` at the point in force on the bucket's UTC day. A bucket with tokens in a column whose rate is missing is `unpriced` with its token count — never partially priced. `CostAccumulator` sums priced dollars and the unpriced share. `reportingCost` (cached ⊂ input) is not reused.

**Disclosed assumptions (on each point's `_note`):** the pricing pages give current prices with no effective date, so each point is effective from 2026-10-01 (the earliest usage the ledger holds, given its 30-day backfill window). A change discovered later is a new point. Claude cache writes use the 5-minute rate (Claude Code's default; 1-hour writes would be under-valued). Haiku 5.5 uses its up-to-100k-token-prompt rate (longer prompts cost 5× and are under-valued). OpenAI rates are the short-context standard tier.

Tier 2. Size: 1 file changed (~70 lines), 1 new module (~110 lines), manifest +16 points, 1 new test file (9 tests).

## Decision-point inventory

- None that gates anything. `priceBucket` is a pure valuation function for reporting.

## 1. Over-block

Nothing is blocked.

## 2. Under-block

Not applicable.

## 3. Level-of-abstraction fit

Prices stay in the one canonical, human-reviewed manifest the routing spend view already uses; the ledger reads it through two narrow methods instead of a second price table.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

Signal only. No money gate reads `list-equivalent` doors: the metered spend gate consults `metered` doors, and `doorClassOf` returns `list-equivalent` before the CLI/metered checks, so a list door can never be mistaken for a metered one.

## 4b. Judgment-point check (Judgment Within Floors standard)

None.

## 5. Interactions

- Routing spend view and the money layer: the new doors are not in `CLI_ROUTING_DOORS` or `METERED_ROUTING_DOORS`, so their resolution and gate paths never see them. `tests/unit/routing-price-authority.test.ts`, `routing-spend-view.test.ts`, `metered-spend-gate.test.ts`, the money-layer and routing-spend e2e and integration suites pass unchanged.
- Three slice-1/2 catch blocks in `AgentServer` and fifteen in `UsageLedger` gained `@silent-fallback-ok` reasons, bringing the no-silent-fallbacks count back to its baseline.

## 6. External surfaces

None in this slice (figures surface through Slices 4–5).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface yet.

## 7. Multi-machine posture (Cross-Machine Coherence)

The manifest ships with the package, so every machine on the same version values usage identically; machine-local overlays are deliberately ignored.

## 8. Rollback cost

Additive. Removing the points leaves usage unpriced, never mispriced. No stored value depends on a price (pricing is on read).

## Conclusion

Safe to ship. Equivalent cost is now computable for every model this agent actually uses.

## Evidence pointers

- `tests/unit/usagePricing.test.ts` — 9 tests: the four-part formula; as-of-day pricing across a price change; day-aligned effective dates; a backdated point pricing history on read; all-or-nothing unpriced; unknown model / no point; accumulator shares; validation; the shipped manifest prices all 12 models seen in this agent's recent transcripts and rollouts, longest prefix wins, `<synthetic>` stays unpriced, every list point has a source link.
- Price-related unit (9 files, 138 tests), integration (16) and e2e (20) suites: pass. `npx tsc --noEmit`: exit 0.
