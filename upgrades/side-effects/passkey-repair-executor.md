# Side-Effects Review — Passkey repair: readiness check, Chrome gate, repair sign-in step (off), legacy adoption

**Spec:** docs/specs/agent-held-google-passkey.md (approved by Justin 2026-09-22, converged 10 rounds). This change builds §2 (Chrome version gate), §3.4 (repair admission from real cell state; the repair path), and §6.2 (legacy adoption).
**Author:** Echo (sign-in owner), 2026-11-26.

## Summary of the change

- `PasskeyRepairAdmission.ts` (pure): grant + custody + Chrome gate + health + suspension → one admission state; only `ready` admits. Terminal health states outrank everything.
- `PasskeyChromeGate.ts`: per-machine, per-Chrome-major record of the local WebAuthn fixture self-test (mint → export → inject in a second fresh browser → assert). Unreadable version or a failed or missing record refuses.
- `PasskeyCellStateReader.ts` + `server.ts`: wires `passkeyCellState` into the relogin runtime when `passkeys.enabled` resolves on (dev gate). It starts at most one background Chrome self-test for a granted cell.
- `PasskeyCredentialStore.custodyOf()`: custody by the same rules as `load()`, without returning key material. `holdsAnythingFor()` and `discardQuarantinedAdoption()` back a safe adoption revert.
- `PasskeyColdProof` `keepSession` (repair mode): no clear before sign-in, no sign-out after, the key is still removed before close; a profile already past the sign-in page is left alone (`session-present`).
- `SubscriptionReloginRuntime`: for `google-passkey`, calls `passkeySignIn` (wired only when `passkeys.repairUsesPasskey === true`), then runs the ordinary session drive in the normal browser with no secret. Absent ⇒ `passkey-refused` / `passkey-sign-in-off` (today's behaviour). The risk page goes to `captcha` (operator). A different identity is `wrong-identity`. Rejected or throttled is `passkey-refused`.
- `PasskeyLegacyAdoption.ts` + routes `GET /passkeys/legacy`, PIN `POST /passkeys/adopt-legacy`, PIN `POST /passkeys/delete-legacy`.
- Awareness entry `passkey-repair-and-legacy-adoption.md`.

**One deliberate shape choice, and who decides it.** The spec's repair runs the whole repair in the passkey-capable (debugging-pipe) browser. The operator's later direction (2026-09-24/25) is that sign-ins run only in a normal browser. This build narrows the debugging browser to the Google passkey step alone, on the account's own profile, which then closes; the provider sign-in stays in the normal browser. Even that one step narrows the normal-browser rule. The Chief of Staff ruled on 2026-11-26 that it ships **off** (`passkeys.repairUsesPasskey` absent ⇒ off; no migration writes it) and that Justin decides at go-live. Nothing in this change turns it on.

## Decision-point inventory

| Point | Kind | Note |
|---|---|---|
| Passkey repair admission state | invariant | Deterministic floor over recorded state; only `ready` admits; every other value is a named refusal (policy table unchanged). |
| Chrome version gate | invariant | Fixture self-test result per (machine, major) — spec §10 row. |
| Repair sign-in step on/off | invariant | Config switch, default off, operator decision. |
| Legacy adopt commit | invariant | Commits only on a `ready` cold proof; otherwise reverts. |

## 1. Over-block

A cell proven `ready` more than 21 days ago is refused until the weekly proof runs again (the watcher tick is a separate surface). A Chrome major change refuses passkey repairs on that machine until the background self-test finishes (one admission pass later). Both fail toward today's behaviour (approval path / phone tap).

## 2. Under-block

The pool-wide suspension record and the local kill flag (§2) are not published on this build; `suspended` is always false. Missing inputs can only ever admit less once they land. Repair admission reads THIS machine's risk and throttle pauses (a paused account is refused as `passkey-suspended`); a pause written on a peer is not yet read by repair admission (proofs and enrollment read it through the pool path). Restrictive direction only.

## 3. Level-of-abstraction fit

Admission stays in the pure policy (`PASSKEY_CELL_REFUSALS`); the new code only computes its input. The sign-in step reuses the cold proof's closed page classes and floor rather than a second driver.

## 4. Signal vs authority compliance

No new brittle blocking authority. The refusals are the spec's deterministic floors over recorded state. The supervisor remains a Tier-1 chooser within the closed allowed list.

## 4b. Judgment-point check

The step selection inside the Google sign-in is the existing supervised closed-list floor (unchanged).

## 5. Interactions

- The relogin runtime: the provider check now runs before the passkey step (both are refusals; order changes only which name a doubly-invalid account gets).
- The repair's passkey step and the user's own normal Chrome cannot run on the same profile at once (Chrome profile lock). The step fails `unknown` (transport) and the repair is refused by name. The step is off, so there is no live effect.
- Health: real repair outcomes (`rejected`, `security`, `ready`) feed the cell health like a proof (§4 table); `session-present` records nothing.

## 6. External surfaces

Three new dashboard-PIN routes (dev-gated, 503 on the fleet). No Google-side effect unless an operator adopts a key (a real cold proof sign-in) or turns the step on.

## 6b. Operator-surface quality

The routes are PIN-gated levers used from the dashboard; the response names the outcome (`adopted`, or a named refusal). Dashboard buttons are not part of this change. The go-live question carries the plain-words explanation.

## 7. Multi-machine posture (Cross-Machine Coherence)

All new state is machine-local by design. `machine-local-justification: physical-credential-locality`: the Chrome binary and its authenticator, the passkey store and the prototype key copies all live on one machine's disk (spec §12). Adoption is per machine by spec.

## 8. Rollback cost

Revert the PR. The Chrome-gate record file and any adopted key remain harmless on disk; an older build ignores them (the passkey store file is invisible to older builds, §3.1). An adopted key whose shared copy was removed stays usable by the new store only; reverting does not resurrect the shared copy. That is spec §6.2's intended end state.

## Conclusion

The build completes the approved design with the sign-in step off. The one precondition for turning it on is Justin's decision on the browser shape.

## Second-pass review (if required)

**Reviewer:** an independent Claude subagent (general-purpose), read-only, given the diff and the spec, not this write-up, 2026-11-26 19:00 PT. **Verdict: Concern raised**. Four confirmed defects, all fixed before commit:

1. *The sign-in step loaded the key without re-checking admission* (§3.4 "and again before load()"). Fixed: `passkeySignIn` re-reads the cell state right before `load()` and refuses unless it is `ready`.
2. *A repair wrote no attempt row and no risk or throttle pauses.* Fixed: an attempt row (`kind: 'repair'`) is written before Google is reached. A risk page pauses the account for 7 days. A throttle pauses the account for 24 hours and the machine for 1 hour. The adopt route now also writes the machine throttle pause.
3. *The first use on a new Chrome major was not a cold proof* (§2). Fixed: a `ready` proof older than the moment this major passed the gate reads `chrome-unverified`.
4. *A failed adoption's revert could delete an old-machine-id credential or an in-flight enrollment.* Fixed: the guard is `holdsAnythingFor()` (any machine id or a pending mint), and the revert is `discardQuarantinedAdoption()`, which removes only this machine's quarantined legacy copy, with no tombstone.

Doubts, and what was done about each:
- **Fixed:** a self-test that cannot run is now transient and not recorded, so the gate stays `unchecked`.
- **Fixed:** the host-wide browser seat is held for the passkey step and for the Chrome self-test.
- **Fixed:** `session-present` now counts only the signed-in landing page.
- **Fixed:** cancellation is checked before Google is reached.
- **Fixed:** the Windows helper path is refused by name.
- **Accepted:** a crash between copy-in and proof leaves a quarantined, unusable record, which blocks a later adoption of that email until a revoke. This is the safe direction.
- **Accepted:** a non-ready adoption records no health outcome, because the cell has no credential.
- **Accepted:** a repair's `failed` outcome feeds health with origin `repair`, so the 1-hour confirm rule applies, as for a proof.

The fixes were made after the review and were not re-reviewed. They are covered by new unit tests.
