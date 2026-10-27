# Approved subscription sign-in across agents — Plain-English overview

> The rule: an agent should use an existing approval to sign in, and it should require proof that a relayed approval really came from the same person.

## The problem

Scout was asking for approval as if all of its Claude repairs were new decisions. Its own configuration already names all eight Claude identities for unattended repair, and one repair started under that policy. The repairs stopped because six Google browser profiles had no signed-in session. Earlier sign-in instructions also said a password and authenticator secret had to be in the local vault before any first sign-in, which incorrectly made one recovery method look mandatory.

## What already exists

Instar knows the verified Telegram sender in each agent's own topic. It can carry signed approvals between machines of one agent. Scout's unattended repair policy can already start a Claude repair without another tap. Threadline identifies the sending agent; it does not prove who wrote the human approval that agent describes.

## What this change adds

The built-in sign-in guide and the instructions installed for new and existing agents now tell them to check exact-identity standing repair approval first, finish the setup they own, and distinguish a real Google challenge from an invented policy blocker. They must inspect credential sources they already may use before asking for a new secret. A first Google sign-in can create a warm session without moving credentials. Durable recovery needs a method that is actually proven on that machine. Copying passwords or authenticator seeds to another agent's vault needs separate approval.

## Safeguards and remaining work

A peer's statement that the operator approved something cannot become authorization by itself. Until Instar has a signed, scoped operator-origin receipt, a new action outside an existing standing policy requires direct authenticated approval or a PIN-authored mandate at the target. The receipt implementation is tracked in issue #2413. This change does not activate Scout's passkey feature, sign in an account, or transfer a credential.

## Decision

This guidance change is reversible and changes no runtime allow/deny code. It can be reviewed as a small Instar update while the receipt feature receives its own security review.
