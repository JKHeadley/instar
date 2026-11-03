## What Changed

A message sent from the Instar iPhone app showed "signature failed" on every message after the first when the phone reached the agent over a different address than the one it paired on (multi-route: the app prefers the machine's Tailscale name after pairing and signs the Host it actually used). The check compared the signed Host with the paired Host only.

- Each stored record now names the Host the signature was actually checked against (it stored the paired Host before, so a message over another route could never re-verify).
- `verifyRecordedOrigin` now accepts a signed Host other than the paired one only when this machine's own signed receipt for that request verifies (the receipt signs the canonical string, Host included, and is written only for a request the machine admitted on one of its own verified names). Without a receipt that reads `failed`; with a receipt key not yet known here, `unknown`.
- Nothing else in the check changes.

## What to Tell Your User

Messages you send from the app no longer show a broken signature mark just because your phone switched to the machine's Tailscale address.

## Evidence

Found on the first Linux cloud agent (fb-333dfbe3-b86): first message verified, every later one failed. The app signs the route's Host after pairing (AgentClient route clients). Unit tests cover: verified over another route with a good receipt, failed with none or with a receipt from another machine, unknown when the receipt key is unknown; every existing check still passes.

## Summary of New Capabilities

None.
