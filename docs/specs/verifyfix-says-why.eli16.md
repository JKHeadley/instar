# The later checks now say why they failed — plain-English overview

## The one-sentence version

When the pipeline checks a fix it has just written and one of those checks fails, it now records
what the failing command actually printed, instead of a bare label like "lint".

## What already exists

Writing a fix is only half the job. Once a sandboxed session has written one, trusted code checks
it four ways, each in its own fresh copy of the code: the new test must FAIL on the unchanged code
(proving it really reproduces the bug), it must PASS with the fix applied, the repository's lint
must pass, and the tests related to the changed files must pass. Only then is the fix published.

Each of those four can fail. Until now, a failure recorded a label — `gate:lint`,
`head-check:test-fails-at-head` — and nothing else. The command's own output was captured and then
discarded, and the three throwaway copies of the code are deleted along with the attempt. So the
cause was unrecoverable afterwards.

## Why this is being fixed now, before it has ever bitten

This is the same defect that just cost three days one step earlier. The pre-attempt rehearsal
recorded `exit 1` and threw the evidence away; three hypotheses were tested by hand and all three
were wrong, and it was only solved once the check was made to explain itself. The four checks here
sit immediately after, on the path the very next attempt will take — so the first real fix attempt
would have hit the identical dead end, with the identical cost.

Fixing a known blindness before it bites is cheaper than diagnosing it afterwards. That is the
whole lesson of the last three days, applied one step forward.

## What is new

- A failed check records its own output: the last stretch of what the command printed on each
  stream, secret-scrubbed, size-capped, stored where the status page can show it.
- It shares **one** piece of code with the rehearsal's version rather than having its own copy.
  That is deliberate: the last fix nearly shipped with a cache setting added to the rehearsal but
  not to these checks, which would have made the rehearsal pass on a condition the real checks
  still failed. Sharing the code means the two cannot drift apart again.
- The label itself is untouched. Other code matches on those labels by prefix, so the output goes
  in its own record rather than being glued onto the label.

## The safeguards, in plain terms

- **Nothing about what passes or fails changed.** The same four checks, the same verdicts; only
  what gets written down when one fails.
- **Recording can never mask a failure.** If writing the record fails, the check failure still
  stands — the record is best-effort by design.
- **Secrets.** The text goes through the same scrubber and the same size cap as the rehearsal's,
  and the cap keeps the END of the output, because a test runner and a shell both put the error
  last.
- **The tests pin it three ways.** Removing the wiring fails a test, dropping the output fails a
  test, and keeping the wrong end of the output fails a test. All three verified by deliberately
  breaking the code. The third fails in *three* places, including the rehearsal's own tests, which
  is what proves the shared code is genuinely shared.

## What you actually need to decide

Nothing. If it is wrong, reverting the commit fully undoes it — no stored state to migrate, no
user-visible surface.
