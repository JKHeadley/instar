# External review pass 32 — THE QUESTION, recorded before the reading

Third reading in the series with its question archived first. Held **deliberately near-identical** to
`pass30-question.md` and `pass31-question.md`: the series is trying to measure the tree, and varying the
brief between readings is how a series ends up measuring its own brief instead — article 89's subject.

---

## Frozen tree

`f53eb8f0e` on `echo/window10-deep-property-guards`. Working tree clean and `local == remote`, both
verified by command.

## What changed since pass 31 read the tree

Pass 31 read `78eb54e13` and returned REJECT at 4 load-bearing, all DESIGN. **All four are repaired.**

1. **Finding 1 — the send-funnel lint now PARSES instead of pattern-matching.** Three readings had
   defeated three successive text matchers (a superstring rename, a bare string decoy, a *prefixed*
   string decoy, and a double-quoted method call). The check now uses TypeScript's own parser: guard
   calls, `fetch` calls (seen through parentheses) and method names come from real call expressions.
   Seven historical escapes were re-run against it.
2. **Finding 2 — the predicate's advance-width rationale was measured false and removed.** All Unicode
   marks are now content, minus `Default_Ignorable_Code_Point`. The prior rule admitted `Mc`/`Me` and
   refused `Mn` on a claim about advance width that does not hold on this host.
3. **Finding 3 — the coverage instrument no longer reports a ratio it did not measure.** Errored
   mutations are excluded from the denominator and reported separately; a run that measured nothing exits
   non-zero. Its long-standing missing `finally` is closed, with signal handlers restoring every mutated
   file.
4. **Finding 4 — the stale `23 of 90` figure struck in the plain-language companion.** It had survived
   two prior sweeps.

## THE QUESTION — asked in full, with the answer withheld

**Judged fresh, as a first reader, is this tree sound?** Answer that on your own evidence.

Then, and separately:

- **What did the last repairs break?** Four repairs landed since pass 31, one of them a rewrite of a check
  onto a parser. Test them.
- **What can this reading see that the previous thirty-one could not?** Choose an angle they did not.

**Explicitly NOT supplied:** any expected verdict, any count of what you should find, any claim about
whether the branch is converging, and the trajectory.

**Refuting anything in the list above is the more valuable result.** It is the author's account of what
changed, it is not evidence, and on this branch it has been wrong repeatedly — including three times in the
last two readings, where a repair was reported sound and the next reading proved otherwise.

**One specific invitation, because it is where the author's confidence is highest and therefore where a
false claim would be most expensive:** the lint's move to a parser is claimed to end a CLASS of evasion
rather than the four instances that provoked it. Test that claim rather than the instances.

## Sections required in the answer

`FINDINGS` · `REGRESSION-CHECK` · `FRESH-ATTACK-REPORT` · `MY-ACCOUNT-CHECK` · `MAGNITUDE-METRIC` ·
`TRAJECTORY` · `CONVERGENCE` · `COHERENCE` · `VERDICT`

**Per article 89, each finding must declare its own class** — DESIGN (changes what would be built or how it
behaves, or is factually wrong about the system) or PRECISION (improves the document without changing what
is built). Declared, never inferred from wording.

**And state your own exclusions** beside the number: if the magnitude metric counts a finding OUT, say
which and why, in the same place it states the count.
