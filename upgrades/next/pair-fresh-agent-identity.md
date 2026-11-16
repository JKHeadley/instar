<!-- bump: patch -->
## What Changed

Pairing a brand-new agent with a second machine now works when the agent was set up with the Threadline relay off. Such an agent never created its agent identity (only the relay client did), so the first `instar pair` had nothing to hand over. The joiner then refused to invent one (correctly) and printed that the other machine was "likely on an older version", even when both ran the same release. Once the joiner was registered, the first machine counted as part of a mesh and refused to create one later, so retrying failed the same way.

What changes:
- The pairing route now creates the agent identity at the first pairing, while the machine is still the agent's only one. This happens after the code is checked and before the joiner is registered, through the same guarded path that refuses wherever another machine is listed.
- When the pairing response carries no identity, it says why (`agentIdentityAbsent`), and the joiner prints that reason. "Older version" is printed only for a response that gives no reason at all.
- The response carries the agent's name. A joiner whose config names no agent adopts it, so a project folder named differently no longer fails the handover with `transcript-agent-mismatch`.
- The master-key keychain warning no longer claims the key is "only in memory, lost on restart". When the keychain cannot be written (for example over SSH on macOS), the key is kept in the owner-only key file, as before.

## What to Tell Your User

Adding a second machine to a new agent now works the first time, even if the agent was set up without the relay. If it cannot finish, it now says the real reason instead of claiming the other machine is out of date.

## Summary of New Capabilities

- The first pairing of a new agent creates and hands over the agent identity.
- Pairing explains why no identity was handed over, in plain words.

## Evidence

Live two-machine test 2026-11-16 (Studio + M5, both 1.3.1824): `[pair] no agent identity on this machine to hand over`, the joiner printed "likely on an older version", and a re-pair was then refused by the mint guard. Test coverage:
- Integration over the real pair route: a fresh inviter hands over an identity that the joiner installs with the same fingerprint, a second pairing reuses it, and an inviter that already lists another machine refuses with a named reason (never "older version").
- E2E in production order: a joiner folder named `robust-xm` adopts the agent name `xmproof` and installs the handed-over identity.
