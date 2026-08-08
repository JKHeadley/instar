# PROPOSED AMENDMENT — Authoritative User-Facing Identification

**Status:** Proposal only. Not ratified and deliberately not written into the standards registry.
**Proposed family:** Building.
**Proposed disposition:** Amend *Live-User-Channel Proof Before Done*; that article already owns the
completion obligation, while this proposal supplies its missing scope boundary.

## The obligation

Any feature whose behavior can be invoked, observed, or changed through a user-role channel is
user-facing for completion purposes unless a structural surface inventory proves that it cannot be.

Author declaration is evidence, not the authority. An omitted declaration must not turn a real user
surface into an untested internal feature.

## Proposed identification mechanism

The authority should be a closed inventory of real user surfaces and their registered entry points:
Telegram and Slack ingress/egress seams, operator HTTP routes, dashboard pages and actions, exposed
CLI commands, and user-controlled configuration boundaries. A feature spec names the surface IDs it
touches; the live-test gate joins those IDs to the required user-role scenario matrix.

The failure direction is **fail closed toward user-facing**. If a changed feature reaches a registered
surface, or if surface ownership cannot be resolved, it requires live proof. An explicit internal-only
classification is allowed only when the feature has no registered user-surface edge and its change
does not alter one. This is a structural boundary check, not a keyword classifier: meaning such as
“sounds like a UI feature” is not inferred from prose.

This amendment should not make every internal helper pay for a live session. The cost is limited by
the surface inventory: a helper that is genuinely below the boundary inherits the surface declaration
of its caller, while an unresolvable edge pays the safer user-facing tax.

## What it would measure and certify

**Measure:** the changed feature's declared surface IDs, the concrete registered entry points reached,
the unresolved-surface state, and the live-test artifact covering each required user role and channel.

**Certify:** only that the known, registered surfaces were driven and that an artifact exists for them.
It cannot certify that the inventory contains every possible plugin, dynamically mounted route, or
future adapter. Inventory completeness remains a separate review claim and must be named as such.

## A feature that would escape

A plugin loads a route dynamically through a generic router factory that is not registered in the
surface inventory. Its spec says “internal helper,” so the changed-file and known-surface checks pass,
but the plugin exposes a user-invocable endpoint. The feature still reaches an operator untested.
This is the required negative control: it demonstrates that a registry-based authority measures
coverage of the registered population, not universal discovery.

## Enforcement honesty and countdown

The current live-test gate has real veto teeth once a feature is declared user-facing, but it does not
authoritatively discover undeclared surfaces. No existing guard certifies the inventory's completeness
or turns an unresolved boundary into a veto. The proposal must therefore be labeled **documented-only
until 2026-09-07**, tracked as `STD-COUNTDOWN-user-facing-identification`, unless a structural
surface-inventory guard lands first.

The guard that would close the countdown is an enumerable, registry-backed surface join with a
fail-closed unresolved state. It must not be replaced by a word list or an LLM guessing from feature
names.
