# Side-effects review — red-team resolver verdict honesty

## What this change is
A two-part honesty fix to `src/redteam/ScenarioPack.ts` `resolveExpectation`:
(1) adds a `method: 'keyword-heuristic'` field to `ResolvedExpectation`;
(2) rewrites the governed/ungoverned `reason` strings so they name their
keyword-overlap basis and frame an `ungoverned` result as a candidate-to-verify
rather than an asserted intent gap. The matching LOGIC is unchanged — only the
verdict's self-description.

## Why
The keyword-overlap matcher produces false negatives (it misses
semantically-related constraints) and is rephrase-bypassable (CMT-1110). On the
first live boundary map it reported a false "ungoverned" finding as fact, which
briefly misled the author. The just-ratified Truthful Provenance standard
(#896) requires a verdict to carry the method that produced it; an asserted
heuristic verdict violated that.

## Blast radius
- **Behavior of governance classification: unchanged.** `governance` is still
  `'governed'`/`'ungoverned'` by the same threshold; only `reason` text changed
  and a `method` field was added. No scenario's pass/fail flips.
- **Consumers:** the only consumer of `reason`/`method` is the local
  orchestrator (`.instar/scripts/redteam-run.mjs`), which prints them — it now
  prints the honest text. No code branches on the reason string. The new
  `method` field is additive (optional consumers ignore it).
- **No route, config, lifecycle, or migration surface touched.** Pure-logic
  module with no runtime consumers in the server.
- **Type change:** `ResolvedExpectation` gains a required `method` field; both
  return sites set it, and tsc is clean, so no caller breaks.

## Framework generality
Pure logic over parsed ORG-INTENT — no session-launch/inject/message-delivery
surface, framework-agnostic. No Claude-specific assumption.

## Test coverage
26 unit tests (was 25): a new test asserts every verdict carries
`method: 'keyword-heuristic'`, and the ungoverned test now asserts the reason
names the keyword basis + frames itself as a candidate (and that the old
as-fact phrasing is gone). Both sides of the governed/ungoverned boundary
covered. `tsc --noEmit` clean.

## Rollback
Revert the single file + test; zero runtime consequence (nothing branches on
the verdict text).
