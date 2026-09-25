# Side-Effects Review — default consent allowance from the CLI link; clearer normal-browser launch failures

**Version / slug:** `relogin-scopes-and-launch`
**Date:** 2026-09-25
**Author:** Echo

## Summary of the change

`resolveAllowedScopes(configured, verificationUrl)`: configured list wins; otherwise the scopes parsed from the sign-in link printed by the runtime's own login process (charset-clamped, max 20). Normal-browser launch budget ≥30 s (seam ≥1 s); timeout reasons name the step (`chrome-launch-no-process`, `chrome-launch-timeout-<problem>`).

## Decision-point inventory

- Consent allowance — `invariant`: deterministic derivation from a link produced by our own trusted subprocess; the existing consent floor (requested ⊆ allowed) is unchanged.

## 1. Over-block

Removes an over-block (every unconfigured machine refused consent).

## 2. Under-block

If our own CLI starts requesting a broader scope in a future release, the repair will approve it without a config change — the same thing the operator's manual sign-in approves. The link cannot be supplied by a page: it comes from the local login process's pending-login record, and the drive already refuses any link whose origin is not the provider's.

Parsing only accepts scope names matching `^[a-z][a-z0-9:._-]{0,79}$` (dots allowed for Codex-style names); wildcards and junk are dropped, so parsing can only narrow the allowance, never widen it. The consent floor reads scopes from the live page address, so it bounds what the provider can ask mid-flow to what the link asked. Worst-case launch wait is about twice the budget (process start + page load each get it: 60 s by default).

## Second-pass review

Reviewer (subagent, 2026-09-25): **Concur** — the link comes only from the local login process (EnrollmentWizard via FrameworkLoginDriver output; peer relay never stores it); the floor still refuses anything beyond it. Hardening taken: dotted scope names accepted (else Codex consent would refuse), Apple Event tokens restricted to the runner's fixed set (a page could otherwise inject a short token into the reason), doc notes added.

## 3. Level-of-abstraction fit

The allowance is resolved once where the drive request is built (runtime), not inside the page logic.

## 4. Signal vs authority compliance

No new authority; the consent floor keeps its semantics (never approve beyond the allowance).

## 4b. Judgment-point check (Judgment Within Floors standard)

None added.

## 5. Interactions

Machines with a configured `allowedScopes` (the Studio) behave exactly as before. The longer launch budget stays inside the 8-minute drive deadline.

## 6. External surfaces

Consent pages on unconfigured machines are now approved when they match the CLI's own request.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Recorded reasons become more specific; no new surface.

## 7. Multi-machine posture (Cross-Machine Coherence)

`machine-local-justification: physical-credential-locality` — each machine derives its allowance from its own login process; no replicated state.

## 8. Rollback cost

Revert; configure `allowedScopes` by hand where needed.

## Conclusion

Removes a fleet-wide blocker while keeping the expansion floor. Ship.

## Evidence pointers

`upgrades/next/relogin-scopes-and-launch.md`.

## Class-Closure Declaration (display-only mirror)

`{defectClass: "unbounded-self-action", closure: "n/a", reason: "no new self-triggered action"}`
