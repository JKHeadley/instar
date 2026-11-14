# Side-Effects Review — Add a Claude or Codex account from the owner's phone with Face ID

**Version / slug:** `account-add-face-id`
**Date:** `2026-11-09`
**Author:** `echo`
**Second-pass reviewer:** `independent review subagent (see below)`

## Summary of the change

Adds `POST /mobile/accounts/add {provider: claude|codex, nickname?, email, challenge, presenceSig}`
(operator request, Justin 2026-11-09 21:46). Tier 2 (credentials/authorization), stacked on
account-sign-in-face-id. One spec round, one second-pass review. Files: `src/core/newSubscriptionAccountId.ts`
(new, pure id deriver), `src/server/mobilePermissionsRoutes.ts` (action `account-add`, the route, field
allowlist, `addAccount` dep, audit event), `src/server/routes.ts` (`runAddAccountSignIn`; extracted
`reuseOrSupersedeLiveAttempt` and `driveFollowMeLogin` from `follow-me/enroll/start`, which now calls them
in its original order), `src/server/mobilePairingRoutes.ts` (owner-only allowlist rule),
`src/server/middleware.ts` (route budget = enroll-start's), `src/server/CapabilityIndex.ts`.

## Decision-point inventory

- Owner-phone write gate — pass-through — reused for a new action.
- Field allowlist on the phone body — add — refuses any field beyond five (no credential, path or id).
- `buildAction` — modify — `account-add` accepts only `claude` / `codex`.
- Duplicate-email check — add — refuses an email the pool (local or peer view) already holds for the provider.
- S7 completion gate — pass-through — the account joins the pool only via the existing completion.
- follow-me enroll/start — modify (refactor only) — same order: mandate, reuse/supersede, resolve, drive.

---

## 1. Over-block

- No email: refused. Intended (see spec "email is required"); without it every completion is held.
- An account whose pool email differs in alias form (e.g. Gmail dots) from the typed email is not
  recognised as a duplicate (provider-scoped comparison does not rewrite aliases); a second add would
  start, and completion would add it only if the provider reports the typed email. Same rule as the pool.
- A peer view that is down: duplicates on that machine are not seen; the id check still avoids clashes
  locally, and replication later shows both. Acceptable (fail toward the operator's explicit request).

## 2. Under-block

- The device signature covers the body, but the Face ID line names only the kind, not the email or
  nickname. A compromised app process on the owner's unlocked phone could change the email before
  signing; the result is a sign-in the owner must still complete at the provider, and the S7 gate holds
  any account whose email does not match. No credential is ever exposed.
- Rate: the shared `permission-actions` bucket (12/min) bounds how many sign-ins a phone can start.

## 3. Level-of-abstraction fit

The route lives with the other owner-phone Face ID actions and calls an injected core; the core reuses
the pool's own validators (`isIdentityVerifiableSlot`, `normalizeSubscriptionEmail`), the follow-me drive
(`driveFollowMeLogin`) and the existing completion (`completeFollowMe` + `completeNewValidated`). Only the
id derivation is new, as a pure, tested module.

## 4. Signal vs authority compliance

The blocking checks are authentication (presence proof) and input validation (field allowlist, formats,
duplicates). The account-joins-pool decision stays with the existing S7 gate. Complies.

## 4b. Judgment-point check

No competing-signals decision point added. Not applicable.

## 5. Interactions

- `follow-me/enroll/start`: refactored into two shared helpers, called in the original order (reuse
  check before target resolution, then drive). Covered by its existing tests.
- Enrollment wizard: the new pending login is an ordinary follow-me login; the reissue sweep, the
  completion sweep, `submit-code` and `cancel` all work on it unchanged. The app's console-ticket
  sign-in for those follow-up routes is untouched.
- Pending-logins surface shows the new login like any other.
- Completion adds via `upsertValidatedAccount` (new id ⇒ `completeNewValidated`).

## 6. External surfaces

New phone route and challenge action. Answers: start-cell shape on 201; 400 `unexpected-field`,
`bad-target`, `bad-nickname`, `bad-email`; 401 `challenge-invalid` / `presence-invalid`; 403 gate
refusals; 409 `account-already-added` (with `accountId`) / `account-id-unavailable`; 502 drive failure;
503 `permission-actions-off` / `account-add-unavailable` / start-cell preconditions. A login folder name
is created on disk only by the real sign-in driver when it runs.

## 6b. Operator-surface quality

No dashboard file touched. Plain `detail` words on every refusal the route itself makes.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design for the start: the sign-in runs on the machine that answered the phone (the
login folder must live where the CLI runs). The duplicate and id checks read the merged peer views
(proxied-on-read). Once completed, the account replicates through the existing pool meta projection.
No user-facing notices, no new durable state beyond the wizard's pending login, no generated URLs other
than the provider's. `/capabilities` lists the endpoint; no health/status answer changes.

## 8. Rollback cost

Pure code change: revert and ship a patch. A pending login started before rollback expires by TTL; no
pool row is written by this route. The app falls back on 403 `device-not-allowed`.

---

## Conclusion

Safe to ship: one owner-only Face ID route that only STARTS a sign-in; the account is added by the
existing verified completion.

## Second-pass review (if required)

**Reviewer:** independent review subagent (general-purpose, fresh context, read the diff, spec and artifact; no edits)
**Independent read of the artifact: concur**

Findings: non-owner paths blocked (`writeGate`, `ownerOnly` rule); a Claude proof cannot be spent on Codex
(provider read from the body is the signed target). The five-field allowlist runs before Face ID; `id` and
`configHome` cannot be supplied; audit rows hold only the kind, never the email or nickname. The
enroll/start extraction keeps order (mandate, reuse/supersede, resolve, drive), log lines, the 201
`reused` answer and the 502 mapping. Ids cannot collide (pool, wizard, peer, folder checks) or escape
`^[a-z0-9-]+$`, so no traversal. Completion adds a brand-new account for both kinds through
`completeNewValidated` after S7; Codex device-code logins finish through the completion sweep (default
every 5 minutes): slow but correct. Skipping the mandate is sound: submit-code, completeFollowMe and the
sweep never check one. Notes: the peer-down duplicate gap is disclosed (section 1); the shared helper's
log line still reads `[follow-me] enroll-start` when the add route calls it (cosmetic).

Concur with the review

## Evidence pointers

- `tests/unit/account-add-face-id.test.ts`
- `tests/integration/account-add-face-id.test.ts`
- `tests/e2e/account-add-face-id-alive.test.ts`

## Addendum (2026-11-10): two repo floors

- Storage-error ratchet: a bad email now answers with a fixed plain message ("email must be a valid non-blank provider account email") instead of the parser's own error text, so no internal error text reaches the phone.
- No-silent-fallbacks ratchet: four catches in the add path carry the `@silent-fallback-ok` marker with their reason: the bad-email 400, the peer-view read that leaves an unreachable machine out of the duplicate check (already listed above), a stored email that does not parse is not a match, and the follow-me scan catch that answers a 500 (it is flagged only because the new helper now sits right after it).
