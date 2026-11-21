# The Gemini setup plan gets its screen, and four defects found by driving it for real

<!-- bump: patch -->

## What Changed

The Gemini pay-per-use lane was driven end to end the way the operator will use it, on throwaway test agents talking to a fake Google, before anyone is asked to approve it. Four things were wrong and are fixed here:

- **The setup plan had no screen.** The approval card points at the Spend tab, but the Spend tab never showed the Gemini setup plan or took the PIN for it. It now does, at the top of the tab: the plan's first line ("Gemini joins as a reviewer and a second opinion. Choosing it as a conversation's engine is not in this version.") leads, every committed field follows in the server's own words, and one PIN approves it. The approval restarts the server by itself, so the page never asks for a second PIN.
- **The spending controls failed their start-up check after every restart on a multi-machine agent.** The start-up self-test of the spending controls was held to the same "is the spender still confirmed by the other machines?" check as real spending, and that confirmation does not exist yet at boot. The money layer therefore came up "probe failed" after every restart and nothing could spend until someone re-checked it by hand. The self-test is exempt now; real spending still needs the confirmation.
- **Long Gemini calls were cut off after 30 seconds.** A second opinion, a review or the one release proof could take longer than the server's 30-second default, especially from a machine that forwards to the spender, and the caller got a timeout while the call kept going. Those routes now wait as long as the call itself can take. With the spender down, a forwarding machine now answers "the machine that spends cannot be reached" instead of a timeout.
- **The documented way to store the key had a missing piece.** The key is meant to travel from the Secret Drop straight into the vault without ever being shown (`… --run -- secret-set.mjs gemini_api_key_payg`), but `secret-set.mjs` did not exist. It does now: it reads the value from stdin only, refuses a terminal and refuses a value on the command line, and prints nothing but the key name and length. New agents get it at setup; existing agents get it on update.

Also new, read-only: the release view on the spending machine says whether its "still the spender" confirmation is current (`lease` in `GET /routing-spend/gemini-payg/release`).

The live test itself ships as a script (`scripts/gemini-payg-live-test.mjs`): two real servers paired as one agent's two machines, a fleet-default agent and a single machine, a fake Google, headless Chromium on the real dashboard, and a signed scenario record for the setup flow and for the spender-down drill.

## What to Tell Your User

- **Nothing changes yet**: "Before I ask you to approve Gemini I ran the whole setup on test copies of me with a fake Google, and fixed four things that would have bitten — including a Spend-tab screen for the approval that was missing. Nothing is switched on, and no money moved."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Gemini setup plan on the Spend tab | Opens automatically on the Spend tab when a setup is proposed; approve with your PIN |
| Store a key without showing it | `secret-drop-retrieve.mjs <token> <field> --run -- node .instar/scripts/secret-set.mjs <name>` (agent-side) |

## Evidence

- Unit: `tests/unit/secret-set-script.test.ts`, `tests/unit/spend-arming-gemini-setup.test.ts`, `tests/unit/gemini-payg-live-test-lib.test.ts`, `tests/unit/gemini-payg-money-model.test.ts` (probe vs the lease fence), `tests/unit/AgentServer-outbound-timeout.test.ts` (route budgets).
- Integration: `tests/integration/gemini-payg-go-live-plan.test.ts` (the release view's lease field).
- Live: `scripts/gemini-payg-live-test.mjs` on real throwaway server processes, with the signed artifacts named in the side-effects review.
