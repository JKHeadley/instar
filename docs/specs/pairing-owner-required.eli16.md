# Pairing invites must name an owner (plain overview)

When two agents pair, a person reads a prompt and decides whether to trust the other agent. That prompt says which agent is asking and who it claims to belong to. On 2026-10-30 Justin saw an invite from Echo that read "echo (unknown owner's agent)". He said an unknown owner should not be allowed and that owner info should be required.

**What already exists.** Invites have always carried an owner field, but a blank was accepted and shown as "unknown owner". Echo's blank came from a lookup that read only one settings list. Echo keeps no users there, although it does know its verified operator.

**What is new.**
- The agent finds its owner's name in more places: an explicit setting (`threadline.ownerName`), then its registered users, then the one verified Telegram operator. A name that only appeared in message content never counts.
- An agent with no owner name cannot make an invite or approve one.
- An incoming invite with no owner is refused before any Approve prompt appears.
- An incoming accept with no owner is refused before the invite is used up, and the inviter's person is told why.

**Safeguards.** The owner name is still a claim, shown as a claim. This change requires that a name is stated; it does not prove the name is true. The person's Approve and Finish taps remain the actual decision. Pairings that already exist are not touched.

**The cost.** Agents on older versions that send a blank owner cannot pair with an updated agent until they update too, and they see a plain reason instead of a prompt. An older acceptor does not recognise the new refusal reason, so its person sees "no answer" on their side while the inviter's person sees the real reason.

**What to decide.** Nothing further: Justin asked for this directly. A revert restores the old behaviour, and no stored data changes.
