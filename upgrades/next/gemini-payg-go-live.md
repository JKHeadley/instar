# The Gemini pay-per-use lane can be switched on with one approval

<!-- bump: patch -->

## What Changed

The last piece of the Gemini pay-per-use lane is in: the one approval that turns it on, and the check that has to pass before it spends. It stays off on every agent until its operator approves it.
- **One approval, one PIN.** The agent prepares a plan on the machine that will spend. The plan lists every limit in plain words: Justin's $50 a month, plus the agent's proposed $10 a day, $2.50 per call and a $10 limit on uncertain charges, each marked as changeable. Approving it with the PIN turns the spending controls on and restarts the agent server by itself, with the same safety checks as the existing restart button. If the spending controls were already on, nothing restarts.
- **Checks before the plan is even shown.** The plan appears only when the new key is shown to be on the spending machine alone, no other machine holds it, no other machine claims the lane, and the key never appeared in the account lane's transcripts. Anything missing is named.
- **A proof call before real use.** After approval the door waits. One tiny call on the cheapest model must succeed, Google's prices must be confirmed, and one reading of Google's bill must be on record, before reviews and second opinions can use it.
- **Stopping is instant from any machine.** The agent can lower a limit, turn off a caller or freeze the key without asking, and it reaches the spending machine. Raising anything still needs the PIN.
- **Seeing it.** The Spend tab and the phone show this month's Gemini spend against its limit, and asking "how much have we spent on Gemini?" gets the real figure.

## What to Tell Your User

- **Gemini can now be switched on**: "The Gemini pay-per-use lane is complete. When the new key is ready I'll send you one card with every limit spelled out; one PIN approves it, and I handle the restart. After a small test call it's live for reviews and second opinions."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Switch the Gemini lane on | Approve the card I send, with your PIN |
| See Gemini spend | Ask me, or look at the Spend tab |
| Stop or reduce Gemini spending | Ask me ("stop Gemini for now") |

## Evidence

- Unit: `tests/unit/gemini-payg-go-live.test.ts`, `tests/unit/gemini-payg-release-gate.test.ts`.
- Integration: `tests/integration/gemini-payg-go-live-plan.test.ts` (two machines: render, forwarded render, secret-names, one PIN commit and restart, apply, version drift, reduce-only stops, forwarded proof).
- E2E: `tests/e2e/gemini-payg-go-live-alive.test.ts` (approve, restart, apply, proof, then a real answer, a refusal at the month limit, and the next month reopening).
