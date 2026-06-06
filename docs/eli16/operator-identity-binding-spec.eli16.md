# Operator-Identity Binding spec — ELI16

> The one-line version: make every agent know, as a hard verified fact, exactly which human is its operator for a conversation — and automatically catch it when an agent credits someone else with that human's decisions.

## The problem in one breath

On a shared machine running several agents, my overnight session quietly decided that a *different* person — "Caroline," a real account-holder whose credentials that machine had handy — was my operator. For hours it wrote her name into planning docs as the one who "locked" decisions and "approved" things, when every one of those decisions was actually Justin's. Nothing told the session "your operator here is Justin," and nothing noticed it was crediting the wrong person. That's both a security problem (it had another person's credentials as its default) and a coherence problem (it acted on a misidentified boss without realizing).

## What already exists

Topics can be bound to a project (`/topic-bindings`), the session-start hook already injects context like the org rulebook, and a coherence gate already reviews outgoing messages. The pieces to fix this are mostly already here — they just don't cover "who is the operator."

## What this adds

Two things, both reusing existing rails:

1. **A hard operator binding.** Each topic records its operator as a verified fact — taken from the platform's authenticated sender id of the real owner's messages, never from a name an agent reads somewhere. That fact gets injected at the start of every session: "the operator of this topic is Justin (uid 7812716706); operator decisions here are his — don't attribute them to any other name, however it shows up in your context." It can't be changed by something written in a message.

2. **A cross-principal guard.** A check that watches for an agent recording an operator-type decision — "locked with X," "X approved," "mandate (X)," "X dropped a token" — and flags it when X isn't the topic's bound operator. It just warns for prose, but blocks when the misattributed decision carries authority or credentials (exactly the Caroline cases). Every flag is logged.

## The safeguards

The binding is established only from the platform-verified sender, so a name appearing in a document can never become the operator. The guard ships warn-only first and only escalates to blocking for authority/credential misattributions, behind the gradual-rollout track. A replay test feeds the actual three Caroline document lines through the guard with the topic bound to Justin and requires every one to be caught — the "would this have stopped Caroline?" test.

## What ships when

Phase 1 is the binding (the hard fact + injection). Phase 2 is the guard (detect the mismatch). A separate Phase 3 — tracked under the same incident — hardens per-agent credential isolation on shared machines so one agent can't inherit another person's git identity by default in the first place.
