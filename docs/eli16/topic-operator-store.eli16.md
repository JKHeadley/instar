# TopicOperatorStore — ELI16

> The one-line version: a small durable store that records, for each conversation, who the verified operator is — taken only from the platform-authenticated sender, never from a name in a document — so an agent always knows whose decisions it is acting on.

## The problem in one breath

The "Know Your Principal" standard says an agent must know its verified operator and never adopt an unfamiliar name as its boss. The detector (PrincipalGuard) was built first; now we need somewhere to actually KEEP each topic's verified operator, and a way to hand it to the session at startup.

## What already exists

The detector brain (PrincipalGuard) that flags misattributions, the user registry, and a separate topic→project binding. The operator binding didn't have a home yet.

## What this adds

`TopicOperatorStore` — a tiny JSON-backed store (`state/topic-operators.json`) that:
- Records a topic's operator ONLY via the authenticated sender id (it calls the existing establishOperator, so a name read from content can never become the operator).
- Is deliberately SEPARATE from the topic→project binding — a topic can have a verified operator without any project attached, and forcing a project binding just to record an operator would be wrong.
- Produces the `<topic-operator>` block that the session-start hook will inject, so the agent reasons with its verified operator from message one.

## The safeguards

A blank sender id is refused (no operator without a verified id). The store fails safe — a missing or corrupt file means "no operator," which makes the guard treat everything as unverifiable rather than trusting a guess. Ten unit tests cover both sides of every case (valid vs blank id, bound vs unbound, persistence across restarts, the injection block, and the by-construction rule that a content name can never become the operator).

## What ships when

This is the store (increment 2 of the security build). The routes that set/read it and the session-start hook that injects its block come next; wiring the detector into the live message-review path is the final, most careful increment.
