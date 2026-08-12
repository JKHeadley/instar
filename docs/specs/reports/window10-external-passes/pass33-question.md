# External review pass 33 — THE QUESTION, recorded before the reading

Fourth reading with its question archived first, and **the first written under the filter-safe brief.**

## Why this brief is worded differently, and what did NOT change

Pass 32 was terminated mid-reading by the provider: its brief asked the reviewer to CONSTRUCT working
evasions of a security check, which is offensive-security work by any fair classifier. See
`pass32-verdict.md` — an abort record, not a verdict.

**What changed is the phrasing, not the rigour.** This brief asks for ANALYSIS of where a check's reasoning
does not hold, expressed as claims about the code; the author constructs and runs any payloads locally.
The information sought is identical. What is no longer requested is that a model author working bypasses.

**What did NOT change:** the question itself, the required sections, the class declaration, the exclusions
requirement, and the instruction to refute the author's account. Those are held constant deliberately —
this series is trying to measure the tree, and a brief that drifts measures itself.

## Frozen tree

`1ba2dbc2d` on `echo/window10-deep-property-guards`. Clean, `local == remote`, verified by command.

## What changed since pass 31 (the last COMPLETED reading)

- **The send-funnel check requires a bare-identifier callee.** Pass 32's fragment showed that parsing alone
  was insufficient: an object-literal method shorthand is a real call whose callee is a property access, so
  the file read as guarded with the guard removed. The check now asks the right question — is this a call to
  the IMPORTED function — which a bare identifier plus the required module import together answer.
- Pass 31's four repairs: the parser rewrite, the predicate's advance-width rationale removed (all marks are
  content, minus `Default_Ignorable`), the coverage instrument no longer reporting a ratio it did not
  measure and restoring in a `finally`, and a thrice-stale figure struck.

## THE QUESTION — asked in full, with the answer withheld

**Judged fresh, as a first reader, is this tree sound?** Answer on your own evidence.

Then, separately:

- **What did the last repairs break?**
- **Where does a check's REASONING fail to support the claim it makes?** State it as an analytical claim
  about the code — which inputs or shapes the logic does not cover, and why — with file:line. The author
  will construct and run the cases.
- **What can this reading see that the previous thirty-two could not?**

**Explicitly NOT supplied:** any expected verdict, any count, any claim about convergence, the trajectory.

**Refuting the account above is the more valuable result.** It is the author's account, it is not evidence,
and it has been wrong in each of the last three readings.

**Where the author's confidence is highest, and therefore where a wrong claim costs most:** that the
send-funnel check now asks the right question rather than merely a better-parsed version of the wrong one.
Analyse that claim rather than its instances.

## Sections required

`FINDINGS` · `REGRESSION-CHECK` · `FRESH-ATTACK-REPORT` · `MY-ACCOUNT-CHECK` · `MAGNITUDE-METRIC` ·
`TRAJECTORY` · `CONVERGENCE` · `COHERENCE` · `VERDICT`

Each finding **declares its class** — DESIGN or PRECISION. The magnitude metric **states its exclusions**
beside the number.
