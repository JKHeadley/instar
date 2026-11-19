# Truthful approval records, explained simply

A security check of how your agent knows who it is talking to found records that said a person had approved something when actually the agent had. This change fixes two of them.

1. **Agent-to-agent trust.** When your agent raised or lowered how much it trusts another agent, the record said "the user granted it". Now it says it was the agent's proposal. The agent can still do this for now; later, raising trust will need your tap on your phone.
2. **MoltBridge profile approvals.** They said "human" even when the agent approved them through its own key. They now say "agent proposal". Publishing works exactly as before.

Nothing else changes. The point is that no later part of the system should ever mistake the agent's own decision for yours. Other fixes from the same check (signed WhatsApp messages, Telegram's open door when it has no allowlist, text messages that can't prove who sent them, and agents with no API key) each need more care and come in their own small changes.
