# Convergence Report — Remote Desktop guided setup

**Spec:** [docs/specs/desktop-guided-setup.md](../desktop-guided-setup.md)
**Slug:** `desktop-guided-setup`
**Iterations:** 6 (the Tier 2 cap)
**Final-round design findings:** 2, both fixed; 1 precision finding, fixed. The fixes were not re-reviewed by the outside model because the cap was reached.

## Cross-model review: codex-cli:gpt-6-astra

Codex ran on all six rounds. Gemini was unavailable (not signed in). One independent internal reviewer ran on round 1, and two second-pass code reviews ran before commit. Standards-Conformance Gate: ran on round 1 (2 flags, both addressed); it was not rerun on later rounds.

## ELI10 Overview

Getting a Mac ready for Remote Desktop used to need an agent editing settings and a person guessing at permission pop-ups. Now each machine has one Set up button. You enter your PIN, it switches the feature on, restarts that machine's server, and then shows the one next thing to do, rechecking by itself. It only says ready when a live check passes, because the System Settings list can mislead.

## Original vs Converged

The first draft let the target trust any paired machine with a thin rationale, had no way to undo, and read its state from memory. The converged version checks ownership against the file in one synchronous step, adds Turn off (ending live access at once, with no rate limit on the machine itself, and sticking against the claiming machine), stops a second front from being founded, makes a claim that cannot be audited change nothing, and says plainly that the PIN protects the front's page while the target only sees a machine key. It also keeps ready machines listed so the undo stays reachable.

## Iteration Summary

1. Internal + Codex: 8 + 3 findings. Trust rationale wrong, two-front lockout, undo did not work, config read from mutable memory, WSL restart window, atomic front write, unknown-session state. Standards-Conformance Gate: ran (2 flags).
2. Codex: 4. Front discovery not on the action, undo hidden on ready rows, notice presented as guaranteed, "permanent" overstated.
3. Codex: 4 minor. Turn off blocked when the front was off, settings guard, process-boundary and status wording.
4. Codex: 3. Overlapping changes passed the limit, 503 misread, PIN wording.
5. Codex: 3. Limit stood in front of local revocation, missing notice channel, notice id wording.
6. Codex: 3 minor. Unknown lock state allowed prompts, revocation dependency optional, limit wording.

## Proportion

Tier 2, about 900 lines of source and page plus tests, 6 of 6 rounds. Findings stayed real through every round, mostly on the same area: how a machine is claimed and undone.

## Left behind

- Moving a front stays an agent action through `PATCH /config`. A dead front means asking the agent. Accepted: it is what exists today.
- Two machines that cannot reach each other can each become a front. Accepted: each target takes the first and refuses the second by name.
- A paired-machine key can claim an unclaimed Mac that already holds a grant. Accepted as a named residual risk for the operator to decide: detection and undo, not prevention.

## Full Findings Catalog

See the iteration summary. Every finding above was fixed in the spec and code unless listed under Left behind.

## Convergence verdict

Stopped at the Tier 2 cap at round 6, which found 3 minor-class items, all then fixed. The outside model has not re-read those last fixes; the second-pass code review covers them. One operator decision remains named in the overview, and the spec has no open design questions.
