# Principal Guard (Phase 1 brain) — ELI16

> The one-line version: a detector that reads the agent's own writing and flags it whenever the agent credits a decision to a person who isn't the verified operator and isn't a known user — the structural catch for the Caroline failure.

## The problem in one breath

On a shared machine, my overnight session credited my real operator's decisions to a different real person ("Caroline") across three documents — "Mandate (Caroline)," "Locked with Caroline," "have Caroline drop a token" — and nothing noticed, because the mix-up was in the agent's own writing, not in any message someone sent. The existing gate only watches who is allowed to message the agent; nothing watched whom the agent decided to credit and act for.

## What already exists

Instar has a user registry (the authoritative list of real principals) and an onboarding gate for inbound messages. What it lacked is a check on the agent's own output for misattributed authority. The "Know Your Principal" constitution standard (just ratified) requires exactly that check.

## What this adds

A pure-logic module, `PrincipalGuard`, that is the testable brain of that check:
- It establishes a topic's operator only from the platform-verified sender id — never from a name read in text (so a name in a document can never become the operator).
- It scans agent-authored text for operator-role decision shapes ("X approved," "Mandate (X)," "locked with X," "X dropped a token," "on behalf of X") and pulls out the credited name.
- It flags any credited name that isn't the bound operator and doesn't resolve to a known user — blocking when the decision carries authority or credentials (a mandate, a token drop), warning for ordinary prose.

## The safeguards

It's deterministic and self-contained — no network, no files, not wired into the live request path yet (that's a later increment), so it can't affect the running server. It ships with the incident-replay regression test the spec requires: the three real Caroline document lines, with the topic bound to my operator, must all be caught (block for the mandate and credential lines, warn for the rest); and the same lines crediting the bound operator must all pass, so it doesn't cry wolf. Capitalized non-names like "Production approved" are deliberately not flagged.

## What ships when

This is the first, foundational, fully-tested piece. The later increments wire it into the topic-operator binding, the session-start "who is my operator" injection, and the outbound/at-rest review path.
