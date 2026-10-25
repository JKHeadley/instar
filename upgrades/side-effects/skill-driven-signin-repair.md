# Side-Effects Review — skill-driven sign-in repair (an agent session signs in like a person)

**Version / slug:** `skill-driven-signin-repair`
**Date:** `2026-09-25`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see "Second-pass review" below)`

## Summary of the change

This implements `docs/specs/skill-driven-signin-repair.md` (converged, approved by Justin on 2026-09-25). On macOS, with `subscriptionPool.assistedRelogin.navigation: agent-session`, the repair's browser step is handed to ONE short-lived headless agent session that follows `/subscription-signin` section 3. The server arbitrates everything else.

New files:
- `src/core/SubscriptionReloginHelper.ts`: the seat lease, the per-episode token, the code route handler, the wait, the cap and the kill.
- `src/core/CliLoginStatus.ts`: `codex login status`, with a fail-able canary.

Touched files:
- `SubscriptionReloginOrchestrator.ts`: the pre-attempt hook, the approval extension, and the `agent-sign-in-unfinished` mapping.
- `SubscriptionReloginStore.ts`: `extendApproval`, the `approved → waiting-operator-only` transition, two failure classes, the `phone-tap` kind, the attempt-keyed delivery key, and per-attempt notice reset.
- `SubscriptionReloginService.ts`: detached tick, phone-tap branch, `flushNotifications`.
- `SubscriptionReloginRuntime.ts`: agent-session composition, forced approval, helper-seat pick, the Codex live-read arbiter, and the production helper ports plus route context.
- `SessionManager.spawnSession`: the new `accountPin`.
- `QuotaPoller.ts`: the detailed live Codex read, the CLI-signed-out rule, `loginCheck`, and no rollout-restore.
- `codexLiveRateLimitReader.ts`: the detailed read that tells `auth-failed` from `unavailable`.
- `SubscriptionLoginLedger.ts` and `SubscriptionReloginPolicy.ts`: the new actionable cause `cli-signed-out-auth-refused`.
- `routes.ts`: the code route, and `loginCheck` on `GET /subscription-pool`.
- `middleware.ts`: bearer exemption and no-CORS for exactly the code path.
- `server.ts`: composition and notices.
- `dashboard/subscriptions.js`: **Sign in** while a repair waits on the operator.
- `CapabilityIndex.ts`, `types.ts`.
- `templates.ts` and `PostUpdateMigrator.ts`: the CLAUDE.md bullet, and the skill "Agent-run repair" subsection plus its migration.

## Decision-point inventory

- **Getting through the sign-in pages** — modify (new path) — `judgment-candidate`. Floor: the four hard lines in the fixed prompt and skill, the per-keystroke focus check, the 15-minute cap, one helper per machine, and server-only success. Arbiter: `verifyIdentity` plus authenticated use. Default: stop and hand off. Ladder: operator-only, then the phone **Sign in** cell.
- **Episode success** — pass-through — `invariant`. Unchanged arbiter. The helper's word never counts. It can only resolve the in-memory wait with a code, which paste-back and the arbiter then check.
- **Which account runs the helper** — add — `invariant`. Any healthy account on this machine, never the repaired one, explicitly pinned. None ⇒ `no-healthy-seat`.
- **Approval on this path** — add — `invariant`. Forced to `approval` (in admission, via `effectiveMode`).
- **Breaker** — pass-through — `invariant`. The helper path never emits the driver's page-rule classes, so only server-verified `wrong-identity` opens the 24-hour lockout. Other failures count toward the existing 3-in-24h threshold.
- **Pool status for Codex** — modify — `invariant`. A live read is required for `ok`, and the rollout file never restores `active`. The new two-consecutive-poll CLI + auth-refused rule goes through the ledger's explicit `transition-to-needs-reauth` outcome.
- **Code route admission** — add — deterministic auth (loopback, token hash, live helper, strict body). This is a security guard on an authority seam, not a competing-signals judgment.

---

## 1. Over-block

- The code route refuses a non-loopback `Host`. A helper that used `http://<lan-ip>:port` would be refused. The prompt renders `http://127.0.0.1:<port>`, so a helper following it is never refused.
- A Codex account whose CLI check is **unprovable**, because the canary found `codex login status` saying "logged in" for an empty home, is never eligible as a helper seat. That is deliberate: an unprovable check proves nothing. The effect is at worst `no-healthy-seat`, and the operator gets the phone Sign-in link.
- A helper seat is refused when its just-in-time read says ≥100% on a window. A nearly-walled but usable account could still serve a 15-minute helper, but choosing a walled seat risks a mid-drive rate limit. That is an acceptable trade.
- A queued approval still expires 60 minutes after the operator's tap, even if the machine seat stayed busy that long. That is the spec's cap. The operator re-taps.

