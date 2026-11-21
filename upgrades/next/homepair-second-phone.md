# Home pairing ends when a second phone uses the code, and counts phones on every machine

<!-- bump: patch -->

## What Changed

Security review of home (same-network) first-phone pairing. When a second phone presents a setup's code, the whole setup ends with reason `second-phone`, the phone already waiting is declined, and the home address closes if unused; `GET /mobile/phone-setup/:id` and `instar mobile add-phone` say a second phone tried and to start again. The number screen now says to type only the number shown on your own phone. The first-phone rule also counts owner phones paired through the agent's other machines, asked live; if any active machine cannot be asked, the setup is refused with `phone-check-incomplete`.

## What to Tell Your User

- **Safer first-phone setup at home**: "If someone else's phone tries the code I show when you add your phone at home, I now cancel that setup and tell you to start again. And I make sure none of my other computers already has your phone before I treat a phone as the first one."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| A second phone on one home-pairing code cancels the setup and is explained at the computer | Automatic |
| First-phone rule checks every machine of the agent, refusing when one cannot be asked | Automatic |

## Evidence

- `tests/integration/same-network-first-phone.test.ts`: over the real TLS listener, a second redeem ends the setup, declines the waiting phone, makes the right number useless and closes the address; an unreachable active machine refuses the setup before any code is shown.
- `tests/unit/owner-phones-other-machines.test.ts`: peer counting and every can't-tell case.
