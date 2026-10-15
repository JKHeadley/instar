# Side-Effects Review — Sign-in repair: unattended on the agent-session path + slow retry of failed repairs

**Version / slug:** `relogin-unattended-agent-session-and-slow-retry`
**Date:** `2026-10-15`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see Second-pass review)`

## Summary of the change

Spec: `docs/specs/relogin-unattended-agent-session-and-slow-retry.md` (converged, 8 rounds). (1) `SubscriptionReloginRuntime` no longer forces `approval` on the `agent-session` path; the admission policy decides on every path, with two added holds (a helper hard-line report since the last verified success; backup codes below `maxAttempts + 1`, or any backup-code account on the helper path). The scan now passes an incident's own re-admittable row as current, so the stuck `echo@` suggestions re-admit and run (previously they could never re-admit). (2) `SubscriptionReloginService.slowRetryDue()` slow-retries a `failed` repair whose class is on an explicit allowlist (`attempt-budget-exhausted`, `repair-time-budget-exhausted`, `agent-sign-in-unfinished`), with no operator hold, no operator-only challenge or phone tap in that run, an open incident and an unspent cap: 6 h, then 24 h, at most 3 (durable `slowRetryCount`), one per machine, after full re-admission and the self-action governor; unattended means `failed -> approved`, approval means a re-offer (`failed -> suggested`, outside 23:00-08:00). The repair's own leftover login (recorded `loginCreatedAt`) no longer blocks its retry. (3) Failed rows are no longer re-admitted on changed inputs; an operator "Try repair again" on changed inputs re-offers; an operator cancel is only ever re-offered. (4) The helper can report `{"notify":"hard-line",...}`, which moves the repair to `waiting-operator-only` / `agent-hard-line`; later reports get `409 already-settled`. (5) The account breaker counts failed runs from audit events. (6) Failure notices are held while a retry follows (bounded); notice keys carry `.rN` / `.oN`; `retryFailed` clears prior notice rows; stale terminal notices for a restarted repair are dropped. (7) A verified wrong identity whose quarantine failed now ends `wrong-identity`. (8) Dashboard next-try line, "Don't retry on its own" (cancel on a failed row = hold), held text; CLAUDE.md template + migration; CapabilityIndex; config type `slowRetry`; governor policy; self-action registry model; helper prompt lines (passkey screen, finish in the same window).

## Decision-point inventory

- `Runtime effectiveMode (agent-session path)` - modify - no longer overrides the configured mode.
- `unattendedGraduated` (policy) - modify - two added holds (helper hard-line, backup codes).
- `isSlowRetryEligible` + `challengedSinceAdmission` - add - explicit allowlist, operator hold, challenge/phone-tap since admission.
- `slowRetryDue` - add - schedule, one per machine, quiet hours (re-offers), full admission + governor.
- `suggest` re-admission - modify - never re-admits failed rows; operator-cancelled rows re-admit only as approval.
- `isBreakerOpen` - modify - counts failed/refused runs from events.
- `Helper hard-line notify` - add - can only move a repair to the operator.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- Holds can be stricter than needed: a backup-code account on the helper path is always held at approval (the stored count cannot be trusted there); one unverified helper hard-line report holds the account at approval until a verified success; a run that asked for a phone tap is never slow-retried. All reduce autonomy only, and the operator's tap still works.
- If `recordAttemptLogin` fails to write (best-effort), the repair's own leftover login blocks its retry (`pending-login-already-live`), pushed back 24 h each time: the pre-change behaviour, not a regression.
- The breaker now counts every failed run, so repeated operator retries of one row can open it sooner than before (3 failed runs in 24 h), which is the parent spec's stated intent.

---

## 2. Under-block

- A helper that hits a hard line (CAPTCHA, wrong account) and exits WITHOUT reporting it ends `agent-sign-in-unfinished` and is retried; each retry meets the same hard line and stops again, at most 3 times per incident, hours apart. Bounded and stated in the spec.
- Removing the tap for listed identities means a misbehaving helper is no longer preceded by an operator glance. The intermediate-action bound remains the skill's hard lines (not code), as in the parent spec; the server floors (other-account seat, one helper per machine, 15-minute cap, server-only success, breaker) are unchanged. This is the trade the operator chose by listing the identities.

---

## 3. Level-of-abstraction fit

Right layer. The mode decision stays in the existing pure admission policy; this change only stops a runtime-level override from shadowing it. The retry lives in the service, which already owns the tick and the unattended auto-approve; it reuses the store's state machine (one new transition `failed → suggested`) and the orchestrator unchanged. Pacing uses the existing self-action governor rather than a new limiter.

---

## 4. Signal vs authority compliance

- [x] No — this change has no new brittle block/allow surface.

The authority for "may this run without a tap" is the existing deterministic admission policy (an invariant security boundary, not a competing-signals judgment). The helper's new hard-line report is a signal that can only reduce autonomy (operator hand-off); it never counts toward success, which remains `verifyIdentity` + an authenticated call.

---

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Eligibility is an enumerable failure-class list (security classes excluded because they are breaker evidence); timing is fixed pacing; whether to act is the existing admission + governor. All classified `invariant` in the spec's Decision points table with reasons.

---

## 5. Interactions

- **Shadowing:** `slowRetryDue` runs after `closeResolvedElsewhere` in the same tick and only on `failed` rows; `closeResolvedElsewhere` only touches pre-drive states — no overlap.
- **Double-fire / concurrent writers on one row:** `suggest()` no longer re-admits `failed` rows, so `slowRetry()` is the only `failed -> suggested` path. The writers that can meet on a failed row are `slowRetryDue` (schedule / start), the operator's **Try repair again** (`retryFailed`, or `slowRetry` with `operatorRequested` when inputs changed), the **Don't retry on its own** hold (`cancel` on a failed row -> `holdSlowRetry`) and, on a `suggested` row, the in-line re-admission in `approveWithAuthority`. Every one is version-checked (and the in-line re-admission re-reads the row after its await and requires the same version and state); the loser gets a version conflict and re-reads next tick. `slowRetry` also refuses if another live episode owns the cell.
- **Races:** `slowRetry` is version-checked against the version read before `revalidate`; a concurrent operator **Try repair again** (`retryFailed`) wins or loses cleanly. `recordAttemptLogin` writes metadata without a version bump so the orchestrator's in-flight expected version is not invalidated.
- **Feedback loops:** a retried run that fails returns to `failed`; the durable cap (3) and the governor bound it; the self-action convergence ratchet models 3 attempts × (1 + 3) = 12 drives per incident, horizon-independent.
- **Breaker:** `isBreakerOpen` now counts failed/refused RUNS from `repair_events` (transitions into `failed`/`refused` from another state), so every failed slow-retry run and every failed operator-retry run counts toward 3-in-24h. With the 6 h / 24 h delays, slow retries alone put at most 2 failed runs in any 24 h window and cannot open it by themselves; operator retries can push it to 3.
- **Notices:** delivery keys gain `.rN` once `slowRetryCount > 0` so a retry's outcome is not de-duplicated against the first run's.

---

## 6. External surfaces

- Other agents / install base: only agents that enabled assisted re-login (`enabled: true`, `dryRun: false`). Unattended behavior changes only for identities the operator explicitly listed; slow retry is on by default for enabled agents (absence = on), off via `slowRetry.enabled: false`.
- External systems: a retry drives the provider sign-in pages again (Google/Claude/OpenAI) at most 3 times per incident, hours apart. Telegram attention notices: re-offer notices for approval-mode accounts (bounded) and the existing outcome notices.
- Persistent state: two additive columns (`slowRetryCount`, `loginCreatedAt`) in `state/subscription-relogin/repairs.db`; new event classes `slow-retry-*`.
- **Operator surface:** new on the dashboard (account card and matrix cell): the next-try line ("Trying again on its own in about N h." / "Will offer to try again in about N h."), a **Don't retry on its own** button (relayed to a peer cell through the signed `repair-cell` mandate), the held line "Won't try again on its own. Try repair again any time.", and two cell status texts ("Things changed since the last try - tap Repair sign-in once more.", "Automatic retries stopped..."). In Telegram, a re-offer's approval notice now starts "The last ... sign-in repair didn't finish and the account is still signed out." Everything is phone-completable; existing buttons are unchanged.

---

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes — the cell still leads with the status line and the action button; the next-try line is a quiet detail beneath the status.
2. **Zero raw internals?** Yes — "Trying again on its own in about 6 h." No timestamps, ids or class names.
3. **Destructive actions de-emphasized?** The one new action, **Don't retry on its own**, reduces autonomy (not destructive: the failure row and its evidence stay, and **Try repair again** still works afterwards, so it is undoable by the operator). It renders below **Try repair again** in a smaller, lower-opacity style (`sub-matrix-repair-hold` / `sub-account-repair-hold`), so the primary action stays first and loudest.
4. **Plain language + phone width?** Yes - short plain sentences in a neutral 11px detail style (`sub-matrix-next-try` / `sub-account-repair-next`) that wraps at phone width; the hold button is a full-width-wrapping block button with a real tap target.

---

## 7. Multi-machine posture

Machine-local BY DESIGN (`physical-credential-locality`): each machine repairs its own login in its own Chrome profile, and the schedule/count live in that machine's `repairs.db`. Visibility is proxied-on-read: `GET /subscription-relogin?scope=pool` merges peers' episodes (whole rows, so `nextAttemptAt` / `slowRetryCount` come along). Notices are sent only by the owning machine. No URLs generated; no topic-bound state.

---

## 8. Rollback cost

Config: `slowRetry.enabled: false` stops retries; `mode: "approval"` or removing an identity restores the tap. Code: revert and ship a patch. The added columns are additive and ignored by older code; an episode left in `suggested`/`approved` by a slow retry is a normal state older code already handles. No data migration is needed, **but**: an older binary does not know the operator hold (`slowRetryHeld`) and re-admits `failed` rows on changed inputs, so a revert silently drops every hold and restores that re-admission. Where holds matter, set `assistedRelogin.mode: "approval"` (or disable assisted re-login) before downgrading, as the spec's Rollback section says.

---

## Conclusion

Eight review rounds reshaped the design: no login is ever abandoned by the retry (admission ignores only the repair's own recorded login); hard-line reports and phone taps stop automatic retries; backup codes are protected; failed rows have one paced retry path; the upgrade heal for the stuck rows actually works (a real bug the original change would have left); notices are held and keyed correctly; the breaker counts runs. Clear to ship once the second pass concurs.

---

## Second-pass review (if required)

**Reviewer:** independent second-pass subagent
**Independent read of the artifact: concur** (after one round of concerns, resolved)

Round 1 raised four concerns, all addressed in this artifact (and one in code): the Breaker bullet contradicted the events-based breaker (rewritten); the Double-fire bullet described the removed `failed` re-admission path (replaced with the real concurrent writers, all version-checked); the operator-surface list missed the hold button, the held line, two status texts and the reworded re-offer notice (listed; the hold button was restyled to be visibly quieter than **Try repair again**); Rollback lacked the downgrade caveat about holds (added).

Round 2: "Concur with the review. The four earlier gaps are now closed and match the code."

---

## Evidence pointers

- `tests/unit/subscription-relogin-slow-retry.test.ts`, `tests/unit/subscription-relogin-helper.test.ts`, `tests/unit/subscriptions-render.test.ts`, `tests/unit/PostUpdateMigrator-assistedRelogin.test.ts`, `tests/unit/self-action-convergence.test.ts`
- `tests/integration/subscription-relogin-agent-session.test.ts` (the leftover-login blocker was reproduced by this suite before the release was added)
- `tests/e2e/subscription-relogin-agent-session-lifecycle.test.ts`

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action` (this change adds a self-triggered retry/re-drive).
- **`closure`:** `guard`
- **`guardEvidence`:** `{ enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts (controller subscription-relogin-redrive in src/testing/selfActionRegistry.ts), howCaught: under a provider that rejects forever each run spends ≤3 attempts and settles failed; the durable slowRetryCount cap (3) with 6 h/24 h delays bounds re-drives to 12 per incident, horizon-independent and restart-proof; the ratchet fails if the count grows with the horizon or exceeds 12 }`.