## 2. Under-block

- **Trusted-operator residual (named in the spec).** The helper has ordinary agent-session trust: shell, vault, and the dashboard PIN on disk. A prompt-injected page could misuse it. The bounds are the four hard lines, the 15-minute cap, server-only success, forced approval, and the operator watching during Rung 2. Nothing in code prevents the helper's intermediate clicks or keystrokes. That is the operator's explicit FD2 choice.
- `cliclick` clicks by screen position, so a click can hit another window. The focus check guards keystrokes, not clicks, and focus can change between the check and the typing. Both are named residuals.
- The session transcript contains the verification URL, the code (single-use, short-lived) and the per-episode token. The token is also on the helper's command line (`claude -p <prompt>` / `codex exec <prompt>`), so it is visible to same-user `ps` and may appear in session logs. Same-user processes are already trusted with far more (vault, PIN). The token dies when the drive ends and only works on loopback while that helper is alive.
- **What the Codex canary proves.** It proves `codex login status` can say "Not logged in" (credentials absent). It does NOT prove the CLI detects a revoked or expired token while `auth.json` is still present. So a CLI "signed-in" is never used alone: the helper-seat pick also needs a live app-server read. The needs-reauth rule needs the live read refused as unauthenticated AND the CLI saying signed out. An account with a revoked token and `auth.json` still present, where the CLI keeps saying "Logged in", therefore stays `active` with `loginCheck: 'unavailable'` (visible, not silent) until a live read or a repair resolves it. That is a named residual. A FAILED canary (a boot timeout) is retried after 10 minutes, so it never disables the rule until restart.
- The two-poll rule requires the agreeing polls to be at least 5 minutes apart, so on-demand polls seconds apart cannot satisfy it.
- Correlated expiry, when every account on a machine is signed out at once, means no helper. That is covered by `no-healthy-seat` and the phone Sign-in cell.

## 3. Level-of-abstraction fit

- **Arbitration** lives in the orchestrator and its ports, exactly where the existing driver path lives. The helper module is a sibling implementation of the `driveBrowser` port plus a pre-attempt port. It adds no new state machine.
- **Pool health** lives in the existing `QuotaPoller`, which already owns the `transition-to-needs-reauth` outcomes.
- **The Codex CLI check** is a small injectable module shared by the poller and the seat pick.
- **Spawning** goes through the existing `SessionManager.spawnSession` headless lane (the same path jobs use), with one new, validated option. There is no second spawn path.

## 4. Signal vs authority compliance

- [x] No — this change produces a signal consumed by an existing smart gate.
- [x] No block/allow surface on the judgment side: the helper's output is a signal (a code, or a request for the operator). Authority stays with the deterministic arbiter.

The helper has no authority over episode success. The code it posts is a signal consumed by paste-back and then by `verifyIdentity` and authenticated use.

The code route's checks (loopback, token hash, live helper, strict body) are authentication of a caller, not a brittle content classifier holding blocking authority.

The Codex `needs-reauth` rule requires two independent measured signals to agree on two consecutive polls, through the existing ledger outcome. A single brittle signal never flips status. A transport failure never counts, and disagreement leaves the status unchanged.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals decision point. The competing-signals point, getting through arbitrary sign-in pages, moves FROM a static page-rule table TO judgment (the helper session) within declared floors. The spec's `## Decision points touched` declares the floor, the arbiter, the default and the ladder.

Several new deterministic pieces are invariants or safety guards, not judgment points: the lease, the capacity check, the helper-seat health, forced approval, and the body union. The canary-proven CLI check is an evidence floor.

## 5. Interactions

