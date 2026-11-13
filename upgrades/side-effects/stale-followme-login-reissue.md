# Side-Effects Review — stop re-driving a follow-me sign-in whose slot already works

**Version / slug:** `stale-followme-login-reissue`
**Date:** `2026-11-13`
**Author:** `Echo (account compliance loop, run 3)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (declared), 8 files, about 450 lines, most of them tests and docs. Effort: no spec review rounds (Tier 1); one design revision after the second-pass review; two red/green cycles.

A follow-me sign-in (a pending login with `expectedEmail` and `configHome`) was re-driven on every expiry for as long as it stayed pending. The completion sweep closes such a login only when the slot's auth revision CHANGES from a baseline, and every reissue takes a new baseline. On hosts where no auth revision is readable (Linux: the witness reads the macOS keychain, so it returns null), it never closes at all. Live evidence on 2026-11-13: five such logins across Mama PC and Mac Studio for accounts that were active, sign-in check `ok` and reading quota. One on Mama PC had been re-driven 1113 times since 2026-11-02, starting a fresh `claude auth login` in a tmux pane every 15 minutes, and showing a sign-in that nobody needed on the operator's Pending Logins surface.

`EnrollmentWizard.reissueExpired()` and `recoverAfterRestart()` take an optional `AlreadySignedInDeps` (`accountIsHealthy`, local state only). When it is given, before a **Claude** follow-me login is re-driven, two proofs are required: (1) this machine's pool already holds the account `active`, as the login's expected email, with no identity drift (no network); (2) the slot answers the identity oracle's live read (`resolveSlotTenant`, the read `completeLanded` accepts as `proof: 'live-identity'`; for a Claude slot that is `GET api/oauth/profile`) as exactly that email. Then only the stale login is marked completed. The pool is not written. Everything else re-drives exactly as before: Codex logins, unhealthy or drifted accounts, a mismatch, an unreadable slot, any error. `server.ts` passes the deps on both paths. `refresh()` (the repair runtime's dead-pane path) and the `/subscription-pool` reissue route pass nothing and are unchanged.

Revised after the second-pass review: the first version also covered Codex logins and upserted the pool to `active`. See the review section.

Files: `src/core/EnrollmentWizard.ts`, `src/commands/server.ts`, `tests/unit/enrollment-wizard.test.ts`, `tests/unit/enrollment-already-signed-in-server-wiring.test.ts`, `tests/e2e/subscription-enrollment-lifecycle.test.ts`, this artifact, the ELI16 and the release fragment.

## Decision-point inventory

- `EnrollmentWizard.reissueLogins` — modify — a new early exit before the re-drive: close the login instead of re-driving when the pool already holds the account healthy AND the slot answers live as the expected account (Claude only).
- Completion sweep `sweepFollowMeCompletions` / `completeLanded` — pass-through — unchanged (server.ts block byte-identical to main).
- Email gate `validateEnrolledAccountEmail` — pass-through — not called on the new path; the new path compares the same normalized form itself and never raises an attention item on a mismatch (it simply re-drives).
- Pool account status — pass-through — never written by the new path.

---

## 1. Over-block

No block/allow surface. The closest analogue: a login that someone still wanted could be closed. That needs the pool to already hold the account active and identity-verified AND the slot to answer a live identity read as that exact account, at a moment when the old code has expired or its pane died with the server, so nobody can paste into it. A needs-reauth account (the case where a still-valid short-lived access token could answer the live read over a dead refresh token) is not `active`, so it is never touched. If an active account's login does turn out dead later, the normal incident path marks it and opens a new sign-in.

---

## 2. Under-block

- A login whose slot holds a DIFFERENT account (identity drift) still re-drives forever. That is a real repair the operator may need to act on, so it is left alone on purpose; it is visible as identity drift in the pool.
- A login whose slot cannot be read (no credential, probe failing) still re-drives every expiry. That keeps a code ready for a real dead slot, which is the purpose of the reissue.
- Only Claude logins with `expectedEmail` (follow-me) are checked; plain enrollments keep their explicit completion. Codex follow-me logins keep the old behaviour, so a stale Codex login for a working account still re-drives. No such login exists on the pool today (2026-11-13); a fix for Codex needs a live Codex read and is left to the Codex witness path.

---

## 3. Level-of-abstraction fit

Right layer. The wizard owns the reissue loop and already holds the identity oracle and the in-flight set used by the completion sweep. The proof reused is the existing `live-identity` proof; no new detector is introduced. The pool write reuses the completion sweep's upsert rather than a second path.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It decides between two existing actions of a maintenance loop (re-drive, or complete through the existing verified path). Its evidence is the live identity read already accepted as completion proof elsewhere; every uncertainty falls back to the old action.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The rule is an invariant: the slot answers live as the expected account, or it does not.

---

## 5. Interactions

- Completion sweep: both share `completionSweepInFlight`, so a sweep and the reissue cannot both finalize one login. The new path re-reads the login after the probe and requires the same `version`, a non-terminal status and a still-healthy account, with no `await` between that check and the completion, so a login cancelled, completed or reissued during the probe, or an account that turned unhealthy, is left alone (tested).
- The reissue tick runs `reissueExpired` and `sweepFollowMeCompletions` without awaiting each other; the in-flight set covers the overlap.
- `SubscriptionReloginRuntime` drives its own repair logins through `refresh()`, which is unchanged. Its expiry is also handled by `reissueExpired`; completing such a login when the slot already works is the same outcome the repair wants. The repair episode itself is not touched by this change.
- No pool write, so no status-ledger record, no device-limit bench release and no capacity change. The account was already active.

---

## 6. External surfaces

- Pending Logins surface (dashboard/app): stale sign-ins for working accounts disappear after the next sweep or restart.
- Provider traffic: replaces one `claude auth login` start every 15 minutes per stale login (indefinitely) with one identity read (`GET api/oauth/profile`, an existing read class in the compliance ledger) per stale login, once. A genuinely signed-out account is never probed (the local health check fails first), so it costs nothing extra. Boot waits on at most one bounded read per stale Claude login of a healthy account.
- No user-facing notices are added or removed; the log gains `[follow-me] already-signed-in outcome=validated id=...`.

---

## 6b. Operator-surface quality

No operator-surface file touched. Not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** Pending logins, their panes and the slot they sign in to all live on one machine, and each machine's server runs its own sweep against its own store. Each machine closes its own stale logins; the pool-wide view (`GET /subscription-pool/pending-logins?scope=pool`) already merges them. No notices, no URLs, no new durable state (the existing login record changes status). No status surface changes.

---

## 8. Rollback cost

Revert the commit and ship the next patch. Logins completed by this path stay completed; if one was needed after all, the account's next failure opens a new sign-in through the normal incident path. No migration, no data repair.

---

## Conclusion

Narrow, reversible fix to a self-triggered loop that never converged for a login whose goal was already met. Ready to ship once the test tiers pass.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose), 2026-11-13
**Independent read of the artifact: concern**
- Codex slots are not proven live. `subscriptionIdentityOracle` is the composite oracle, and for a slot that has `auth.json` it answers from `readCodexSlotIdentity`. That reads the email out of the stored id_token on disk and makes no network call. A Codex account whose refresh token is dead (signed out, revoked, token reuse) still answers with its email. So every Codex follow-me login (device-code, `expectedEmail` set by the dashboard or by SubscriptionReloginRuntime.startOrRecoverLogin) gets completed at its first expiry, and the pool row is set `active` with no live proof. The operator's code disappears and the account is marked active while still dead. The new check runs before `completedWithoutTelling`, so it also skips the mtime guard that device-code logins had. The artifact's lines "a dead token cannot answer it" and "one identity read (`GET api/oauth/profile`)" are true only for Claude slots. Fix: limit the check to `framework === 'claude-code'`, or require a live Codex read (app-server or `codexLoginStatus`) the way the relogin runtime's verifyAuthenticatedUse does. Then add a Codex test.
- Claude path: the profile GET uses the stored access token without refreshing it. A needs-reauth account whose refresh token is dead but whose access token has not yet expired gets completed and set `active`, then fails again later. The artifact admits this (§1). It is bounded, but it flips pool status without the ledger `recordStatus` that the runtime's finalizeSuccess writes. It also clears any device-limit bench through `clearDeviceLimitOnStatusMove`.
- Cost: a follow-me login whose re-drive keeps throwing stays expired, so it is probed on every 5-minute tick, not once per TTL. At boot, `recoverAfterRestart` awaits one 10 s-bounded probe for each incomplete follow-me login before the server serves traffic. Both costs are small.
- Race handling is sound. The shared `completionSweepInFlight`, the version and status re-read through `get()` (live status), and the synchronous upsert followed by `complete()` all hold. `store.transition` completes a login whose stored status is 'pending' even when its live status is 'expired', which is correct. A repair episode whose login is completed under it still has to pass the runtime's own live use check before it reaches `succeeded`. The unit file passes (59/59).

**Author response (Echo, 2026-11-13 16:40Z):** all three points accepted and fixed in this change, not deferred.
- Codex: the path is now `framework === 'claude-code'` only; Codex logins keep `completedWithoutTelling` and the old re-drive. Test: "a Codex login is never closed by this path".
- Status flip: the path no longer writes the pool at all. It also requires the pool to already hold the account `active`, as the expected email, with no drift, so a needs-reauth account whose short-lived token still answers is never closed. Tests: "an account the pool does NOT hold healthy ... is never probed", "an account that stops being healthy while the probe ran".
- Cost: the local health check runs before any read, so a signed-out account whose re-drive keeps failing is never probed, and boot reads only for stale logins of healthy Claude accounts.
- Artifact claims corrected (Claude-only live read; no pool write).

**Reviewer re-read (2026-11-13): concur**

---

## Evidence pointers

- Live reads, Mac Studio 2026-11-13 15:57Z: `GET /subscription-pool/pending-logins?scope=pool` (5 pending, reissue counts 25, 25, 1113, 594, 324) against `GET /subscription-pool?scope=pool` (all five accounts `active`, `loginCheck: ok`, quota read within the hour); `GET /subscription-relogin?scope=pool` (Mama PC repairs for sagemind-justin and sagemind-dawn `succeeded`, their logins left pending).
- `server.ts` `authRevisionWitness` reads `defaultKeychainExec.readService`, which returns nothing on Linux, so the auth-revision completion proof is unavailable on Mama PC.
- Tests: `tests/unit/enrollment-wizard.test.ts` (13 new) and the wiring file: 6 fail on the old code for the right reason, the others prove unchanged behaviour (Codex, unhealthy account, mismatch, unreadable, throwing probe, no oracle, no expected email, no deps, health check flipping or throwing), `tests/unit/enrollment-already-signed-in-server-wiring.test.ts`, `tests/e2e/subscription-enrollment-lifecycle.test.ts` (restart path through the real route).

## Class-Closure Declaration (display-only mirror)

- **`defectClass`**: `unbounded-self-action`
- **`closure`**: `guard`
- **`guardEvidence`**: `{enforcementType: ratchet, citation: tests/unit/enrollment-wizard.test.ts "expired Claude login, healthy account, slot answers as expected → closed, no new code, loop over", howCaught: "control-loop edge: reissue tick → re-drive → new pending login → next expiry → re-drive. Steady-state bound: for a login whose slot answers as the expected account, the loop now ends after ONE identity read (the test asserts drives=0 and probes stays 1 on the next sweep). Settling brake: completing the login removes it from the expired set, so the trigger input is gone. An account that is not healthy, or a slot that does not answer as the expected account keeps the existing 15-minute TTL cadence (one re-drive per TTL), which is the pre-existing bound for a genuinely needed sign-in."}`
