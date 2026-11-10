# Side-Effects Review — Sign-in finishes after the code; Claude keychain reads match the CLI

**Version / slug:** `signin-finishes-after-code`
**Date:** `2026-11-10`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Operator report 2026-11-10 11:17 PST (topic 33890): after "Send the code" the console sign-in sheet kept its live form under a faint "code sent; finishing sign-in", and the account (gearfinity3d) stayed needs-reauth although the CLI login had completed. Root cause had two parts. (1) `POST /subscription-pool/follow-me/enroll/:id/submit-code` waited 2 s, answered `submitted`, and nothing but the 5-minute `sweepFollowMeCompletions` tick could finish the login, with no state exposed to the page. (2) Deeper: every instar read of a Claude credential (`defaultCredentialStore.read/readAsync`, `defaultKeychainExec.readService`, `KeychainCredentialProvider`) used `security find-generic-password -s <service>` with no `-a`. The gearfinity3d service held two items: `acct="unknown"` last written 2026-11-08 (expired token) and the CLI's `acct=<USER>` item refreshed by the re-login. The keychain listed the stale one first, so the poller, the completion sweep's auth-revision baseline and the identity oracle all read the dead copy: the sweep could never see a change, the oracle answered unavailable, and after the hand repair the poller got HTTP 429 on the dead token and dropped the account silently.

