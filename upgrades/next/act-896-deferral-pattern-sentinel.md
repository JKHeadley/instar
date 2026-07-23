<!-- internal-only -->

# ACT-896 — Deferral pattern sentinel, increment 1

## What Changed

Added the pure, injected core of a signal-only sentinel that consumes the canonical
premature-deferral recognizer's existing content-free tone-provenance observations.
At the configured recent-distinct threshold it produces one stable, deduped
Attention input. It is dark by default, dry-run first, fails toward silence, owns
no parallel recognizer or storage, and is intentionally not boot-wired in this
increment.

## Evidence

Unit coverage locks dark/no-read, below/exact threshold, canonical-recognizer
consumption, replay dedupe, time-window edges, malformed/negative/future exclusion,
dry-run/live behavior, fail-toward-silence, audit containment, config posture,
content-free status, and stable Attention dedupe.
