# Convergence Report — Jev correction shadow

**Spec:** [docs/specs/jev-correction-shadow.md](../jev-correction-shadow.md)
**Slug:** `jev-correction-shadow`
**Converged at:** 2026-10-05
**Iterations:** 1 independent review round (80/20 convergence standard)

## Review

One independent reviewer (a fresh Opus subagent, read-only) read the spec, the
module, the full diff and the sibling `JevCirclesShadow`, ran the typecheck and
2,383 related unit, integration and e2e tests, and was asked for concrete
defects only, each with a failure scenario, classed design or fix.

It found no design-class defect and four fix-class ones, all fixed with tests
before this report:

1. **Part of the check ran on the message seam.** An async function runs
   synchronously to its first await, so a vault re-read, the 5 MB daily-cap
   seed, the scrubs and Layer 0 ran inside `onMessageLogged`. Fixed: the whole
   check is deferred with `setImmediate`; tested.
2. **Agent context cut before scrubbing.** The stored tail was 3,200
   characters, so a long token's recognisable start could be cut away before
   the scrub. Fixed: the stored tail is the 8,192-character scrub span; the
   test fails under the old cut.
3. **Text digest.** An unsalted SHA-256 prefix let short replies be recovered
   and duplicated what `messageId` already provides. Fixed: removed.
4. **Cap note repeated per restart.** Fixed: seeded from the log; tested.

## Convergence, stated honestly

Two consecutive clean rounds were not run. Per the operator's 80/20 standard
(2026-08-19, 2026-09-17), review stops when findings stop changing the build;
this round's findings were all local fixes, each now covered by a test, and
none changed the approach.

## ELI10 Overview

The server now quietly asks Jev, for each message you send, "is this a
correction or a standing preference?", and writes down Jev's answer next to the
old keyword check's answer. It changes nothing the agent learns. The review
made sure none of that work slows message delivery, that secrets are cleaned
before any text is cut, and that the log holds no trace of the words.

## Decision

Approved under the standing direction that only constitution changes need the
operator, and his standing approval for Jev work (topic 95267). Log-only,
dev-gated; nothing to decide until the soak's numbers are in.