Changes: `src/core/OAuthRefresher.ts` adds `claudeKeychainAccount()` (the CLI's own rule: `$USER`, then the OS user name, then `claude-code-user`) and `readClaudeKeychainItem[Sync]()` (CLI account first, then any item); the credential store, swap executor read and `CredentialProvider` reads use it; the store/swap writes use the same account. `src/core/EnrollmentWizard.ts` factors the sweep body into `completeLanded(id, {proof})` (`auth-revision` as before, or `live-identity` = a live profile probe returns an email). New `src/core/FollowMeCompletionWatcher.ts` drives one submitted login to `done` | `failed(reason)` within a 150 s bound. `src/server/routes.ts` starts the watch on `submitted` and adds `GET /subscription-pool/follow-me/enroll/:id/completion` (local) and `GET /subscription-pool/follow-me/completion` (relay). `src/core/QuotaPoller.ts` logs a non-auth usage-read error instead of skipping silently. UI: `dashboard/console/accounts.js` (only `signInSteps` + a `getJson` helper) + new `signin-progress-model.js` + `console.css`; legacy `dashboard/subscriptions.js` row and cell submit branches + `index.html` CSS. Agent awareness: one sentence in the template/migrator enroll line; CapabilityIndex lists the two GET routes.

Tier 1 by the revert test (no persistent state added; a revert restores prior behavior exactly), declared knowingly below the credential risk floor; the credential write path is unchanged except the account attribute, which now matches the CLI.

## Decision-point inventory

- `EnrollmentWizard.completeLanded` (follow-me completion) — modify (refactor of the sweep body; adds `live-identity` proof used only by the watcher after the login window closed).
- `FollowMeCompletionWatcher` terminal classification — add (done / wrong-account / window-closed / timed-out / cancelled / gone / could-not-save).
- Claude keychain item selection — modify (CLI account first).
- QuotaPoller non-auth read — pass-through (adds a log line only).

---

## 1. Over-block

No block/allow surface on messages or actions. The only new "refusal" is a failed completion state; it never mutates the login or the pool on failure (window-closed/timed-out leave the login pending and the account as it was), so a retry is never blocked by it.

---

## 2. Under-block

- A Linux host has no keychain revision; there the watcher can only finish via the live probe after the login window closes. If the CLI pane stays open after success (not observed; the CLI exits), the watch ends `timed-out` while the 5-minute sweep still can't prove it. Acceptable: the operator sees a clear failure with a retry, not a stall.
- The stale `acct="unknown"` keychain item is left in place (not deleted). It is now ignored whenever the CLI's item exists; if a host ONLY has a foreign-account item, the fallback still reads it (prior behavior).

---

## 3. Level-of-abstraction fit

The completion decision stays in `EnrollmentWizard` (one path for the sweep and the watcher, same S7 email gate). The watcher is a thin bounded driver; the route only starts it and reads it. The keychain fix is at the single read primitive every consumer already shares, so every consumer (poller, oracle, sweep baseline, swap pre-flight) moves together.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The watcher completes a login only through the existing identity-verified gate (`validateEnrolledAccountEmail`); it adds no new authority. The `live-identity` proof is a live Anthropic profile call naming the expected email, which is the same evidence the gate already requires, and it runs only after the operator submitted a code and the login window exited.

---

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The terminal states are an enumerable lifecycle (validated / held / not-pending / window gone / deadline).

---

## 5. Interactions

- **Shadowing / double-fire:** the 5-minute sweep and the watcher can target the same login; both go through `completeLanded`, guarded by the per-login in-flight set (`busy` → retry next poll) and the store's version CAS (`completeIfVersion`). The loser sees `not-pending/completed` and reports done. Covered by "finished by another path" test.
- **Cancel:** a cancel during finishing makes the login `abandoned` → watcher reports `cancelled`.
- **Reissue sweep:** TTL is 15 min, the watch bound 150 s, so the reissue sweep cannot re-drive a login under watch.
- **Keychain:** swap executor `readService` now prefers the CLI item. Its write uses `-U -a <same account>` so read-after-write is consistent; previously a launchd process without `$USER` wrote `-a instar`, itself a way to create a duplicate item. `deleteService` (staging services only) unchanged.
- **Feedback loops:** none; the watcher stops at a terminal state or the deadline.

---

## 6. External surfaces

- Two new authenticated GET routes; submit-code's `submitted` answer gains an optional `completion` field (additive).
- Persistent state: none new (watch state is in memory; after a restart the GET falls back to the durable pending-login record).
- Operator surface: the console sheet and the legacy Subscriptions rows/cells; phone-completable (the retry restarts the same PIN-confirmed flow).
- Logs: one new warn line per account per poll cycle while its usage read errors (15-minute cadence).

---

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes. Before sending, the form is unchanged. After sending, the only content is the state, and at the end the single action (Done, or Start the sign-in again).
2. **Zero raw internals?** Yes. Reason codes map to plain sentences; emails are shown only as the signed-in account.
3. **Destructive actions de-emphasized?** The Cancel button is removed once the code is sent (cancelling mid-finish would race the completion); before that it stays in the quiet danger area as before.
4. **Plain language + phone width?** Yes; centered column, 18px title, 44px spinner, wraps at phone width (no fixed widths). Reduced-motion users get a static ring (global rule).

---

## 7. Multi-machine posture

**machine-local BY DESIGN, proxied-on-read.** The login pane and the credential slot live on the target machine, so the watch runs there. The operator's fronting dashboard reads it through `GET /subscription-pool/follow-me/completion?machineId=…`, which forwards to that peer's local route (same Bearer-authed hop as submit-code); an unreachable peer answers 502 and the page keeps asking until its own 4-minute cap. No notices are emitted (the email gate's existing HIGH attention item on a wrong account is unchanged). No URLs generated. No new `/status`, `/health`, `/capabilities` or `/channels` verdicts (CapabilityIndex only lists the routes).

---

## 8. Rollback cost

Pure code change: revert and ship a patch. No data migration. Keychain items are only read differently; nothing is deleted or rewritten by this change.

---

## Conclusion

The review moved the keychain fix to the shared read primitive (rather than patching the poller alone) once the live diagnosis showed the same stale read also blinded the completion sweep and the identity probe. Clear to ship after the second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, cold read of the code and this artifact)
**Independent read of the artifact: concern → resolved**

- Concern 1: the page treated `waiting-for-code`/`unknown` (no live watch, e.g. after a restart mid-finish) as a final failure although the 5-minute sweep can still finish the login. Resolved: both pages now treat those as not final and keep asking until their 4-minute bound, then say "No answer yet … if it finishes later, the account shows as signed in by itself" (`signin-progress-model.js`, `subscriptions.js followCompletion`; model test updated).
- Concern 2: `timed-out`/`window-closed` leave the login open, so a later sweep can still validate it after the page said "not finished". Resolved by wording: the timed-out and give-up messages say it may still finish by itself; window-closed says no sign-in could be confirmed. Closing the login on these outcomes was rejected because it would discard a sign-in that did land.
- Concern 5: the watcher's state map never shrank. Resolved: finished entries older than 30 minutes are pruned on each new watch.
- Concurred: no path adds an account without the expected-email gate; busy/cancel/reissue settle correctly; the sweep refactor preserves behavior; the keychain read/write account change is safe. Noted (not acted on): the fallback read can still pick a foreign-account item when the CLI's item is absent, which is the prior behavior.

---

## Evidence pointers

- Live keychain dump (Mac Studio, 2026-11-10 ~19:35Z): service `Claude Code-credentials-8aa0bca8` had `acct="unknown"` (mdat 2026-11-08 02:27:55Z) and `acct=dabombstudio` (mdat 2026-11-10 19:16:18Z). The bare `-s` read returned a token expiring 2026-11-08 10:27:54Z; the usage endpoint answered 429 for it.
- `/subscription-pool` at 19:29Z: gearfinity3d `loginCheck: unavailable`, `lastQuota.measuredAt: 2026-11-08T10:26:52Z`, polled between sagemind-adriana (19:27:25) and sagemind-echo (19:27:28) with no log line.
- Tests listed in `upgrades/next/signin-finishes-after-code.md`.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — not an agent-authored-artifact defect (runtime code). The watcher is a self-triggered controller in the `unbounded-self-action` sense (it re-tries a completion), so its convergence argument: control-loop edge = one operator code submit starts at most one watch per login id (`watch()` joins a running one); steady-state bound = polls every 2 s until a terminal outcome or a hard 150 s deadline, then stops; settling brake = terminal states are absorbing and the store CAS makes completion idempotent. Ratchet: `tests/unit/follow-me-completion-watcher.test.ts` (timeout bound and join tests).
