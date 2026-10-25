# Convergence Report — Jev circles shadow

**Spec:** [docs/specs/jev-circles-shadow.md](../jev-circles-shadow.md)
**Slug:** `jev-circles-shadow`
**Converged at:** 2026-09-30
**Iterations:** 1 independent review round (the brief asked for one 80/20 round)

## Review

One independent reviewer (a fresh Opus subagent, read-only) read the spec, the
module, the full diff and the research harness, and was asked for concrete
defects only, each with a failure scenario, classed design or fix.

It found no design-class defect and three fix-class ones. All three were fixed
in code with tests before this report:

1. **Secrets cut before the scrub (floor).** The harness order — cut, then
   redact — let a private-key body whose header the tail cut removed reach Jev
   (the reviewer proved it through the real functions); a token across the
   160-character command cut or a labelled secret whose label fell before the
   tail could leak the same way. Fixed: every raw field has a bounded slice
   scrubbed with `scrubForStore` before any cut; a private-key marker withholds
   the field. Tests: a PEM body with the header cut, a Telegram token across
   the command cut, a labelled secret before the tail. Cost: 96 of 3,000
   research windows now differ from the harness, each only by a redaction.
2. **Path check looser than the spec said.** Fixed: a real UUID session id,
   the exact `<.claude*>/projects/<cwd>/<id>.jsonl` shape, re-checked on the
   symlink-resolved path. Tests on both sides, including a symlink out.
3. **Silent blind spot.** A session whose 1 MB tail holds fewer than 15 actions
   (huge results) was never measured and left no trace. Fixed: one
   `short-window` row per session when the tail was truncated.

The reviewer confirmed sound: the daily cap and in-flight bound (no await
between check and increment), the timeout covering the body read, cooldown
under overlap, the live kill switch, the dev gate, the hook route's isolation,
PostToolUse-only counting, Codex paths failing the check, the question matching
`runjev.mjs` exactly, and the two hook-reporter copies being identical.

## Convergence, stated honestly

Two consecutive clean rounds were not run. The brief set one round (Occam /
80/20, operator rule 2026-09-17). The round's findings were all local fixes,
each now covered by a test; none changed the approach.

## ELI10 Overview

The server now quietly checks, every few actions, whether an agent looks stuck
repeating the same failed fix, and writes down what it would have said. It never
says it. The review found that secrets could slip out when long text was cut
short before being cleaned, so text is now cleaned first.

## Decision

Approved under the operator's 2026-09-30 approval to build the shadow (topic
95267). Log-only, dev-gated; nothing to decide until the soak's numbers are in.
