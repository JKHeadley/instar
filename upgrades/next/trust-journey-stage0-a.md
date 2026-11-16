<!-- bump: patch -->
## What Changed

A change that widens what the agent may do now needs the person's own approval, never the agent's token or the dashboard PIN. This is the first part of the trust journey (docs/specs/trust-journey.md, stage 0). Widening covers a higher trust level for a service, a wider autonomy profile, turning off the external-operation gate or loosening its limits, letting evolution approve or implement its own proposals, making a Slack account owner or admin, and a looser work board policy. Such a request is refused with `403 operator-approval-required` and a message naming the approval it needs. The approval path itself (a request card in the person's direct chat, answered with `approve <code>`) ships in the next part, so for now a widening stays refused. Narrowing ("ask me first", "never do this", a stricter profile) applies at once, as before. Approval rows the agent reports itself are stored labelled as agent-reported and no longer count toward suggestions or auto-approval eligibility. Existing settings are unchanged.

## What to Tell Your User

- "Making me more independent now needs your approval, not mine. If you ask me to stop asking about something, or to work more on my own, I'll tell you the setting stays as it is for now. The approval step, where you confirm from your own chat with me, is coming in the next update."
- "Anything that makes me more careful still works straight away."

## Summary of New Capabilities

- Widening trust, autonomy, the external-operation gate's limits or evolution autonomy needs the person's approval; the request is refused and names the approval it needs.
- Approval records the agent reports itself are labelled and no longer count as the person's decisions.

## Evidence

- `tests/unit/TrustRaiseGuard.test.ts`, `tests/integration/trust-raise-refusal-routes.test.ts`, and the updated autonomy and trust-elevation lifecycle tests.
- Live proof on a throwaway agent: see the PR.
