## What Changed

WS5.2 — one-dashboard cross-machine mandate delivery. Closes a real UX gap: authorizing an account-follow-me enrollment on another machine used to require a PIN-gated mandate issued on THAT machine's own dashboard (per-machine friction). Now the operator's SINGLE dashboard does it: a new PIN-gated `POST /mandate/issue-for-machine` issues the mandate locally and, for a remote target, packages it with the operator machine's Ed25519 signature (the already-approved ws52 R4a bridge) and delivers it over a new `account-follow-me-mandate-deliver` mesh verb. The target authenticates the mesh sender (existing Ed25519 envelope verification → the registered operator-machine identity), R4a-verifies the mandate's issuance signature against that registered key (a name in the payload is never trusted — Know Your Principal), checks the exact bounds (account-follow-me / this machine / re-mint), and persists it to a new `DeliveredMandateStore`. The enroll-start route then consults the delivered mandate (re-verifying the signature at point-of-use) when the local gate has none — both paths fail-closed. The core MandateGate authorship model is untouched. Dark behind `multiMachine.accountFollowMe`.

## Evidence

- 122 tests across 11 files (delivery store + accept/trust path: valid R4a → stored+honored; bad signature / untrusted key / issuer≠sender / wrong-target / wrong-mechanism / non-follow-me → refused & nothing persisted; mesh-verb RBAC deny-by-default; issue-for-machine PIN-gated + dark→503 + honest 502 on delivery failure + local-target unchanged; enroll-start honoring a delivered+verified mandate vs 403 without one; dashboard routing). `tsc --noEmit` clean.
- Side-effects review + mandatory independent second-pass security review (concurred on all 8 points: trust anchor = authenticated sender never payload, R4a load-bearing fail-closed, exact-bounds double-gated no-replay, enroll-start additive fail-closed with point-of-use re-verify, PIN-gated issuance / no self-issue, deny-by-default mesh RBAC, dark-by-default, no fail-open).
- Spec: `docs/specs/ws52-account-follow-me-security.md` R4a/R1/R6a (converged, approved) — wires the spec's R4a cross-machine mandate bridge.

## What to Tell Your User

You now manage everything from your ONE dashboard — no more "open the other machine's dashboard." When you approve a machine to use one of your accounts, you do it once on your single dashboard with your PIN; your approval is cryptographically signed and delivered to that machine, which verifies it really came from you before acting. You never touch the other machine. (Off by default while the broader account-sharing feature is dark.)

## Summary of New Capabilities

One-dashboard cross-machine mandate authorization (dark): issue + deliver an account-follow-me mandate to any of your machines from your single dashboard; the target verifies it via the R4a operator signature and honors it only for its exact bounds. New PIN-gated `POST /mandate/issue-for-machine` + the `account-follow-me-mandate-deliver` mesh verb. No user-facing surface is live until `multiMachine.accountFollowMe` is enabled.
