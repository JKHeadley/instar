# Side-Effects Review — Convergence commitment-regex word boundaries

**Version / slug:** `convergence-commitment-regex-boundaries`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Word-boundary guards on the commitment_overreach pattern (3 lockstep copies:
shell template, migrator inline fallback, TS checker). Live FPs "Mini
promises" / "I promised" blocked five legitimate messages in one day.

## Decision-point inventory

One: the boundary semantics — leading `(^|[^a-zA-Z])i ` and trailing
`promise([^a-zA-Z]|$)`. Chosen over `\b` for BSD-grep portability; verified
on macOS grep with a 12-string both-sides probe before patching.

## 1. Over-block

None added — the new pattern matches a strict SUBSET of the old one.

## 2. Under-block

Deliberate: past-tense "I promised" no longer flags. That phrasing narrates a
prior commitment rather than making one; the gate's purpose is catching NEW
promises that may not survive the session. "I promise" present-tense, bare
sentence-final, and every other phrasing alternative still flag (tested).

## 3. Level-of-abstraction fit

The fix lives in the pattern itself, in all three places the pattern exists —
no new layers. The template is the canonical copy; the migrator's
always-overwrite delivers it to existing agents (Migration Parity satisfied
structurally, no new migration needed).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

The gate keeps exactly its existing authority (block-before-send); this change
only narrows its trigger to what it was always meant to catch.

## 5. Interactions

- grounding-before-messaging.sh consumes the script unchanged.
- The LLM-side reviewers are unaffected (this is the deterministic tier).
- Self-Violation Signal / correction loops: fewer false correction inputs.

## 6. External surfaces

None. No routes, config, or notifications.
