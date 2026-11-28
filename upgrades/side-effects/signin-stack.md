# Side-effects review: sign-in stack (index for the combined change)

This change combines four parts of the sign-in repair work into one pull request. Each part has its own side-effects review. This file indexes them and answers the eight questions for how they work together.

| Part | Review |
|---|---|
| Authenticator at the phone prompt (was PR 3963), ships watch-only | upgrades/side-effects/relogin-authenticator-over-phone-prompt.md |
| Passkey repair executor, sign-in step off by default | upgrades/side-effects/passkey-repair-executor.md |
| Chrome screen-state on failed repairs (signal only) | upgrades/side-effects/chrome-apple-event-screen-state.md (+ ELI16) |
| Attention security floor for revoke wording | upgrades/side-effects/attention-security-floor.md (+ upgrades/attention-security-floor.eli16.md) |

Specs: docs/specs/relogin-authenticator-over-phone-prompt.md (converged, approved 2026-11-26) and docs/specs/agent-held-google-passkey.md (converged, operator-approved 2026-09-22, already on main).

## 1. Over-block
Passkey accounts are refused a repair by name (passkey-sign-in-off) while the passkey step is off. Before this change they were offered a repair that could never finish, so nothing that worked before is refused now. The security floor keeps revoke-consent items forever. Routine "invalid_grant ... expired or revoked" wording is blanked first, so ordinary sign-in noise still expires.

## 2. Under-block
The automatic authenticator code entry stays watch-only until the operator says yes. An account still signed out after the watch-only path still waits for a phone tap. That is intended.

## 3. Level-of-abstraction fit
Every part lives in the existing repair runtime, store, policy and attention lifecycle. No parallel gate is added.

## 4. Signal vs authority
The screen-state reading and the watch-only authenticator review are signals. They never change outcomes. Passkey admission is a deterministic floor (switch off means refuse) that sits under the existing operator approval. It does not replace that approval.

## 5. Interactions
The combined change found one cross-part defect: the passkey step and the helper or last-resort drive shared the machine seat lease. It was fixed so the step keeps the seat only when it goes on to helper.drive, and releases it on every other exit. The re-admission query reads the newest state change, so audit rows written by the authenticator review cannot hide a cancel.

## 6. External surfaces
The normal-Chrome script's error text is richer. The repair history gains screen-state notes and authenticator review rows. Nothing here acts on a real Google account in a new way unless the operator turns on the passkey step or authenticator code entry.

## 7. Multi-machine posture
Repair episodes, seat leases and Chrome profiles are machine-local by design (physical-credential-locality: each machine holds its own login and browser profile). Attention items keep their existing replication.

## 8. Rollback cost
A revert of the merge commit restores the previous behaviour. New store columns and event classes are additive and are ignored by older code. Both switches already default to off.

## Second pass
Three independent passes ran over the whole stack on 2026-11-27 (03:32, 03:55 and 05:40 PT). They found 8, 6 and 4 issues, all fixed; the details are in the pre-queue record. A fourth pass over the 05:50 fixes is recorded below.

Fourth pass, 2026-11-27 10:25 PT (fresh sub-agent, read-only, over the 05:50 fixes): concern raised on tests, not code. The seat fix and the security-floor fix were confirmed correct, with every exit path checked. Two test findings were fixed: the invalid_grant negative now carries an OAuth word, so it depends on the blanking (checked: it matches without the blanking, not with it). The helper-path refusal test was renamed to what it proves, the end state, because the orchestrator's own release also frees the seat. Open, recorded: no harness yet has a real helper seat, so keeping the seat into helper.drive and releasing it on refusal while a helper seat exists are not covered by a test.

## Class-Closure Declaration (display-only mirror)

- **Trace declaration:** `defectClass: unbounded-self-action`, `closure: n/a`. Reason: the change adds no new self-triggered action. The authenticator outcomes only add stop conditions to the existing slow retry. The passkey step runs inside a repair attempt that was already admitted, and it is switched off by default. The screen-state read and the attention floor are signals. The new routes are request-driven, never self-triggered.
- The fix-one part's extra registry entry (`over-broad-stop-rule`, gap item ACT-001) is kept as recorded in upgrades/side-effects/relogin-authenticator-over-phone-prompt.md.
