# Side-Effects Review — Codex enrollment follow-ups (config home, identity oracle, publish-wait)

**Version / slug:** `codex-enroll-followups`
**Date:** `2026-09-22`
**Author:** `Echo`
**Second-pass reviewer:** `required (enrollment/identity path)`

## Summary of the change

Three independent fixes, each found by live diagnosis on a real machine after the `--device-auth` fix (#2035) proved necessary but not sufficient:

1. `src/commands/server.ts` (enrollment pane spawn) — create the per-account config home before launching the login. `codex` exits immediately when `CODEX_HOME` names a missing directory, which every first-time enrollment does, so the pane died in <1s and `FrameworkLoginDriver` then scraped a dead pane until its 180s budget elapsed, surfacing the misleading `login artifact not found` / `login-did-not-start`.
2. `src/commands/server.ts` (EnrollmentWizard wiring) — pass `subscriptionIdentityOracle` (the composite) instead of `credentialIdentityOracle` (Anthropic-only). The completion email gate asks the oracle for the minted slot's account email; the Anthropic-only oracle returns `unavailable` for a Codex home, so `validateEnrolledAccountEmail` saw no email and held EVERY Codex enrollment with `missing-completed-email`, unrecoverably.
3. `scripts/post-publish-smoke.mjs` — raise the npm propagation deadline from 180s to 900s. Publishes were succeeding and the check was failing them.

## Decision-point inventory

- `AccountFollowMeEmailGate.validateEnrolledAccountEmail` (account selectable / held) — **pass-through, input corrected**. The gate's logic is untouched; it now receives a resolvable email for Codex slots. It still holds on mismatch or absence.
- Enrollment pane spawn (no decision surface) — **modify** — creates a directory before spawning.
- Post-publish smoke pass/fail — **modify** — same verdict, longer observation window.

---

## 1. Over-block

Fix 2 REMOVES a 100% false over-block: every Codex enrollment was held regardless of correctness. No new input is accepted that should be rejected — a genuinely wrong account still fails `email-mismatch`, and an unreadable one still fails `missing-completed-email`.

Fix 3 narrows over-blocking of healthy releases.

---

## 2. Under-block

Fix 2 could in principle under-block if the composite oracle mis-attributed a Codex credential. It does not guess: it reads the `id_token` in that slot's own `auth.json` and returns `unavailable` with a reason when absent or unparseable, in which case the gate still holds. The oracle has its own unit coverage (`tests/unit/codex-slot-identity.test.ts`).

Fix 3 under-blocks only in the sense that a release which appears between 3 and 15 minutes is now accepted — which is correct; those releases are real.

---

## 3. Level-of-abstraction fit

Fix 1 is placed at the single `spawn` callback every enrollment path funnels through, rather than at each caller — one guarantee instead of N. Fix 2 is pure wiring at construction, not new logic; the capability already existed and was simply not connected. Fix 3 is a constant in the script that owns the wait.

---

## 4. Signal vs authority compliance

No authority added or moved. The email gate keeps its blocking authority and its conservative default; this change only supplies it with evidence it previously could not obtain. The oracle remains a detector.

---

## 5. Interactions

- `FrameworkLoginDriver.parseArtifact` unchanged — it now receives a live pane instead of a dead one.
- `CredentialLocationLedger` keeps `credentialIdentityOracle`; only the wizard changes, so ledger behaviour is untouched.
- Creating the config home is idempotent (`recursive: true`) and safe when the slot already exists (the Studio case).
- A pre-existing terminal pending-login is unaffected: it stays terminal. Observed live — a login already marked `completed` without an email cannot be re-probed and must be re-enrolled. Noted for operators rather than silently worked around.

---

## 6. External surfaces

Creates a directory in the user's home (mode 0700) named for the account slot — the same path the login would populate anyway. No new network calls; the composite oracle's Codex path is a local file read. No route, dashboard or message surface changes.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design and correctly so: a credential and its config home live on the disk of the machine being enrolled, and the identity read is that machine's own file. `machine-local-justification: physical-credential-locality`. Nothing replicates; the bugs were visible only on machines that had never enrolled a Codex account, which is exactly the remote/follow-me case.

## 8. Rollback cost

Trivial and independent. Each fix reverts alone: drop the `mkdirSync`, restore `credentialIdentityOracle`, or restore `180_000`. No migration, no state change, no data touched. Already-enrolled accounts are unaffected.
