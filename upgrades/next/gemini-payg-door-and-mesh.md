# The Gemini pay-per-use door, ready but switched off

<!-- bump: patch -->

## What Changed

The Gemini pay-per-use lane's working parts are in place. It stays off until the operator approves it once with their PIN, and nothing in this release does that.
- **One door to Google's Gemini API, inside the server.** It counts the request's tokens first, reserves the most the call could cost, makes one call (never retried), and books the real cost from Google's own counts. If it can't tell whether Google charged, it counts the call as spent. The key is read by one piece of code and travels only in a request header.
- **Two uses.**
  - A second opinion any session can ask for (Hydrogen by default, Neon on request).
  - Gemini Neon as an independent reviewer in spec reviews. Where the lane is set up, it replaces the Gemini CLI there, with no CLI fallback.
- **One machine spends.** Every other machine forwards its requests to the designated machine and waits for the answer, and a request is never paid for twice. Stop actions reach the spending machine. If it can't be reached, the stop is kept and retried until it is confirmed, and the agent never says "stopped" before then. The spending machine checks every 10 seconds that another machine can still see it, and stops spending within about a minute if it is cut off.
- **A safety fix in the money layer.** The spending check identified machines by a setting most agents never set, so on an agent with several machines every machine would have looked like the single allowed spender. It now uses each machine's real identity.

## What to Tell Your User

- **Gemini is wired in, still off**: "The pieces for the Gemini pay-per-use lane are in: second opinions from Gemini Hydrogen or Neon, and Neon as a reviewer of design documents. Nothing can spend yet. It switches on only after you approve it with your PIN, and I'll send you a card for that when it's ready."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Gemini second opinion (after go-live) | Ask me for Gemini's view on something |
| Gemini Neon as a spec reviewer (after go-live) | Automatic in spec reviews once the lane is on |

## Evidence

- Unit: `tests/unit/gemini-api-provider.test.ts`, `tests/unit/metered-lane-mesh.test.ts`, `tests/unit/crossModelReviewer-gemini-api.test.ts`.
- Integration: `tests/integration/gemini-payg-second-opinion-route.test.ts` (fake Google endpoint), `tests/integration/gemini-payg-two-machines.test.ts` (two machines, one spender).
- E2E: `tests/e2e/gemini-payg-lane-alive.test.ts` (production init path, dark by default).
