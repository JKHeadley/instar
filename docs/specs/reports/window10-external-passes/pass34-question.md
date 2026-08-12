# External review pass 34 — THE QUESTION, recorded before the reading

Fourth archived question, and the second written under the filter-safe brief. Held near-identical to
`pass33-question.md` on purpose: the series measures the tree, and a brief that drifts measures itself.

## Frozen tree

`537a19170` on `echo/window10-deep-property-guards`. Clean, `local == remote`, verified by command.
Memory checked before dispatch (45% free) per the standing rule — two earlier readings died on a saturated
machine and the rule exists so a third does not.

## What changed since pass 33

Pass 33 returned UNSOUND at 5 load-bearing (3 DESIGN, 2 PRECISION). **Three repaired, two accepted and
left open — deliberately, and named here so this reading can attack the openness rather than rediscover it.**

**Repaired:**
1. **The guard evaluated the PRE-FORMAT source.** A payload whose only content characters sat in a link
   destination was SENT and reached a reader as one zero-width space — proven by execution. A second check
   now runs AFTER formatting on the reader-visible extraction (HTML text nodes; Markdown link labels). It is
   an addition, not a replacement: the two close different cases and each reds on its own.
2. **A self-inflicted failing test.** The contiguity fixture hardcoded pass numbers on an assumption my own
   later citations falsified; it now derives its number from the archive.
3. **Stale account after the marks repair** — the predicate's own description and refusal text.

**ACCEPTED AND NOT REPAIRED (open, and the honest state of the tree):**
- **The send-funnel check cannot prove a call resolves to the imported guard.** It checks a bare-identifier
  callee and an import separately and never RELATES them. A same-spelled identifier can be locally bound or
  shadow the import. **The comment in that file claims more than the code does, and that claim is false.**
- **Closed-world method classification covers only direct literal shapes.** A method carried through a
  variable, enum, expression or wrapper is unclassified.

Both are answered properly by consolidating to one shared client, which is registered and dated, not by a
seventh matcher.

## THE QUESTION — asked in full, with the answer withheld

**Judged fresh, as a first reader, is this tree sound?** Answer on your own evidence.

Then, separately:

- **What did the last repairs break?** In particular, the post-format check is NEW blocking behaviour on the
  send path. Does it over-refuse anything a reader would in fact have seen?
- **Where does a check's REASONING fail to support the claim it makes?** State it as an analytical claim
  about the code — which inputs or code paths the logic does not reach, and why — with file:line. The author
  constructs and runs the cases.
- **What can this reading see that the previous thirty-three could not?**

**Explicitly NOT supplied:** any expected verdict, any count, any claim about convergence, the trajectory.

**Refuting the account above is the more valuable result.** It is the author's account, not evidence, and it
has been wrong in each of the last four readings.

**Where confidence is highest, and therefore where a wrong claim costs most:** that the post-format check
now measures what a reader actually receives. Pass 33 falsified the previous version of exactly that claim.

## Sections required

`FINDINGS` · `REGRESSION-CHECK` · `FRESH-ATTACK-REPORT` · `MY-ACCOUNT-CHECK` · `MAGNITUDE-METRIC` ·
`TRAJECTORY` · `CONVERGENCE` · `COHERENCE` · `VERDICT`

Each finding **declares its class** — DESIGN or PRECISION. The magnitude metric **states its exclusions**
beside the number. If you mutate any file, restore it and report whether the tree is clean.
