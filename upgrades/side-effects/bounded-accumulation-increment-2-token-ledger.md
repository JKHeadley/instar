# Side-Effects Review — Bounded Accumulation Increment 2a: token-ledger SQLite retention

**Slug:** `bounded-accumulation-increment-2-token-ledger` · **Tier:** 2 (spec-driven; the
Bounded Accumulation spec converged + operator-approved, merged in #1241)
**Spec:** `docs/specs/bounded-accumulation-standard.md` §4 (SQLite class) + §6 D1.

## Summary of the change

Retrofits the single largest unbounded store — `token-ledger.db` (256MB, the lone SQLite
store with no retention; ResourceLedger already prunes) — with the standard's bounded
retention, behind a dark-by-default config flag:
- `TokenLedger`: `auto_vacuum=INCREMENTAL` pragma (set before table creation, so it takes
  effect on FRESH DBs and is a safe no-op on the existing un-converted file); `pruneOlderThan`
  (BATCHED, bounded-per-call DELETE so a huge backlog never blocks the loop in one statement);
  `incrementalVacuum` (reclaim freed pages); `pruneToRetention` (no-op when disabled).
- `TokenLedgerPoller`: drives `pruneToRetention` on a 6h SUB-cadence (the scan stays 60s),
  off the scan path; a reported backlog (`more`) drains across subsequent ticks.
- `InstarConfig.storage.retention.tokenLedger` (`enabled` default false, `maxAgeMs` default 30d).
- `AgentServer` wires the config to the ledger.

## Decision-point inventory

Frozen in spec §6: D1 token-ledger window = 30 days (default), SQLite mechanics =
`auto_vacuum=INCREMENTAL` + batched delete + incremental_vacuum off the request path on a 6h
timer (mirrors the real feature-metrics prune). No decision is introduced at the callsite.

## 1. Over-block / data loss

The prune deletes token_events older than `maxAgeMs` (default 30d). token-ledger is read-only
observability, re-derivable from Claude Code transcripts (the §5 re-derivability caveat). Ships
DARK (`enabled` defaults false) — zero deletion until an operator opts in, so there is no
surprise data loss. Batched + bounded so it never blocks the event loop.

## 2. Under-block

Disabled by default → no enforcement until opted in (intentional dark rollout, spec §6). The
existing 256MB file's DISK is not reclaimed until the one-time Increment-3 VACUUM converts it to
auto_vacuum; until then the prune still bounds the ROW COUNT (stops further growth). Stated, not
hidden.

## 4. Signal vs authority

No gate/block. The retention is housekeeping driven by the existing poller cadence; it takes no
destructive action beyond deleting aged observability rows it owns. Fail-open throughout
(`@silent-fallback-ok` on every prune/vacuum catch — a failed prune leaves rows for the next
tick, never throws into the poller).

## 5. Interactions

`pruneToRetention` is a no-op when disabled, so the poller's new sub-cadence call is inert on
every current agent (flag defaults false). The auto_vacuum pragma is a no-op on the existing
256MB file (only fresh DBs convert). No existing TokenLedger query/insert path is changed. The
poller's scan cadence is unchanged (prune rides a separate 6h sub-cadence).

## 6. External surfaces

No new route. One new config field (`storage.retention.tokenLedger`), additive + optional. The
`/tokens/*` routes are unaffected (same data, just aged-out beyond the window when enabled).

## 6b. Operator-surface quality

N/A — no operator/dashboard/approval surface. Enabling is a config edit (a future increment may
add a dashboard toggle).

## Framework generality

N/A — TokenLedger is framework-agnostic observability (scans Claude Code + Codex transcripts);
not part of the session launch/inject abstraction.

## 7. Multi-machine posture

token-ledger.db is `derived-cache` / machine-local by design (each machine scans its own
transcripts). Retention is per-machine; no replicated state. Safe on single- and multi-machine.

## 8. Rollback cost

Trivial: the feature is dark (default false), so reverting is removing an unused code path. An
operator who enabled it sets `enabled:false` to stop pruning (already-deleted rows are
re-derivable from transcripts within their own retention). The auto_vacuum pragma is harmless
(no-op on existing files).

## Evidence pointers

- `tests/unit/token-ledger-retention.test.ts` (3): prunes-old/keeps-new; no-op-when-disabled;
  batched prune reports `more` + a follow-up call drains the rest. (CI-run: better-sqlite3 ABI
  is rebuilt for CI's Node; these can't execute in a dev worktree on a mismatched Node — the
  existing token-ledger.test.ts has the same constraint.)
- `tests/unit/token-ledger-poller-retention.test.ts` (3, run locally with a fake ledger): prunes
  on the sub-cadence not every scan; drains a backlog while `more`; a prune error is reported and
  never throws out of the tick (fail-open).
- Existing `token-ledger-poller-idle.test.ts` (3) still green → no regression to the cadence.

## Conclusion

Caps the biggest disk hog (256MB token-ledger) with a dark-by-default, batched, non-blocking,
fail-open retention prune driven off the existing poller cadence. Zero behavior change until an
operator opts in. Ship.
