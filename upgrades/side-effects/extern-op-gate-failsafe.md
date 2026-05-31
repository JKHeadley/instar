# Side-effects — External Operation Gate fail-safe classification

## 1. What files/state does this touch at runtime?
`src/core/ExternalOperationGate.ts` only — a 6-line fail-safe guard at the top of
the pure `computeRiskLevel()` function. No new state, config, schema, endpoint, or
dependency. `computeRiskLevel` is also re-exported via `src/index.ts` (public API);
the signature is unchanged.

## 2. Does it change any functional behavior?
Only for UNRECOGNIZED input. An operation whose `mutability` is not
read/write/modify/delete now classifies as `critical` (was `low`); unknown
`reversibility`/`scope` are pinned to irreversible/bulk (conservative). For all 36
valid enum combinations, behavior is byte-for-byte unchanged (proven by test).

## 3. What happens on failure / weird config?
This IS the weird-input path. `Array.includes` on `undefined`/`null`/`''`/any
non-string returns false → the fail-closed branch → `critical`. No throw. The
function remains pure and total.

## 4. Migration parity — do existing agents get it?
Yes, via the normal release — code-only, compiled into `dist`. No agent-installed
file / config / template change → no `PostUpdateMigrator` pass. (NOTE: the
coupled hook PR, tracked as issue-628, that fixes the verb-classifier WILL need
migration parity — the hook is a built-in always-overwritten file.) <!-- tracked: issue-628 -->

## 5. Could it spam / flood / burn resources?
No — it's a pure synchronous classification with three array-membership checks. If
anything it slightly REDUCES load on the unknown-input path (an unknown op that
used to auto-proceed now routes to show-plan/approve, but that path is rare). It
does not add timers, I/O, or LLM calls. (Unknown ops now classify `critical` →
medium+ risk → eligible for the existing LLM proportionality step; but unknown ops
are rare and the step is already rate-limited via the LlmCircuitBreaker.)

## 6. Rollback / off-switch?
Revert the 6-line guard. No data, no migration, no flag. Behavior returns to the
prior (fail-open) state.

## 7. Concurrency / ordering?
None — pure synchronous function, no shared state. The guard runs first, then the
unchanged matrix. `critical` for unknown mutability returns immediately (before the
read short-circuit and the rest of the matrix).

## Blast radius
Minimal + contained. One pure function, unknown-input path only; all valid-input
classifications unchanged (locked by test). Independently adversarially reviewed:
SOUND. The only judgment call — severity `critical` vs `high` for unknown mutability
— was reviewed and confirmed correct (`high` would leave a residual auto-proceed in
the autonomous profile; `critical` never auto-proceeds). A symmetric hook-layer gap
is acknowledged and fixed in the coupled hook PR, tracked as issue-628. <!-- tracked: issue-628 -->
