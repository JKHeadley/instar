# Pay-per-use keys stay inside their door

<!-- bump: patch -->

## What Changed

Pay-per-use provider keys (the Gemini pay-per-use key and any vault name starting with `metered_`) are now confined, ahead of the Gemini pay-per-use lane:
- **Sessions cannot read them.** The vault reader script refuses these names before it looks anywhere, in every mode, with "refused: metered key — readable only by its door".
- **They no longer copy to other machines.** Vault sync now filters per machine: a metered key goes only to the one machine designated to spend it, and with no designation (today) it goes nowhere. A machine that receives one from an older peer drops it.
- **They never enter a child program's environment.** A Google API-key credential is now refused instead of being passed to a child as an environment variable, and a new check proves the key's value never reaches any of the five frameworks' child environments.
- **One reader, enforced at build time.** A new lint refuses any code that reads one of these keys by name outside the door that will own it.

This also stops a paid path that was spending outside Instar's money limits: the standing security-review job ran the Gemini CLI with the bench key on its command line. Its Gemini voice now reports as unreachable until the metered lane is live.

## What to Tell Your User

- **Paid keys are locked down**: "Keys that bill by usage are now locked inside the one piece of Instar allowed to use them. My sessions can't print them, and they don't get copied between machines. A security-review job that had been spending on one of them outside my limits is stopped."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Metered keys confined to their door | Automatic |

## Evidence

- Unit: `tests/unit/metered-secret-confinement.test.ts` (list, per-recipient sync, receive strip, secret-get refusal in every branch + drift pin, lint, five-framework value canary), `tests/unit/providerCredentials.test.ts`.
