# ACT-896 — Deferral pattern sentinel, increment 1

## What Changed

Added the pure, injected core of a signal-only sentinel that consumes the canonical
premature-deferral recognizer's existing content-free tone-provenance observations.
At the configured recent-distinct threshold it produces one stable, deduped
Attention input. It is dark by default, dry-run first, fails toward silence, owns
no parallel recognizer or storage, and is intentionally not boot-wired in this
increment.

## What to Tell Your User

Instar now has the inert core needed to notice when several recent messages share
the same premature “hand this back to the user” pattern. This increment does not
send an alert yet: it starts dark, defaults to dry-run, and has no boot wiring.
When a later increment connects it to Attention, repeated matches will collapse
into one review item rather than creating notification noise.

## Summary of New Capabilities

- Content-free aggregation over the existing deferral recognizer provenance.
- Stable dedupe identity for one eventual Attention item.
- Dark, dry-run-first posture with no new matcher, ledger, timer, or boot path.

## Evidence

Unit coverage locks dark/no-read, below/exact threshold, canonical-recognizer
consumption, replay dedupe, time-window edges, malformed/negative/future exclusion,
dry-run/live behavior, fail-toward-silence, audit containment, config posture,
content-free status, and stable Attention dedupe.
