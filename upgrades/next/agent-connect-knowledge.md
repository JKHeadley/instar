# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **Agents now know how to connect to another agent.** When a person says "connect with Echo", "talk to Scout" or "pair with Carl's agent", the agent offers a pairing invite. It makes the invite (`threadline_pair` with `action: "invite"`), gives the person the message with one sentence on where to send it (privately to the other agent's person, or straight to the other agent's Telegram chat if the same person owns both), tells them the other person will tap Approve and they will tap Finish, checks `GET /threadline/pairing` for `mutual-verified`, and then says hello. It never asks the person for a fingerprint, an address or a setting, never offers a "bundle", and never sends the invite over Threadline. A brand-new agent did all three of those things on 2026-10-20 because its instructions described pairing only as a step before sharing a secret. Spec for the flow: `docs/specs/a2a-pairing-invite-link.md`.
- If the agent's network or pairing is switched off, the agent switches both on for itself when its person asks to connect (`threadline.relayEnabled` and `threadline.verifiedPairing.enabled`), and asks its person, in one sentence, to send `/lifeline restart` so the change takes effect. Fleet defaults are unchanged.
- The CLAUDE.md Threadline tools list now includes `threadline_pair`, and "connect with <agent>" is listed under How to Use, for new and existing agents alike.
- Existing agents receive the same section and both bullets on update. The section goes before the Threadline tools list (or at the end if that heading is missing); the `threadline_pair` bullet goes at the end of the Threadline tools list and the "connect with <agent>" bullet at the end of the Threadline How to Use list (each just before the section if its list is missing). Each is checked for separately, so an agent that already has one is never given it twice. The self-knowledge tree gains a `capabilities.agent_connect` node that reads the section.
- When the agent tells its person when the invite expires, it reads the time from the invite response (`exp`) and says it in the person's local time, since one hour is only the default.
- If making the invite answers 503 because another of the agent's machines holds the Threadline relay, the agent finds that machine (`GET /pool/placement`, `leaseHolderNickname`) and moves the conversation there with `POST /pool/transfer`, or names the machine to its person if the conversation cannot be moved.

## What to Tell Your User

If you want me to talk to another agent, just ask me to connect with it. I'll give you a short invite to send to that agent's person, or to forward to that agent's chat if it's yours too. They tap Approve, you tap Finish, and we're connected. You never need to look up IDs or change settings.

## Summary of New Capabilities

- "Connecting to another agent" section in CLAUDE.md (new and existing agents).
- Self-knowledge node `capabilities.agent_connect`.

## Evidence

- `tests/unit/agent-connect-knowledge.test.ts`: 19 tests. Covers the two bullets for existing agents (a pre-change CLAUDE.md ends up with the same Threadline region as a new agent, a re-run adds nothing, a file that already has the bullets keeps them once), the expiry read from the invite response, the relay-holder lever, and "fingerprint" no longer routing to `capabilities.agent_connect`. The instruction carries the key steps and prohibitions; a new agent gets it once inside the Threadline section; an existing agent's old CLAUDE.md receives the identical text once, in the same place, and a second update changes nothing; an existing tree gains the node, which serves the section; "connect with Echo" is routed to it.
- Breakage check: with the migration switched off, both existing-agent tests fail.
