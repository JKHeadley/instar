# Passkey Sign-In Repair, Readiness Check and Legacy Passkey Adoption

## What Changed

This finishes the agent-held Google passkey path that earlier releases built in pieces (spec agent-held-google-passkey):

- **Readiness check.** A sign-in repair for an account whose login method is `google-passkey` is now admitted only when its passkey is ready on that machine: an active grant, a usable key, a Chrome version that passed the local passkey self-test, and a passing sign-in proof in the last 21 days. Any other state is refused by name.
- **Chrome version check.** When a new Chrome major version appears, the server runs the local passkey self-test once and records the result for that version.
- **Repair sign-in step.** The Google step signs the account's own profile in with the agent's passkey and closes. The Claude or Codex sign-in that follows runs in the normal browser as before. This step is **off** unless `passkeys.repairUsesPasskey` is true.
- **Legacy key routes.** The old prototype keys can be listed by name (`GET /passkeys/legacy`) and kept or deleted per machine with the dashboard PIN (`POST /passkeys/adopt-legacy`, `POST /passkeys/delete-legacy`). Keeping a key copies it in held back, proves it with a real sign-in on that machine, and commits only if the proof passes.

## What to Tell Your User

Nothing changes for you: everything here is off on the fleet, and the sign-in step stays off until you decide to turn it on.

## Summary of New Capabilities

On development agents, the passkey readiness of each account is computed from its real state, and old prototype passkeys can be taken over safely, one machine at a time, from the dashboard.

## Evidence

Unit tests: tests/unit/passkey-repair-admission.test.ts, tests/unit/passkey-chrome-gate.test.ts, tests/unit/passkey-legacy-adoption.test.ts, and new cases in tests/unit/passkey-cold-proof.test.ts and tests/unit/passkey-credential-store.test.ts. Runtime: new cases in tests/integration/subscription-relogin-runtime-passkey.test.ts.
