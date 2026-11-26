# Declaring who may switch pairing on — Plain-English Overview

## The problem

When I run on more than one machine, every write I can perform has to say which
machine is allowed to perform it. There is a check that refuses to let a new
write-capable endpoint exist without that declaration, because an undeclared one
is a write nobody has reasoned about — on a multi-machine setup that is how two
machines end up both editing the same thing.

The endpoint that switches pairing on (`POST /threadline/pairing/enable`,
PR #2248) arrived without its declaration, so the check was failing and the test
suite was red on the main branch.

## What changes

The endpoint is declared with the same classification its four siblings already
carry: the machine holding the agent-network identity is the one that performs
it. Nothing about the endpoint's behaviour changes — this is a declaration of
existing behaviour, not a new rule.

## The judgement, stated rather than hidden

The honest argument for the other answer: this endpoint writes two settings in
*this* machine's own config file and raises *this* machine's own restart flag.
Both are per-machine things, which points at "every machine decides for itself".

I chose the sibling classification anyway, for two reasons. The endpoint already
reports "not available here" on a machine that does not hold the agent-network
identity, exactly as its siblings do. And the documented way a person asks me to
connect to another agent moves the conversation to that machine first, rather
than switching a standby on where it would sit inert.

The comment in the code says what would change the answer: if a standby machine
is meant to be able to switch itself on, the declaration becomes the
per-machine kind, which additionally has to describe how the two machines'
answers reconcile. That is a decision for whoever owns the feature, and it is
not something a repair to a failing check should decide quietly.

## Safeguards and limits

No behaviour changes, no new endpoint, no stored data, no message to anyone.
Rollback is deleting one line. If the classification is wrong in the direction I
argued above, the visible symptom is a standby machine refusing to switch itself
on — which the existing refusal already reports by name rather than failing
silently.
