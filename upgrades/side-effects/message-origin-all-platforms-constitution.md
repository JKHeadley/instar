# Side effects: message origin rule covers every platform

Constitution text only (docs/STANDARDS-REGISTRY.md, article "Telegram Message Origin Is Mandatory; Its Display Is Optional"). The Rule now covers every message an agent sends to a user on any platform. The Ratified and Applied-through fields cite Justin's 2026-11-03 request and approval (topic 134088) and the Slack and app-conversation implementation (PR 2669). The title is unchanged because the registry's continuity check treats a renamed article as a removed one.

1. Over-block: none at runtime. The text can mark WhatsApp and iMessage as a conformance gap (ACT-023); it blocks nothing.
2. Under-block: WhatsApp and iMessage do not record origin yet (ACT-023).
3. Level of abstraction: the constitution states the rule; the code enforces it per platform.
4. Signal vs authority: no new gate.
5. Interactions: the Interaction area audit is re-recorded with an independent review.
6. External surfaces: none.
7. Multi-machine posture: not applicable (documentation).
8. Rollback: revert the commit.

## Class-Closure Declaration

- `unbounded-self-action`: closure `n/a`. This is documentation only.
