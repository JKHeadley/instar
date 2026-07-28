# Side-Effects Review — WS5.2 R6b: Phase-C headless-enrollment reliability

**Version / slug:** `ws52-account-follow-me-r6b-reliability`
**Date:** `2026-06-17`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `pending (high-risk: enrollment/credential path — EnrollmentWizard.start failure handling + the follow-me enroll-start route)`

## Summary of the change

WS5.2 R6b — the Phase-C headless-enrollment reliability contract, layered onto the existing (#1214) secure enroll-start route WITHOUT weakening its mandate-gate/authoritative-email guarantees. Three parts: (1) `FrameworkLoginDriver.drive()` accepts an optional per-call `scrapeTimeoutMs` override (non-finite/≤0 ignored → falls back to the constructor default); a new config knob `multiMachine.accountFollowMe.remoteScrapeTimeoutMs` (default 180000ms / 3min) is threaded into the FOLLOW-ME enroll path only — normal local enrollment keeps the 60s default. (2) The HONEST FAILURE SURFACE: `EnrollmentWizard.start()` now wraps `driveLogin` in try/catch and re-raises a drive failure as a typed `EnrollmentDriveError` (with `code`/`operatorMessage`/`cause`); because `start()` calls `driveLogin` BEFORE `store.issue()`, a drive failure never leaves a stuck pending-login. Both `start()` callers map `EnrollmentDriveError` → an honest, retryable 502 (the generic `/subscription-pool/enroll` route and the follow-me enroll-start route) instead of a bare 500. (3) The two-code Claude case: the follow-me/remote path prefers the device-code single-code flow where the provider supports it (`remoteKind()` → device-code for OpenAI/Codex; Anthropic has no device-code endpoint so it stays `url-code-paste`), and for the no-single-code provider the larger remote timeout covers a late-arriving verification URL (instar only scrapes the URL; the second code is operator→CLI, never scraped). Files: `FrameworkLoginDriver.ts`, `EnrollmentWizard.ts`, `ConfigDefaults.ts`, `routes.ts` (502 mapping + enhancements on #1214's route — the duplicate insecure route an earlier stale-base build added was removed; #1214's secure route is authoritative), + 4 test files.

## Decision-point inventory

- `EnrollmentWizard.start()` drive-failure handling — **modify** — a drive failure becomes a typed error a caller can render honestly, never a silent stuck pending-login.
- Follow-me enroll-start route 502 mapping + remote timeout/device-code — **modify** (on #1214's route) — enrollment reliability; the mandate gate + authoritative email (the authorization decisions) are UNCHANGED.
- `remoteScrapeTimeoutMs` config knob — **add** — larger cloud scrape budget, follow-me path only.

---

## 1. Over-block

None. The larger timeout only ever makes the remote path WAIT LONGER before failing — it never rejects a legitimate enrollment that the old 60s would have accepted. The honest-failure path turns a previously-opaque drive throw into a clear 502 retry signal; it does not reject anything that previously succeeded. Local enrollment is byte-for-byte unchanged (the knob is read only on the follow-me path).

## 2. Under-block

The reliability layer does not add authorization — that remains #1214's mandate gate (unchanged). A drive that SUCCEEDS but mints the wrong account is still caught downstream by S7 at `/complete` (email validation) — R6b does not touch that. The honest-failure surface reports a START failure; it does not itself verify the eventual login outcome (by design — the completion gate owns that).

## 3. Level-of-abstraction fit

Correct layers: the timeout knob lives on the driver (which owns the scrape), the failure-typing lives on `EnrollmentWizard.start` (which owns the drive call), and the HTTP mapping lives on the routes (which own the operator-facing surface). The kind-preference (device-code) extends the existing `defaultKind` logic rather than re-implementing flow selection. No logic was duplicated; the earlier stale-base duplicate route was removed in favor of #1214's secure one.

## 4. Signal vs authority compliance

R6b adds NO new authority — it is purely reliability + honest reporting. The only authority on this path (the mandate gate) is #1214's and is untouched. `EnrollmentDriveError` is a signal (a typed failure the caller renders); it never blocks an authorized action — it reports that a drive could not START, with a retry hint. Deterministic (a timeout or a thrown driver error), not heuristic.

## 5. Interactions

The change composes with #1214's enroll-start route (enhances it) and the S7 `/complete` gate (unchanged downstream). The `start()`-before-`issue()` ordering is the load-bearing invariant for "no stuck pending-login on drive failure" — preserved. Both `start()` callers were updated to map the typed error (no caller left throwing an opaque 500). The background `reissueExpired` sweep already swallowed driver errors by design and was deliberately NOT changed (it is not the start path). No double-fire, no shadowing.

## 6. External surfaces

One new config knob (`remoteScrapeTimeoutMs`, additive, defaulted). The enroll-start + generic enroll routes now return 502 (retryable) on a drive failure instead of 500 — a more honest status for the same failure class; both remain dark behind `multiMachine.accountFollowMe` (the follow-me route) / unchanged-gating (the generic route). No new route. No cross-machine surface.

## 7. Multi-machine posture (Cross-Machine Coherence)

The reliability layer is per-machine by nature: the larger timeout + device-code preference apply to the enrollment running ON the target machine (the one minting its own login). The config knob is read locally. Nothing replicates. This directly serves the multi-machine case (a remote/slower target gets a realistic login budget + an honest failure message instead of a silent 60s timeout), which is exactly the Phase-C scenario R6b targets.

## 8. Rollback cost

Low. Dark behind `multiMachine.accountFollowMe` for the follow-me path; the generic-route 502 mapping is a status-code refinement (revert is trivial). The config knob is additive (absence → the driver's existing 60s default). No migration, no persisted state. Single-commit back-out.

---

## Second-pass review

**Concur with the review.** Independent audit (the reconciliation was verified to NOT weaken #1214):

1. **(CRITICAL) Mandate authorization intact** — exactly one `/subscription-pool/follow-me/enroll/start` route; the mandate gate (`ctx.coordination.gate.evaluate({action:'account-follow-me',...})` → 403 on `decision !== 'allow'`) and `resolveFollowMeEnrollTarget` (409 fail-closed, body email never used) are fully preserved. R6b only inserted `remote:true` + `remoteScrapeTimeoutMs` INSIDE the already-gated block.
2. **No stuck pending-login** — `driveLogin` runs before `store.issue()`; a throw is caught + re-raised as `EnrollmentDriveError` before any persistence; tests assert `pending()` empty after a drive throw.
3. **Local enrollment unchanged** — the larger budget + `remoteKind` apply only when `remote:true`; the generic route keeps the 60s default.
4. **Both start() callers handle EnrollmentDriveError** → 502 retryable; none unhandled.
5. **Config knob** — `remoteScrapeTimeoutMs` default 180000, read on the follow-me path with a `Number.isFinite` guard.
6. **Device-code preference** — `remoteKind` returns device-code only for openai; Claude stays `url-code-paste` (no unsupported flow forced).
7. **No fail-open** — invalid timeout falls back to the safe default (tested); deny-by-default gate unchanged.

`tsc --noEmit` EXIT=0; 60/60 tests pass.
