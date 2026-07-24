# Side-Effects Review — adopt-secure-random

## Change

Replace `Math.random()`-derived credential generation with `node:crypto` CSPRNG
calls at every credential-generation site:

- `src/commands/server.ts` — dashboard PIN regeneration (4 sites) → `randomInt(100000, 1000000)`; auth-token generation → `randomBytes(16).toString('hex')`. (Adopted from external PR #1587, author Marceli Pawlinski, authorship preserved via cherry-pick.)
- `src/monitoring/CoherenceMonitor.ts` — token generation → `randomBytes` (same adoption).
- `src/core/PostUpdateMigrator.ts` — the one site #1587 missed: auto-generated dashboard PIN on migration → `crypto.randomInt(100000, 1000000)`.

## Behavior preserved

- PIN semantics identical: `randomInt(100000, 1000000)` yields exactly the 6-digit
  range 100000–999999, matching `Math.floor(100000 + Math.random() * 900000)`.
- Token length identical: `randomBytes(16).toString('hex')` = 32 hex chars, same
  shape as the prior 32-char output.
- No format, storage, or consumer change: every reader of `dashboardPin` /
  `authToken` sees the same shape.

## Blast radius

- Values only become unpredictable (the point of the fix). No API surface, config
  schema, or message format changes.
- `crypto.randomInt` throws only on invalid ranges; the ranges here are constant
  and valid. `randomBytes(16)` failure modes (entropy exhaustion) are the same
  class Node itself depends on at startup.
- Migration path: the migrator PIN site runs only when `dashboardPin` is absent
  and `authToken` present — the exact prior trigger. Existing PINs are untouched.

## Not affected

- No test fixtures encode specific PIN/token values derived from Math.random.
- Remaining `Math.random()` uses in src/ are non-credential (tmp-file suffixes,
  spawn ids, store record ids) — reviewed and deliberately left.
