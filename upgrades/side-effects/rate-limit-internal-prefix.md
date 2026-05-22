# Side-Effects Review — `/rate-limit` registered in `INTERNAL_PREFIXES`

**Version / slug:** `rate-limit-internal-prefix`
**Date:** 2026-05-22
**Author:** echo
**Trigger:** CI shard 1/4 (Node 20 + 22) deterministic failure in `tests/unit/capabilities-discoverability.test.ts:122` — the discoverability lint requires every route prefix in `routes.ts` to be either claimed by `CAPABILITY_INDEX` (agent-discoverable) or allowlisted in `INTERNAL_PREFIXES` (intentionally hidden). My PR added `GET /rate-limit/status` to `routes.ts` but did not classify the new `rate-limit` prefix.

## Summary of the change

One-line addition to `INTERNAL_PREFIXES` in `src/server/CapabilityIndex.ts`:

```ts
{ prefix: 'rate-limit', reason: 'operator-only rate-limit-sentinel observability — agent-facing surface is the sentinel’s own notices' },
```

This matches the exact pattern of five sibling sentinel/observability prefixes already in `INTERNAL_PREFIXES`:
- `quota` — operator-only quota observability
- `watchdog` — operator-only watchdog state
- `prompt-gate` — operator-only prompt-gate observability
- `delivery-queue` — operator-only relay queue observability
- `scope-coherence` — operator-only scope-coherence observability

## Decision-point inventory

**Choice:** `INTERNAL_PREFIXES` vs. `CAPABILITY_INDEX`.

Picked `INTERNAL_PREFIXES`. Reasoning: `GET /rate-limit/status` is read-only observability with no agent-facing action. The agent-facing surface of the rate-limit feature is the sentinel's **proactive** Telegram notices ("backing off", "still throttled", "back online", "still can't get through"). An agent doesn't poll `/rate-limit/status` — the sentinel pushes information to the user. Every sibling sentinel observability route makes the same choice for the same reason.

## 1–7. Analysis

1. **Over-block.** Hiding `/rate-limit/status` from `/capabilities` discovery — could that suppress a real agent capability? No. The route returns status data only; there's no agent action to invoke. The capability the agent has is "the sentinel will message me when a throttle hits"; that's surfaced through the sentinel's notifications, not through a route the agent reads.
2. **Under-block.** Could marking it internal silently swallow a future agent-facing route under the same prefix? `/rate-limit/*` is one operator-only route today. If a future change adds a genuinely agent-facing `/rate-limit/<action>`, that change would need to either split the prefix or move the entry to `CAPABILITY_INDEX` — and the discoverability lint will catch it because every new route is enumerated and re-classified.
3. **Level-of-abstraction fit.** The deny-allowlist (`INTERNAL_PREFIXES`) is exactly the layer the lint reads. No other layer would fix the lint.
4. **Signal-vs-authority compliance.** This is a classification (signal), not a behavioral gate (authority). The route still behaves identically. The change shapes what `/capabilities` includes; nothing else.
5. **Interactions.** Zero coupling to other allowlist entries. The lint operates per-prefix; adding one entry can't affect the classification of another.
6. **Rollback cost.** Trivial — one-line removal. The route would then surface as unclassified and the lint would block again, signalling the rollback to whoever ran it.
7. **Test coverage.** Covered by the existing 85-test `capabilities-discoverability.test.ts` suite, which dynamically generates one test per route prefix. The lint that caught this on CI is the same lint that now passes for `rate-limit`.

## Rollback

Remove the single line from `INTERNAL_PREFIXES` in `src/server/CapabilityIndex.ts`. CI will immediately re-fail with the same error message that triggered this fix.
