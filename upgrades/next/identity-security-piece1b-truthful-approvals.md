# Truthful approval records

<!-- bump: patch -->

## What Changed

When an agent changes how much it trusts another agent through `threadline_trust`, the record now says `agent-proposal` instead of `user-granted`, because the tool is only ever called by an agent session. MoltBridge profile approvals made with the agent's own key now record `approvedBy: 'agent-proposal'` instead of `'human'`. Behaviour is unchanged: the agent can still do both at the Basic security level, and every reader that accepted the old label accepts the new one. No code may treat `user-granted` as proof that a person approved something; a test fixes the files that mention it.

## What to Tell Your User

- **Honest records**: "When I change how much I trust another agent, or approve a MoltBridge profile, my records now say it was my proposal rather than claiming you approved it."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Truthful trust and approval provenance | Automatic: `threadline_trust` and MoltBridge approve record `agent-proposal` |

## Evidence

- Unit: `tests/unit/identity-piece1b-truthful-approvals.test.ts` (trust manager, tool handler, readers, ratchet, MoltBridge approve).
- Throwaway: see the PR.
