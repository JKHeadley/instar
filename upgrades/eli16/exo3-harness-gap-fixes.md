# EXO 3.0 Harness Gap Fixes — Plain-English Overview

> The one-line version: a new from-every-angle test harness for our EXO 3.0 features found three small, real bugs that shipped because the old tests checked the wrong things — this fixes all three.

## The problem in one breath

We built a harness that probes every EXO 3.0 capability through its real endpoint, from several angles. It surfaced three genuine bugs that were invisible before because the existing tests quietly encoded the same wrong assumptions the code had. None of them are big — but each made a real capability lie about itself.

## What already exists

- **Agent Passport** — a portable card that says what an agent may and may not do; a peer can check an action against it before trusting it.
- **Org-Intent / tradeoff hierarchy** — our purpose file lists, in priority order, which value wins when two collide (Safety first, then Operator trust, and so on).
- **Learning-velocity metric** — a read-only number meant to show how fast the agent is actually learning, by counting real learning events.

## What this adds

This is three surgical fixes, no new features:

- **Passport verify no longer crashes on a partial card.** A peer's passport that omits a field (it didn't go through our builder) used to make the verifier throw a 500 error. Now any missing list defaults to empty, so the verifier always returns a clean yes/no verdict instead of crashing.
- **The tradeoff hierarchy now actually parses.** Our purpose file writes the hierarchy the documented way — one line, "Safety > Operator trust > Correctness > …". The parser only understood bullet lists, so it read an empty hierarchy and the resolver said "no hierarchy defined." Now it understands the chained form too.
- **Learning-velocity reads the real event sources.** The metric was reading three file paths the agent never actually writes to (wrong directory, wrong timestamp field, and a JSONL file for data that lives in a database). So it always reported zero. Now it reads the registered-learnings registry (with the right timestamp), the evolution action queue, and the corrections database.

## The safeguards

**Prevents the verifier from crashing on untrusted input.** A passport is, by design, handed over by another agent — so it must be treated as possibly-partial. Defaulting the array fields means a malformed card produces a verdict, never an exception.

**Prevents silent zero-reporting.** The learning-velocity test used to write fixtures to the same wrong paths the route read, so both were wrong together and the test stayed green. The test now seeds the REAL paths and shapes the live agent writes, so it can never again pass while the live metric reads zero.

**No behavior change for healthy inputs.** A complete passport, a bulleted hierarchy, and an agent with no learning events all behave exactly as before. These fixes only add tolerance and correct paths.

## What ships when

One PR, all three fixes together — they were all surfaced by the same harness run and share the same root (latent bugs masked by tests that encoded the same wrong assumptions). Regression tests ship alongside each fix.
