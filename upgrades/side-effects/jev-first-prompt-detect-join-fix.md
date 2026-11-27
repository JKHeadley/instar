# Side-effects review — Jev prompt-detect join key (CMT-1677 follow-up)

**Tier:** 1 (narrow bug fix, revert fully undoes). **Size:** 2 runtime files (+8/−3), 4 test files. **Effort:** no spec rounds; brief from the Jev review of 16 Nov.

## Summary

`validProducerCorrelationId` (`src/core/JudgmentProvenanceLog.ts`) accepted only `^[db]-[A-Za-z0-9-]{1,100}$`. `mintRouterCorrelationId` on a multi-machine install produces `d-<machineId8>-<uuid>`, and pool machine ids look like `m_03b30f…`, so every real id was rejected and `producerCorrelationId` was silently dropped from the Jev `prompt-detect` row (Studio, 16 Nov 02:22Z–18:55Z: 0/77 rows carried it). The pattern now allows `_`. Separately, `JevFirstDecision` records `jevServedModel` (the model the Jev API answered with) next to `jevModel` (the requested pin).

Only caller of `validProducerCorrelationId`: `JudgmentProvenanceLog.recordDecision` (checked with grep). No other silent drop of the same shape.

## Decision point?

No. The validator gates which id is stored on a log row; it does not gate any agent action or message. Jev remains in shadow.

1. **Over-block** — before: every multi-machine id. After: none of the minted forms (unit test mints both router and breaker ids, with and without machine segment).
2. **Under-block** — still rejects whitespace, quotes, `/`, `.`, other prefixes, empty body and >100 chars. `_` cannot form a path or injection on a JSON row field.
3. **Level-of-abstraction fit** — the fix is at the one validator; the mint remains the single source of the format. The test asserts the validator against the mint itself, so the two cannot drift silently again.
4. **Signal vs authority** — signal only (an observability row field). No authority added.
5. **Interactions** — joins in `/judgment-provenance` and decision-quality analysis start working for Jev rows; outcome rows were already keyed correctly. `jevServedModel` is a new context field; a plain model-name string of the same shape as `jevModel`.
6. **External surfaces** — provenance rows are machine-local; served rows gain the top-level id (already a declared field). No user-visible change.
7. **Multi-machine posture** — machine-local by design (provenance is per machine). The bug only affected multi-machine installs; the fix restores the join on them.
8. **Rollback cost** — revert the commit; rows written meanwhile simply carry an extra field.
