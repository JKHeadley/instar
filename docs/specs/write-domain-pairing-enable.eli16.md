# Classifying the pairing-enable route — Plain-English Overview

## The problem in one breath

A safety check that every state-changing web route must declare *where* its writes live was failing,
because one newly-added route had never been declared. While it fails, no pull request touching that
code can merge.

## What already exists

Instar runs on more than one machine, so every route that writes something has to say which kind of
state it touches: this machine only, one conversation, or state shared by the whole set of machines.
A test called the write-domain ratchet walks every route and fails if one is undeclared. The list of
undeclared routes may only ever shrink.

## What this adds

One declaration. The route that switches agent-to-agent pairing on arrived with recent work and was
never classified, so the ratchet correctly caught it and went red.

It is declared the same way as every other route in its family — as writing shared state — for two
reasons the registry itself states: that is the conservative default, and the fact that the route only
*runs* on one machine does not make what it writes machine-only. The alternative classification would
require arguing a separate claim about how that state converges, which this change does not need.

## The safeguards

- Declaring a route changes no behaviour. Nothing is blocked, allowed, or rerouted differently; it
  records a fact about an existing route so the check can verify it.
- The conservative classification cannot under-protect: shared state is the stricter of the two.

## What ships when

Immediately. There is no flag, no configuration, and no migration.

## What you actually need to decide

Nothing.
