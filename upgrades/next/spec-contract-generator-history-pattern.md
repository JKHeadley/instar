<!-- internal-only -->

## What Changed

Widened the history-heading pattern in `scripts/generate-spec-contract.mjs` by
one alternative (`Review record`), so a spec that consolidates its review history
into a single section is stripped like one that uses per-round `change log`
sections.

**Why it needed changing.** Exercising the generator on a second spec surfaced
the gap the first spec could not: it matched nothing, stripped nothing, reported
`0 history sections excluded` and **exited 0**. That is indistinguishable from a
document with no history to strip — a silent no-op presenting as success, in a
tool built to prevent exactly that class of problem.

The ELI16 and the side-effects review now both carry the warning: read what the
tool says it *did*, not just whether it succeeded.

## Evidence

- Before: `inbound-message-recording-gap` generated 5% smaller with **0 sections
  excluded**. After: 12% smaller with **1 section excluded**.
- The large spec is unaffected — still 37 sections excluded, 37% smaller —
  confirming the widening did not over-match.
- `--check` passes for both specs after regeneration.
- Side-effects review updated with the finding under "under-block" rather than
  only fixing the code.
