---
title: Passkey sign-in repair and legacy passkey adoption
---
On a development agent with passkeys on, a sign-in repair for an account whose login method is `google-passkey` is admitted only when that account's passkey is ready on this machine: an active grant, a usable key, this Chrome version checked, and a passing sign-in proof in the last 21 days. Any other state is refused by name. Only the Google sign-in step uses the passkey browser. It signs the account's own profile in to Google and closes, and the Claude or Codex sign-in that follows runs in the normal browser as usual. That step is off unless `passkeys.repairUsesPasskey` is true, and turning it on for a real account is the operator's decision, never yours.

Old prototype keys (`google_passkey_*` in the shared vault) are listed by name with `curl -H "Authorization: Bearer $AUTH" http://localhost:{{port}}/passkeys/legacy`. The operator keeps or deletes each one from the dashboard, which needs the PIN. Keeping one runs a real sign-in proof on this machine first and commits only if it passes. Never ask the operator to paste the PIN into chat.
