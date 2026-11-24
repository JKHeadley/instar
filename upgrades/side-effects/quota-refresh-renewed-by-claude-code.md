# Side-Effects Review — refused token refresh re-reads the slot before needs-reauth

**Version / slug:** `quota-refresh-renewed-by-claude-code`
**Date:** `2026-11-24`
**Author:** `echo (account-compliance-loop job)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

`src/core/QuotaPoller.ts`, `pollAccountInner`, Claude usage path. When a usage read answers 401/403 and the refresher returns `exchange-failed`, the poller now reads the slot's stored token once more (`readRenewedByOtherWriter`). If that token differs from the token that was refused and the usage read accepts it (not 401/403), the account is kept and the reading is used as this cycle's body. Otherwise the poller makes today's needs-reauth decision unchanged. Network failure on the extra read is reported as `network` (no status change). The extra step uses only the existing injectable `tokenResolver` and `readUsage`; it never refreshes and never writes the credential store. The successful-refresh branch was restructured into an `else` without behaviour change. New test file: `tests/unit/quota-poller-renewed-by-official-app.test.ts` (6 cases).

Tier 1 declared: one source file, about 90 lines changed, read-only addition, fully undone by a revert. The gate may raise the risk floor because the path concerns credentials; the reason for Tier 1 is that the change adds no credential write, no new provider call type, and no new authority. Effort: no spec rounds; one review pass (second-pass subagent).

## Decision-point inventory

- `QuotaPoller.pollAccountInner` → needs-reauth on `exchange-failed` — **modify** — now requires that the slot was not renewed by another writer with a token the provider accepts.
- All other needs-reauth paths (`no-refresh-token`, `read-failed`, `malformed-response`, `write-failed`, `still-authfailed-after-refresh`, unparseable blob, CLI-login-expired corroboration) — **pass-through**, unchanged.

---

## 1. Over-block

The decision being changed marks accounts needs-reauth, which removes them from placement and polling. The change only narrows it. No legitimate input becomes newly marked. Over-block not applicable beyond: none identified.

---

## 2. Under-block

- A real dead login whose slot holds a different token that the usage endpoint still accepts can only happen if the token is in fact live. The usage endpoint's acceptance is the provider's own statement, so that is not a dead login.
- If the renewed token answers a non-auth error (for example 429 or 5xx), this cycle records no reading and leaves status unchanged. If the login were actually dead, the next poll reads that same token. A 401 then goes through the refresh path again, and the provider refuses the old renewal code. The re-read then finds the same token and marks needs-reauth. Detection is delayed by at most one poll interval (about 15 minutes).
- Remaining gap: if the provider revokes the whole token family when a used refresh token is reused, our refused exchange may also kill Claude Code's renewed login. The re-read then finds a refused token and needs-reauth is marked, which is correct, but our refresh caused it. This fix cannot prevent that. Leaving refresh to Claude Code entirely is the larger change tracked by CMT-2225.

---

## 3. Level-of-abstraction fit

Right layer. The poller owns the needs-reauth decision for usage reads. It already owns the token resolver and the usage read, and the refresher already reports `exchange-failed` as a typed reason. `OAuthRefresher` stays a pure exchange-and-write primitive. Putting the re-read there would mix the usage read into the credential writer.

---

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface.

It narrows an existing deterministic state transition, and only on positive evidence from the provider: the usage endpoint accepted the stored token. It adds no new authority and no brittle blocking check.

---

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The added condition is an invariant: a token the provider accepts is a live login.

---

## 5. Interactions

- **Refresher / credential write funnel:** not called a second time. There is no added write, so there is nothing new to serialize.
- **Login ledger (`observe`):** a recovered account emits no `transition-to-needs-reauth`, so no episode opens and no repair is suggested. Before the change, the next scheduled poll (which still reads needs-reauth accounts) would restore the account after about 15 minutes, but the false episode and repair suggestion were already raised. Preventing those is the intended effect. The unchanged paths still emit as before.
- **Fingerprint (`lastFingerprint`):** updated to the renewed token, the same thing a normal poll of that token would record. Stale-process and pane-login checks compare against the current stored credential, which is now correct.
- **cliLoginExpiredHolds / restore logic:** the recovered body flows through the same post-read code as any successful read, so the existing hold and restore rules apply unchanged.
- **Device-limit tripwire, swap executor:** no interaction. Status is left untouched rather than changed.
- **Race with Claude Code writing the keychain during our extra read:** the read is a single keychain read with the existing async resolver. A torn or partial read resolves to a non-string and falls through to today's decision.

---

## 6. External surfaces

One extra usage read (`GET /api/oauth/usage`) and one extra keychain read, only after a refused refresh exchange. That is rare: on the order of a few times a week per pool. It is the same read the poller already makes every 15 minutes. It adds no token exchange and no write. In effect it reduces our direct token handling, because an account that stays active no longer triggers an automated browser sign-in repair. Users see fewer false "needs sign-in" alerts.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. Each machine holds its own login per account (no token is copied between machines), and each machine's poller decides for its own slot. The resulting status reaches peers through the existing pool-scope merged read of the subscription pool (`GET /subscription-pool?scope=pool`), unchanged. No status surfaces are new or changed.

---

## 8. Rollback cost

Pure code change. Revert the commit and ship a patch. No persistent state, no migration. During the rollback window the old behaviour returns: after a race, a false needs-reauth that lasts until the next poll, a false episode, and a repair suggestion.

---

## Conclusion

Clear to ship as Tier 1. The change only narrows a needs-reauth transition, and only on the provider's own acceptance of the stored token. It is read-only toward credentials and covered on both sides of the decision. The larger compliance step remains tracked in CMT-2225: stop refreshing ourselves and let Claude Code renew.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur**
The restructure leaves the successful-refresh branch identical. The new path keeps an account active only when the provider accepts a different stored token. It never calls the refresher again and never writes credentials. All 43 tests in the two poller files pass. Two minor points, neither blocking:
- The post-read hold check (`cliLoginExpiredHoldActive`) still receives the original refused `token`, not `renewed.token`. A hold fingerprinted on the old credential therefore stays active one more cycle, where it should release as "credential changed". This is conservative, because the account stays out of placement, and the existing refresh branch already behaves the same way. Passing the effective token, and setting it in a test, would make section 5's "applies unchanged" claim exact.
- A swap that writes another account's token into the slot between the first read and the re-read would make the re-read count as a recovery for this account. That window is narrow and matches the refresher's own exposure. An optional fix is to skip the recovery when `accountForReads(account)` no longer names the same home.

---

**Author resolution of the reviewer's points:**
- Point 1, the hold check using the refused token: fixed. The poller now passes `bodyToken` to `cliLoginExpiredHoldActive`. That is the token whose answer was used: the renewed token on the new path, and the original token otherwise. The refresh-success path keeps passing the original token, as before, so this change makes no behaviour change there.
- Point 2, a swap between the first read and the re-read: accepted as is. The window is a few hundred milliseconds. The existing refresher path has the same exposure. A wrong reading is fixed on the next poll, and the change writes no credential state.

---

## Evidence pointers

- `tests/unit/quota-poller-renewed-by-official-app.test.ts`: 6 pass; 5 fail against the previous `QuotaPoller.ts`.
- Unchanged and passing: `tests/unit/quota-poller*.test.ts` (7 files), `tests/unit/credential-write-routing.test.ts`, `tests/integration/subscription-quota-routes.test.ts`, `tests/integration/interactive-login-expired-recovery.test.ts`, `tests/e2e/interactive-login-expired-lifecycle.test.ts`.
- Field evidence (2026-11-24): login-ledger episodes from 2026-11-17 on Mac Studio, Mac Mini and Laptop: 8 of 12 have cause `exchange-failed`. Mac Mini `sagemind-adriana` and `justin-gmail` open with that cause.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This change is not a self-triggered controller: it adds no restart, swap, respawn, spawn, notify, retry loop or kill. The extra read is one bounded read inside an existing poll.
