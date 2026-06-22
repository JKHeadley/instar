# Side-Effects Review — Credential keychain read: async + timeout-bounded

**Slug:** `credential-keychain-async-read` · **Tier:** 1 (focused bug fix, no spec; rigorous
root-cause diagnosis via a live `/usr/bin/sample` of the running server). Parent principle:
**Structure beats Willpower** — the same "never block the event loop" guarantee the tmux
Event-Loop Resilience fix made structural, applied to the second blocking call site it didn't cover.

## Summary of the change

The macOS keychain credential read in `OAuthRefresher.ts` (`defaultCredentialStore.read`) was a
SYNCHRONOUS `execFileSync('security', …)` with NO timeout, on the event loop. The credential-audit
hot path — `CredentialLocationLedger.auditIdentities()` → loops sequentially over all 5 claude
account slots → `await CredentialIdentityOracle.resolveSlotTenant()` → `readClaudeOauth()` → that
sync `security` spawn — froze the whole event loop 4–13s every ~30–65s under multi-agent `securityd`
contention, dropping the dashboard websocket (user-visible flapping) and false-firing the
SleepWakeDetector (~0-CPU I/O-wait). This adds an async `readAsync` (promisified `execFile`,
3s-timeout) used on the hot path (`resolveSlotTenant` awaits it → each slot read yields the loop),
plus a `timeout: 3000` on the remaining sync `read`/`write` for any non-hot-path caller. The sibling
`monitoring/CredentialProvider.ts` already set `timeout:10000`; OAuthRefresher was simply missed.

## 1. Behavioral equivalence / correctness

`readAsync` mirrors the sync read's args + null-on-error semantics exactly; `readClaudeOauthAsync`
reuses the identical parse and falls back to the sync `read` for any store without `readAsync`
(the interface method is OPTIONAL, so all existing `CredentialStore` mocks compile unchanged). The
only consumer switched to the async path is `resolveSlotTenant` (already an `async` method awaited by
the audit loop) — verified nothing after the read assumes synchrony (only `oauth?.accessToken` is
used). 83/83 tests across the credential suites green, including a deferred-promise test proving
`resolveSlotTenant` does not resolve until the async read resolves (it genuinely awaits the async
path, not the sync read).

## 2. Failure modes / fail-safe

Every error path returns `null` (unreadable → caller falls to needs-reauth, retried next cycle) —
identical to the prior sync behavior. A 3s timeout now bounds a wedged `securityd` instead of an
unbounded block: a timeout maps to `null` (needs-reauth) exactly like a missing entry. The async
`execFile` buffers stdout/stderr (the `stdio` option is dropped on the promisified overload — stderr
is captured-then-ignored, matching the sync read's `stdio:['ignore','pipe','ignore']`).

## 3. Blast radius

Two files of behavior (`OAuthRefresher.ts`, `CredentialIdentityOracle.ts`) + a one-line comment in
`QuotaPoller.ts`. `QuotaPoller.defaultTokenResolver` stays sync by design (a single periodic read,
now timeout-bounded — making it async would ripple through `SubscriptionAccount` token resolution
for no benefit). No write-path semantics change (only the timeout bound is added). No credential
VALUE ever leaves the funnel; no new external surface.

## 4. Interactions

Complements the tmux Event-Loop Resilience fix (v1.3.643): that fix took the SYNC TMUX calls off the
loop; this takes the SYNC KEYCHAIN call off the loop. Together they remove the two periodic
event-loop blockers that caused the dashboard "disconnected" flapping. The async read also removes
the SleepWakeDetector false-wakes (no ~0-CPU block → no misread as sleep), so the spurious
wake-recovery cascade this triggered stops.

## 5. Rollback

Revert the 2 source files. The change is additive (a new optional interface method + an async
function) plus a one-line switch in `resolveSlotTenant`; the sync `read` remains the fallback, so a
partial revert (keeping only the `timeout: 3000` bound) is also safe.