- **Seat lease.** It is shared with the legacy driver and the Playwright MCP operator seat (`~/.instar/state/playwright-seat-lease.json`), host-wide. While a helper holds it, a Playwright MCP drive on the same host waits, and the reverse holds too. That is intended: one browser operator per machine. It is renewed every 2 minutes and released in `finally` on every exit, and its TTL reclaims it after a crash.
- **Detached tick.** `tick` no longer awaits `runEpisode`. `inFlight` still prevents double starts, and `runEpisode` now catches its own errors (a version conflict), so a detached run can never become an unhandled rejection. Notices are drained after every run, not only after a terminal one. Claims are atomic, so a concurrent drain never double-sends. Existing tests that relied on `tick` awaiting a run still pass, because they use `vi.waitFor` or `approve()`.
- **Delivery keys.** They now end in `:<attemptCount>` (plus `.<n>` for a second operator-only entry within one attempt, whose delivered predecessor is replaced, so a later reason is never silently dropped), and the attention-item id is derived from them. A suggested notice is `…:suggested:0`. Rows already queued under an old-format key are delivered once under their stored key, and nothing is re-sent. A notice re-inserted for a later attempt is no longer de-duplicated away. That is the spec's intent.
- **Restart recovery.** `recoverUncertain` now kills a surviving `relogin-<id>` helper before the existing `browser-driving` recovery runs. Boot also kills orphan `relogin-*` sessions. A helper posting after a restart gets 409, because no live entry exists.
- **Rollout snapshot.** It no longer restores `needs-reauth → active`. The only other paths to `active` are a live read or a verified repair.
- **`codexLiveQuota: false`.** With the live read disabled, Codex login health cannot be measured: `loginCheck` shows `unavailable`, and no Codex repair could ever prove authenticated use. So Codex episodes are refused at admission with the named reason `codex-live-read-disabled` (`codexLiveReadAvailable` in the runtime), instead of burning attempts on `verification-failed`. The rollback is re-enabling the live read. A needs-reauth Codex account stays `needs-reauth` until then, and the operator can still sign it in from the dashboard.
- **Session reaper and caps.** The helper is a normal headless session. It counts toward `maxSessions` (the pre-attempt capacity check reads the same count) and is subject to `maxDurationMinutes`. It is not a job and not topic-bound, so it is never revived by the resume queue, which covers topic/job sessions only.
- **Headless reroute.** Under `subscriptionPath.mode: force`, the headless spawn reroutes to the interactive lane. `accountPin` is honored there too, because that lane now prefers the explicit pin over the resolver.

## 6. External surfaces

- **New route:** `POST /subscription-relogin/:episodeId/code` (loopback, token-authed, no CORS). Every other `/subscription-relogin/*` route still needs the bearer token, and the integration test pins that.
- **`GET /subscription-pool`** gains a `loginCheck` field per account. This is additive, and peers' rows carry it through the `?scope=pool` fan-out.
- **Notices.** A new URGENT `phone-tap` attention item. New operator-only text for `no-healthy-seat` and for a named macOS permission. All notices now carry the dashboard Subscriptions link.
- **Other processes.** The helper is a real session that runs `screencapture`, `cliclick` and Apple Events against the account's own Chrome profile. Only the Chrome it opens is touched (hard line 4).
- **Operator surface (Mobile-Complete).** Every operator action is phone-completable. The existing Repair / Try again / Cancel buttons stay. The new **Sign in** button appears while a repair waits on the operator, and every notice carries the dashboard link. The one macOS Allow is inherently at the machine, and the notice names it exactly.

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes. A waiting cell shows its status line ("Sign-in needs your help."), then the existing Cancel repair button, then **Sign in**. Both are plain buttons, visible on arrival.
2. **Zero raw internals?** Yes. There are no ids or enums on the surface. The notices name the permission in plain words ("Screen Recording").
3. **Destructive actions de-emphasized?** Cancel repair keeps its existing styling (`sub-matrix-repair-cancel`). **Sign in** uses the constructive `sub-matrix-setup` style. Cancel still renders first, because that ordering is the existing cell layout. A reorder would change the shared cell for every repair state, so it was left alone.
4. **Plain language + phone width?** Yes. It reuses the existing matrix cell components, which are already phone-verified, and adds no new layout.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **The helper, its Chrome window, the code wait, the token and the lease** are machine-local BY DESIGN: `physical-credential-locality`. The profile's cookies and the CLI login live on that machine's disk, and the lease file is host-wide.
- **Episode rows** are proxied-on-read through the existing `GET /subscription-relogin?scope=pool`.
- **`loginCheck`** is proxied-on-read through the existing `GET /subscription-pool?scope=pool` fan-out. Each machine reports its own poller's verdict.
- **Peer-cell actions** (Repair / Try again / Cancel) are already relayed by signed mandate. The new **Sign in** button reuses the existing start-cell flow, which is already pool-aware.
- **Notices** go out from the owning machine only, and the notification store is per machine. There is one voice per episode.
- **URLs.** Notices prefer the tunnel URL and fall back to the local link. The code route is deliberately loopback-only and never crosses machines.

## 8. Rollback cost

