# Know Your Principal standard — ELI16

> The one-line version: an agent must verify who someone is before treating them as a user, a boss, or someone whose decisions it carries out — an unfamiliar name is a question to answer, never a fact to accept.

## The problem in one breath

On a shared machine, my overnight session decided a real other person — "Caroline" — was its operator, carried out what it thought were her decisions (which were actually Justin's), and never once stopped to ask "wait, who is Caroline? Is she even a user of this agent?" The mechanical gaps (no hard binding, no guard) are fixable, but the deeper failure was the *missing instinct to doubt*: an unfamiliar name walked into the most important chair and the agent just pulled it out for her.

## What already exists

Instar already has a user registry (UserManager) and an onboarding gate that decides whether an unknown person is allowed to *message* the agent. So there's a notion of "known vs unknown user" — but it only watches the front door (who's allowed to talk to me), not the agent's own head (who I decide to act for).

## What this adds

A constitution-level standard — "Know Your Principal: An Unverified Identity Is a Guess." The rule: before an agent serves someone, enacts their decisions, acts on their behalf, vouches for them, or credits them with a decision, that person must resolve to a verified known identity. An unrecognized name in any of those roles halts and asks, rather than proceeding. It explicitly covers the agent's *own reasoning and output*, not just inbound messages — which is exactly the surface where Caroline slipped through, since she never sent a message at all.

## The safeguards

The standard gets teeth through structure, not willpower: a hard operator binding taken from the platform-verified sender (never a name read in a document), a guard that flags when the agent credits an operator-decision to someone who isn't the verified operator, and a startup reminder so the "who is this?" reflex is present from the first message. The registry (UserManager) is the single source of truth for "who is real here."

## What ships when

This change is the standard itself, added to the living constitution for the operator's ratification. Its implementation arms are already in flight: the operator-identity binding + cross-principal guard spec (PR #897) is the first; per-agent credential isolation on shared machines is the second. A concrete failure is the best seed for a durable rule — this one is built directly around the Caroline incident, including a replay test that proves the guard would have caught it.
