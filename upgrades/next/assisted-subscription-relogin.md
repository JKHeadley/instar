<!-- bump: minor -->

## What Changed

- Added an approval-gated assisted re-login controller for Claude Code subscription accounts. A corroborated sign-in incident can now become one durable repair episode; after operator approval, Instar drives the provider-native flow, completes Claude's paste-back step when required, and independently verifies identity, authenticated use, pool recovery, and incident closure.
- Added a short-lived dashboard operator session so the Subscriptions grid can offer a genuine one-click Repair sign-in action without granting that authority to the ordinary API credential.
- Added bounded retries, restart-safe state, cancellation, provider/account breakers, redacted audit events, and strict refusal for ambiguous identity, unexpected origins or permissions, CAPTCHA, phone/risk challenges, and security-setting or billing changes.
- Added exact Playwright profile vault bindings by secret name. Secret values are resolved only inside the browser worker and are excluded from model input, persistent state, logs, screenshots, APIs, and messages.
- Added phone-complete dedicated Google profile provisioning in the Subscriptions dashboard. A recent PIN unlock creates and materializes the machine-local profile; any genuinely required credential or provider challenge is completed through one secure link or dashboard action, never by accessing the host machine.
- Added authenticated repair status, events, approve, cancel, and retry routes; dashboard status/actions; config defaults; migration awareness; privacy exclusions; capability discovery; and production server wiring.

## What to Tell Your User

When a Claude Code subscription account genuinely needs to sign in again, the Subscriptions dashboard can now show Repair sign-in. Unlock the dashboard and click it once. Instar handles the normal provider login and Claude completion flow, survives ordinary restarts and transient failures, and proves that the intended account actually works before reporting success. It stops and asks for help instead of improvising around provider security challenges or identity ambiguity.

## Summary of New Capabilities

- One-click approval followed by autonomous, bounded Claude Code sign-in repair.
- Durable progress and safe restart recovery without replaying uncertain browser actions.
- Exact account/profile identity gates and independent authenticated-success proof.
- Operator cancellation, explicit retry, breakers, and redacted repair history.
- Fleet-dark, dry-run-first rollout with unattended mode remaining disabled.

## Evidence

- Focused unit, integration, and production AgentServer E2E tests cover admission, approval scope, state transitions, restart recovery, browser origin/action limits, secret handling, paste-back readiness, identity/authenticated-use proof, dashboard behavior, config migration, privacy exclusions, and live/non-live production wiring.
- Independent cross-model architecture review completed in three convergence rounds with no major findings; all material minor findings were incorporated into the reviewed specification and acceptance matrix.
- Build, static preflight, the full three-tier repository suite, CI, publish, deployment, and disposable-identity canary are release-blocking gates recorded in the feature evidence.
