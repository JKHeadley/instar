# Side-Effects Review - presence ghost-text strip

**Version / slug:** `presence-ghost-text-strip`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

Adds an input-box ghost-text filter to `sanitizeTmuxOutput` (PresenceProxy) so the assessment LLM never sees codex's placeholder suggestions as if they were typed commands. One pure function + one filter clause; no new routes, config, or persistent state.

## Decision-point inventory

- `isInputBoxGhostLine` - add - pure predicate; matches `›`/`❯`/`>`-prefixed lines whose content carries a `{token}`/`@filename` template marker or exact-matches the known codex suggestion set.
- `sanitizeTmuxOutput` - modify - one additional line-filter clause alongside the existing injection-pattern filter.

## 1. Over-strip (false positive)

Risk: a REAL typed command containing `{braces}` or the literal `@filename` would be stripped from presence snapshots. Judged acceptable: such commands are rare, the loss is one line of presence context (never functional behavior), and the alternative (matching only the curated list) misses unseen suggestion rotations — the `{token}` test is what generalizes. Real typed commands without template markers are explicitly tested as KEPT.

## 2. Under-strip (false negative)

Codex may ship new suggestion wordings without template tokens (like "Explain this codebase"). The curated set covers the observed rotation; unseen token-less suggestions would still leak. Acceptable for this slice: each is one snapshot line, and the curated set is trivially extensible when a new wording is observed.

## 3. Blast radius

`sanitizeTmuxOutput` consumers are the PresenceProxy snapshot paths (5 call sites) — all observational. OutputActivityTracker (stall detection) does NOT use this function and keeps its own volatile-line handling; activity hashing is unaffected. No agent-installed files change → Migration Parity not applicable. No new capability surface → Agent Awareness template change not applicable (internal correctness fix).

## 4. Failure modes

The predicate is pure and total (no I/O, no throw paths). A regex non-match degrades to "keep the line" — the pre-fix behavior.

## 5. Security

The filter runs AFTER credential redaction and alongside injection-pattern removal; it only ever REMOVES lines, never adds or transforms content.
