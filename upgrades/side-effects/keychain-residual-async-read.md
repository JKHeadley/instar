# Side-Effects Review — Keychain residual: the remaining timer-driven sync keychain reads → async

**Slug:** `keychain-residual-async-read` · **Tier:** 1 (focused low-risk bug fix, no spec; completes
the keychain class of the dashboard event-loop freeze that the first fix opened). Parent principle:
**Structure beats Willpower** — the same "never block the event loop" guarantee, applied to the three
remaining timer-driven sync keychain call sites the first fix (PR #1248) did not cover.

## Summary of the change

The first keychain fix (PR #1248, merged as `e14d8ead4`) took the credential-audit hot path's
synchronous `security` keychain read off the event loop. A live `/usr/bin/sample` of the running
server then found THREE MORE timer-driven synchronous keychain call sites still freezing the loop —
all on the QuotaManager / QuotaPoller poll path, which runs every ~60s (and as often as every ~10s at
the critical quota tier). This converts those three to async (promisified `execFile`), completing the
keychain class:

1. **`KeychainCredentialProvider.readCredentials`** (`src/monitoring/CredentialProvider.ts`) — was a
   synchronous `execFileSync('security', …)` on a method already declared `async` (callers already
   `await` it, so the sync call made the `async` a lie). Driven by the QuotaManager collection-cycle
   timer (60s, down to 10s at the critical tier — the source of the longer freezes). Now
   `await execFileAsync(...)`, SAME args + SAME 10s timeout + SAME null-on-error semantics.
2. **`QuotaPoller.defaultTokenResolver`** (`src/core/QuotaPoller.ts`) — the per-account periodic
   keychain read inside `pollAll`. Was sync `readClaudeOauth`; now `await readClaudeOauthAsync` (the
   async read the first fix already added). `pollAccount` now `await`s the resolver; the `TokenResolver`
   type widened to `string | null | Promise<string | null>` so a sync test stub stays valid.
3. **`OAuthRefresher.refreshClaudeToken`** (`src/core/OAuthRefresher.ts`) — the read-merge-write on the
   401 refresh path issues a keychain READ and a keychain WRITE per cycle. The read now prefers the
   existing async `readAsync`; a NEW optional `writeAsync` (promisified `add-generic-password`, same
   3s timeout, same false-on-error semantics) is preferred for the write. Both fall back to the sync
   `read`/`write` for any store that doesn't implement the async variant (test mocks).

## 1. Behavioral equivalence / correctness

Each async variant mirrors its sync sibling's args, timeout, and null/false-on-error semantics
exactly. `readCredentials` keeps its identical JSON parse (now over `stdout`). `defaultTokenResolver`
keeps the identical `sk-ant-oat` prefix check. `refreshClaudeToken`'s async read/write are gated on
the OPTIONAL interface methods (`store.readAsync ? … : store.read`, `store.writeAsync ? … : store.write`),
so every existing `CredentialStore` mock that implements only the sync methods compiles AND runs
unchanged. 258 tests across the affected suites green (28 in the three targeted files), tsc clean,
lints clean.

## 2. Failure modes / fail-safe

Identical to the sync paths. A keychain read that fails or times out returns `null` → the caller falls
to needs-reauth / no-snapshot-this-cycle, retried next cycle. A `writeAsync` failure returns `false` →
`refreshClaudeToken` already maps a failed write to `write-skipped` (NOT needs-reauth — the exchange
succeeded and the still-valid credential is untouched). The `funnel.withSlotLock` per-slot lock still
serializes the write against a concurrent swap/refresh on the same slot regardless of sync vs async.

## 3. Blast radius

Three source files (`CredentialProvider.ts`, `QuotaPoller.ts`, `OAuthRefresher.ts`) + their three test
files. No credential VALUE ever leaves the funnel; no new external surface; no write-path SEMANTICS
change (only the off-loop execution + the new optional `writeAsync` method). The `TokenResolver` type
widening is backward compatible (a sync resolver is still accepted). The non-darwin `writeAsync` branch
uses `fs.promises` with the same `0o600` mode + recursive mkdir as the sync `write`.

## 4. Interactions

Completes the keychain leg of the dashboard event-loop-freeze work begun by the tmux Event-Loop
Resilience fix (v1.3.643) and the first keychain fix (PR #1248). Those took the SYNC TMUX calls and the
credential-AUDIT keychain read off the loop; this takes the remaining QUOTA-POLL keychain reads + the
refresh read-write off the loop. There is ALSO a separate, NON-keychain residual freeze (a large-JSON
file read) still being addressed independently — this PR does not touch it.

## 5. Rollback

Revert the three source files. The change is additive (one new optional interface method `writeAsync`,
one promisified `execFile` per call site, a widened union return type) plus the sync paths retained as
fallbacks — so a partial revert that keeps any single async conversion is also safe.