- **Behavior.** Set `subscriptionPool.assistedRelogin.navigation` to `agent` or `closed`. The next boot uses the existing driver. No table or column was added, and all store changes are additive.
- **An older binary** can still cancel `waiting-operator-only` rows. It never writes the new failure classes, and it rejects them only on write. Its notice drain sends an undelivered `phone-tap` row once to the terminal handler: a degraded notice, and a rollback-only artifact.
- **Pool health rules** are code-only. Reverting restores the rollout-restore behavior. There is no persisted state beyond pool `status`, which the next poll re-derives. The `cli-signed-out-auth-refused` cause rows in the ledger stay valid history, and an older binary's list does not include that cause. Ledger reads coerce rows and do not validate the cause (verified: validation happens on write only).

## Added defect fix: an open repair outlived the problem (operator-found, 2026-09-25)

On the Laptop, justin@'s Claude cell showed "Sign-in needs your help / Cancel repair" for hours after the account had been signed in by hand and verified. Its episode (`waiting-operator-only`, `permission-expansion`) was never closed, because the service only runs runnable states, and nothing closed a repair whose cell became healthy by another path.

- **Fix.** On every tick, `SubscriptionReloginService.closeResolvedElsewhere` closes any PRE-DRIVE episode (`suggested`, `approved`, `waiting-operator-only`) that this process is not driving and whose cell the server has verified healthy. Verified healthy means: pool `active`, `identityDrifted !== true` (the poller reconciles the credential's identity), and this process's latest poll was an authenticated read (`loginCheck === 'ok'`). The close goes through the store's own audited transition, `SubscriptionReloginStore.resolveElsewhere`: to `cancelled`, with failure class and event class `resolved-elsewhere`. It is never a raw delete.
- **Accounting.** The close counts as neither a repair success (graduation evidence counts `succeeded` only) nor a failure (the breaker counts `failed`/`refused` only).
- **Notice.** The terminal notice says, at NORMAL priority, that the account is signed in again and the repair was closed.
- **Over-block check.** An episode being driven right now is never closed; its own arbiter decides. Mid-repair states (`cli-finishing`, `identity-verifying`, `auth-verifying`) are never closed either (second-pass finding): the repair's own `finalizeSuccess` makes the cell healthy while it waits on `authority-closure-pending`, and closing it would record a real success as cancelled or skip the wrong-identity quarantine. Trade-off: closing a `waiting-operator-only` episode left there by `uncertain-external-outcome` gives up that attempt's possible success evidence. The account is healthy either way, and graduation simply needs another verified repair. An account that reads `active` without a verified read in this process (`loginCheck` unavailable) is left open.
- **Tests.** Unit: `subscription-relogin-service.test.ts` (closes a verified cell, leaves an unverified one and an in-flight one, idempotent, no evidence or breaker effect). Integration: `subscription-relogin-agent-session.test.ts` (the full Laptop sequence).

## Code-vs-spec differences (the code wins on facts; the spec's intent is followed)

1. **`claude auth status` is never used.** On 2026-09-25 Dawn measured `claude auth status` reporting `loggedIn: true` for expired, unrefreshable sessions; it only shows that a credential file exists. The coordinator relayed the correction. So for Claude, both the helper-seat health and the pool login signal are the authenticated OAuth usage read the poller already makes. The two-consecutive-poll CLI rule applies to Codex, where `codex login status` really says "Not logged in". Claude's sign-out path stays the existing exchange-corroborated refresh failure. The identity the credential answers as (the wrong-account state) stays with the poller's existing identity reconciliation and `verifyIdentity`.
2. **"A live verdict is meaningful only when the check has been proven able to fail."** `CodexLoginStatusChecker` runs a canary against an empty `CODEX_HOME` first. Only if the CLI says "Not logged in" there does it trust any "Logged in" answer; otherwise every verdict is `unavailable`. The Claude OAuth read is inherently fail-able (401/403).
3. **The helper is headless.** It runs `claude -p` or `codex exec` through `spawnSession`, so it exits when done ("follow section 3, then stop"), with no project MCP. The spec says "session" without naming a lane.
4. **The code route is bearer-exempt** at exactly `POST /subscription-relogin/<id>/code`. The token (header `X-Relogin-Helper-Token`) is the auth, like Secret Drop's URL token. The spec says "It needs the episode token". A bearer token alone would not identify the episode's helper.
5. **The new cause class `cli-signed-out-auth-refused`** is added to the ledger and to the repair's actionable causes, with corroboration `exchange-corroborated`: two independent signals agreeing twice. Without it, an account moved to `needs-reauth` by the new rule could never be repaired, because admission requires an exchange-corroborated actionable cause.
6. **Approval extension.** Each waiting tick pushes the approval expiry to `now + 5 min`, capped at 60 minutes after the tap. The spec fixes the cap, not the step.
7. **The drive event class** is `agent-session-drive-started`, so the audit names the driver, like `agent-drive-started`.
8. **The phone-tap notice** is delivered at once through `flushNotifications`, because it is time-bound, and at URGENT priority.

## Conclusion

The review found two design points and resolved both:
- **The ledger cause.** It had to be repair-admissible, or the pool-health rule would strand accounts; it now is.
- **The reroute lane.** It had to honor the explicit pin; it now does.

The Dawn correction on `claude auth status` is applied throughout. It is not used as a health or success signal anywhere in code, and the skill text in #2075 was corrected the same way. The change is additive, dark off macOS, approval-forced, and reversible with one config value. It is clear to ship pending the second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read-only), 2026-09-25
**Independent read of the artifact: concern → resolved**

The reviewer confirmed:
- success stays server-only;
- the bearer exemption is scoped to exactly `POST /subscription-relogin/<id>/code`;
- the route's loopback, Host, CORS and token checks are sound;
- the lease is released and the helper killed on every exit path;
- waiting spends no attempt, within the 60-minute cap;
- `claude auth status` is used nowhere.

Its concerns and their resolutions:
- **The skill subsection and migration were missing, and depended on #2075.** Resolved: the "Agent-run repair" subsection and `migrateSubscriptionSigninAgentRun` are added on top of #2075's section 3. The subsection tells the helper to post ONLY to the code route and never to touch the enroll, complete or reissue routes, which settles the conflict with the by-hand steps.
- **The canary proves less than claimed, and a failed canary was cached forever.** Resolved: the narrower guarantee and the revoked-token residual are now stated in §2, and a failed canary is retried after 10 minutes (test added).
- **With `codexLiveQuota:false`, Codex repairs could never succeed.** Resolved: Codex is refused at admission as `codex-live-read-disabled` (integration test added), and §5 is corrected.
- **Claude `loginCheck` could read a stale `ok`.** Resolved: every no-read path (network failure, unresolvable token, absence, non-auth error status, refresh-write skipped) now sets `unavailable` (test added).
- **A repeated operator-only reason within one attempt was dropped.** Resolved: the delivered predecessor is replaced under a distinct key (test added).
- **The token is on the command line.** Named in §2.
- **The `D${'ELETE'}` split.** This is the existing SubscriptionReloginStore convention; every delete in the store is written this way. The new delete follows it and stays inside the store's own transaction.
- **A lapsed approval could be revived by a waiting tick.** Resolved: the wait branch now checks for a lapsed approval before extending (test added).
- **The two-poll rule had no minimum gap.** Resolved: the polls must be at least 5 minutes apart (test added).

Round 2 (the reviewer re-read the rebased worktree): all seven fixes above were confirmed. One new concern was raised about the added resolved-elsewhere close, which could close the repair's own verified success while it waited in `auth-verifying`. Resolved: the close is restricted to pre-drive states, and a test was added for the `auth-verifying` / `authority-closure-pending` case. Final verdict: concur after this fix.

---

## Evidence pointers

- Live probe (Mac Studio, 2026-09-25): an empty `CODEX_HOME` returns "Not logged in" (exit 1). The app-server `account/rateLimits/read` returns `-32600 "codex account authentication required to read rate limits"`.
- Tests: the unit, integration and e2e files listed in `upgrades/next/skill-driven-signin-repair.md` → Evidence.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action` (this change adds a spawn under an existing self-triggered controller).
- **`closure`** — `guard`.
- **`guardEvidence`** — `ratchet`: `tests/unit/self-action-convergence.test.ts` covers the registered controller `subscription-relogin-redrive` (in `SubscriptionReloginService.ts`).
  - **How it bounds this path:** every helper spawn happens inside a counted attempt, `approved → cli-starting` with `incrementAttempt`. The attempt budget is durable (maxAttempts 3, capped at 5) and survives restart. A waiting episode (seat busy or capacity full) spends nothing and spawns nothing. The approval that keeps it waiting is hard-capped at 60 minutes. `inFlight` plus the lease allow at most one helper per episode and per machine.
  - **Steady-state bound:** ≤3 helper spawns per episode. **Settling brake:** the terminal `failed` state plus the existing 3-in-24h breaker.
