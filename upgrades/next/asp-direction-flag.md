# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The agent-signature provenance recorder now looks only at **incoming** messages.

The seam it attaches to carries messages in both directions and hands over a flag
saying which way each one travelled. The recorder accepted that flag and never
read it, so it also inspected the agent's own outgoing messages and wrote them
into the classification ledger.

Nothing was ever mislabelled in a misleading direction, and no message was
blocked, delayed or altered — but the ledger's only job is to answer "did this
come from the operator, or from an agent", and rows about the agent's own
outbound traffic are noise in exactly that evidence.

Found by reading the deployed system rather than by a test: a real ledger row's
byte count matched a message the agent had just sent itself.

## What to Tell Your User

- "The record of who wrote what now only covers messages that arrived, which is
  what it was always meant to mean."
- "Nothing was ever attributed to you that wasn't yours — this removes clutter
  from the evidence, not a mistake in it."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Skipped-outbound visibility | `counters.skippedOutbound` on the classifier |

No new endpoints and no configuration.

## Compatibility Notes

Only an **explicit** outbound mark is skipped. A caller that does not supply the
direction still has its messages classified, so nothing silently loses provenance
by omission — the behaviour fails toward recording rather than toward silence.

Ledger rows written before this change remain valid and correctly shaped; there
are simply fewer new ones.

## Evidence

15 tests in the classifier file (11 pre-existing, 4 new). The new ones pin all
three directions: an explicitly outbound entry is skipped and unrecorded; the
SAME bytes marked inbound are classified and recorded; an absent flag still
classifies; and the chained handler honours direction too.

The inbound case is a deliberate control — without it, the outbound test would
pass just as well against a classifier that had stopped working entirely.

Shown capable of failing: with the skip disabled, exactly those 2 outbound
assertions fail while the other 13 pass, so the tests measure this change rather
than something adjacent.
