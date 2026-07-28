# Side-Effects Review — EXO 3.0 harness gap fixes

**Version / slug:** `exo3-harness-gap-fixes`
**Date:** `2026-06-07`
**Author:** `Echo (Instar dev agent)`
**Second-pass reviewer:** `not required (Tier-1)`

## Summary of the change

Three surgical bug fixes surfaced by the new `exo3-harness` from-every-angle verification:
(1) `src/core/AgentPassport.ts` `permits()` — default `forbiddenActions`/`allowedCapabilities` to `[]`
so a partial peer passport yields a verdict instead of an HTTP 500; (2) `src/core/OrgIntentManager.ts`
`parse()` — accept the documented chained `A > B > C` Tradeoff Hierarchy form in addition to bullets;
(3) `src/server/routes.ts` `/metrics/learning-velocity` — read the REAL event sources
(`state/evolution/learning-registry.json` with `source.discoveredAt`, `state/evolution/action-queue.json`
`.actions[].createdAt`, and the SQLite `correctionLedger`) instead of three paths the agent never writes.
Regression tests extended in the matching unit + integration suites.

## Decision-point inventory

- `AgentPassport.permits()` — modify (add input-tolerance; verdict logic unchanged)
- `OrgIntentManager.parse()` tradeoff parsing — modify (add chained-line acceptance; bullets unchanged)
- `/metrics/learning-velocity` event gathering — modify (correct source paths; scorer untouched)

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**
None. Passport `permits()` becomes MORE permissive of input shapes (defaults missing arrays) but the
allow/deny verdict for any complete passport is byte-identical. The tradeoff parser only ADDS a format;
a bulleted hierarchy parses exactly as before. No block/allow surface added.

## 2. Under-block

**What does this change now allow that it shouldn't?**
Nothing new is allowed. A partial passport that omits `forbiddenActions` is treated as "no forbidden
actions" — which is the correct, safe reading of an absent list (the verifier still applies trust-floor
and capability-scope). A forbidden action present in a partial passport is still denied (covered by a
regression test).

## 3. Data / state

**What persistent state does this read or write?**
Read-only. The learning-velocity route only READS `state/evolution/*.json` and the correction ledger;
it never writes. No new files, no schema changes, no migrations.

## 4. Performance

The learning-velocity route now reads `action-queue.json` (can be ~hundreds of KB) once per request.
This endpoint is a low-frequency, on-demand observability call (not a hot path); a single synchronous
JSON parse per call is acceptable and bounded. No new work on any per-message or per-tick path.

## 5. Failure modes

Every new source read is wrapped in try/catch and skips on error (unreadable/malformed file → that
source contributes zero, never a 500). The correction ledger read is guarded by `if (ctx.correctionLedger)`
so agents with correction-learning off (ledger absent) are unaffected. The passport guard removes a
crash failure mode entirely.

## 6. Security / auth

No auth surface change. The passport fix HARDENS a trust boundary (a peer-supplied passport can no
longer crash the verifier — a malformed/hostile card now produces a clean verdict). No new endpoints,
no new capabilities, no credential handling.

## 7. Migration / compatibility

No migration needed. The learning-velocity path correction means existing agents' metric starts
reflecting real events on the next deploy (it read zero before). No config, no on-disk format, no
agent-installed file changes. Pure runtime behavior correction.
