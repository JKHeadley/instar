# Side-Effects Review — Account sign-in from the owner's phone with Face ID

**Version / slug:** `account-sign-in-face-id`
**Date:** `2026-11-09`
**Author:** `echo`
**Second-pass reviewer:** `independent review subagent (see below)`

## Summary of the change

Adds `POST /mobile/accounts/sign-in/start {accountId, machineId, challenge, presenceSig}` so the
owner's phone can start an account sign-in with a Face ID presence signature instead of the dashboard
PIN (operator request, Justin 2026-11-09 21:36, topic 134088). Tier 2 (credentials/authorization
surface), about 9 files, roughly 250 changed src/test lines plus spec docs; one spec review round, one
second-pass review. Files: `src/server/mobilePermissionsRoutes.ts` (new action kind `account-sign-in`,
strict id patterns, the route, a `startAccountSignIn` dep, audit event), `src/server/routes.ts`
(start-cell's core extracted to `matrixStartCellReady` + `runMatrixStartCell`; the subscription-pool
write barrier extracted to `subscriptionPoolWriteRefusal`; PIN route now calls them; phone route wired
to barrier + core), `src/server/mobilePairingRoutes.ts` (one owner-only device allowlist rule),
`src/server/middleware.ts` (route timeout = start-cell's), `src/server/CapabilityIndex.ts` (awareness).

## Decision-point inventory

- Owner-phone write gate (`writeGate` + `proven`) — pass-through — reused unchanged for a new action.
- `buildAction` target validation — modify — `account-sign-in` targets `<accountId>@<machineId>` are
  split and checked part by part before the generic `TARGET_PATTERN` (which forbids `@`).
- Device allowlist — add — one `ownerOnly` rule, `permission-actions` bucket; not named for team phones.
- Subscription-pool write barrier — modify (refactor only) — same checks, now callable as a function.
- start-cell operator-presence gate (PIN) — pass-through — unchanged; the phone route substitutes the
  Face ID proof at the same point in the order.

---

## 1. Over-block

A pool account id longer than 64 characters (the pool's `ID_RE` has no length cap) would be refused
by the phone route; the dashboard PIN route still serves it. A machine id containing `.` or other
punctuation would be refused; mesh ids are `m_<hex>` and the no-mesh fallback is `local`, so no known
id is affected. An agent with permission actions dark (fleet default, dev-gated) answers 503 at the
challenge, which the app treats as "use the PIN" — intended.

## 2. Under-block

The phone route inherits whatever the start-cell core allows once presence is proven; it adds no new
check on which accounts or machines may be signed in (same as the PIN). A stolen, unlocked owner phone
with an enrolled presence key can start a sign-in, exactly as it can already approve requests; the
sign-in still needs the account owner to complete the provider's page, and the S7 email check holds a
mismatched account.

## 3. Level-of-abstraction fit

Right layer: the phone route lives with the other owner-phone Face ID actions and calls the console's
own code through an injected dep, the pattern the file's header documents. No logic is duplicated: the
barrier and the core are extracted once and called by both routes.

## 4. Signal vs authority compliance

The new authority is an authentication gate (cryptographic presence proof over an exact action), not
a brittle heuristic over content; it is the same authority already used for every other owner phone
action. Strict id regexes are input validation (format), not judgment. Complies.

## 4b. Judgment-point check

No competing-signals decision point added. Not applicable.

## 5. Interactions

- start-cell PIN route: refactored; integration suite `account-matrix-start-cell-route.test.ts` pins
  its behaviour (503 dark, 403 PIN, 201, 404, reuse, dead-pane supersede, 400).
- `enforceSubscriptionPoolWriteCapability` callers: same answers, now via `subscriptionPoolWriteRefusal`.
- Challenge store: one shared single-use store, 4 per device; a sign-in challenge shares the cap.
- Console-ticket Face ID sign-in (mobile-console-device-signin), which the app uses for its follow-up
  routes (submit code, cancel): untouched, not gated by this change.
- Rate bucket `permission-actions` (12/min) shared with approvals; a sign-in is a rare manual tap.

## 6. External surfaces

New phone-facing route and challenge action. Answers are start-cell's own body (the app parses it
unchanged); refusals: 400 `bad-target`, 401 `challenge-invalid` / `presence-invalid`, 403
`owner-phone-required` / `device-signature-required` / `device-not-allowed`, 503
`permission-actions-off` / `account-sign-in-unavailable` / start-cell's own 503s. Timing: same route
budget as start-cell.

## 6b. Operator-surface quality

No dashboard file touched. The phone surface lives in the iOS repo; this route returns plain `detail`
words on its own refusals and start-cell's body otherwise.

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied by design, same as start-cell: the serving machine verifies the phone and, for a peer target,
delivers the signed mandate and calls the peer's enroll/start. The challenge is machine-local (the
phone asks and answers on the same machine). Audit rows are a per-machine trail. No user-facing
notices, no durable state beyond the existing pending-login and mandate stores, no generated URLs
(the verification URL is the provider's). Status surfaces: `/capabilities` lists the endpoint; no
health/status answer changes.

## 8. Rollback cost

Pure code change: revert and ship a patch. No persistent state, config or migration. During rollback
an updated app gets 403 `device-not-allowed` and falls back to the PIN.

---

## Conclusion

Safe to ship: one owner-only Face ID route over the console's own start-cell core, with the PIN route
unchanged.

## Second-pass review (if required)

**Reviewer:** independent review subagent (general-purpose, fresh context, read the diff and artifact; no edits)
**Independent read of the artifact: concur**

Findings: non-owner paths (bearer, browser, revoked, team, MSP) cannot reach the core (`writeGate` +
`activeOwnerPhone` + an `ownerOnly` allowlist rule absent from `TEAM_ROUTE_TIERS`; `teamControl` false so
the switch and PIN-set checks apply). Target binding holds: the challenge binds device, Host and the exact
line and is consumed before judging; neither id pattern admits `@`, so the target splits one way only,
and `buildAction` accepts only a target that rebuilds to itself. The PIN route keeps its order (barrier,
three 503s, 400, PIN, core) and its answers; the 503 checks run a second time inside the core, harmless.
No check is skipped on the phone route; the only order difference is that the challenge is consumed before
the barrier and 503 checks, so a refusal there costs a fresh Face ID tap (not a security issue). No secret
leakage: the body is start-cell's own; audit rows hold the action kind, target and status. Artifact claims
match the code.

Concur with the review

## Evidence pointers

- `tests/unit/account-sign-in-face-id.test.ts`
- `tests/integration/account-sign-in-face-id.test.ts`
- `tests/e2e/account-sign-in-face-id-alive.test.ts`
- `tests/integration/account-matrix-start-cell-route.test.ts` (regression)
