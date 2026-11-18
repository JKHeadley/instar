# Convergence Report — Team members talk to the agent in a conversation of their own, with no tools

**Spec:** [docs/specs/identity-security-piece1f-member-conversations.md](../identity-security-piece1f-member-conversations.md)
**Slug:** `identity-security-piece1f-member-conversations`
**Iterations:** 2 (round 2 was a delta check).
**Final-round design findings:** 0 internal. The cross-model items left are scope rulings recorded in the spec.

---

## ELI10 Overview

Until now, a team member's Telegram message went into the owner's conversation, which can run commands and use the owner's accounts. Now a team member gets a conversation of their own. The agent answers them with no tools at all, and what they say is kept in their own private record, out of the owner's conversations, memory and jobs. The owner still sees their messages in Telegram and can bring one in by quoting it.

## Original vs Converged

- **Originally:** a member turn went through the intelligence router; member words were diverted at the log writer; the change was dev-gated.
- **Round 1** found these problems:
  - the router can drop the no-tools lock;
  - the owner could be classed as a member;
  - several steps before the log carry authority (operator bind, profile ingress, prompt answers, observers);
  - members kept session controls;
  - the reply had no way into the member store.
- **The fixes:**
  - direct, locked-down per-framework calls;
  - a known owner who is not the member;
  - one check at the top of both entry paths;
  - no commands for members;
  - a dedicated reply sender.
- **The cross-model review** found two more. The draft contradicted the approved umbrella, which ships this on with notices, and a member's private-chat message would have been answered in the group. Both fixed.
- **The throwaway proof** added a fallback across the no-tools carriers (Claude was at its limit) and logging of failed turns.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | constitution (7 flags), combined security+integration+decision-completeness (5), Astra (8) | 5 + 8 | ~9 | carrier, member definition, entry-path check, commands, reply sender, rollout, chat keys |
| 2 | none (delta converged) | 0 | 7 | precision only |

## Full Findings Catalog

All answers are in the build state folder: `reviews/r5`, `reviews/p1f-r1`.

## Left behind

- Confined member sessions with a restricted tool set.
- The owner's selection card.
- Slack, WhatsApp and iMessage members.
- Replicating the member store (piece 4).
- `'*'` agents (piece 5).

## Convergence Verdict

Converged at round 2 (80/20). The spec carries `approved: true` under the approved umbrella and Justin's standing guidance. No constitution text changes.
