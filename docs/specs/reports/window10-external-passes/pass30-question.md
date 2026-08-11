# External review pass 30 — THE QUESTION, recorded before the reading

**This file exists because of the article ratified today.** *A Metric Must Measure the Work, Not the
Question* (article 89) makes recording the question its move (A), and its own case study could not fully
verify its central claim precisely because **no prompt was archived for any of readings 1–29**. Two of the
29 verdicts mention their brief in passing; the rest do not. The question survived at all only by accident,
recoverable from the fixed section headings the reviewers happened to keep.

**Pass 30 is the first reading of this series whose question is written down before it runs.** If a later
reader wants to know whether this reading's verdict measured the work or the brief, they can compare this
file to pass 31's.

---

## Frozen tree

`00fad0bfb` on `echo/window10-deep-property-guards`. Working tree clean — verified, not assumed.

## What changed since pass 29 read the tree

Pass 29 read `a84de51a1`. This is a materially different tree, not a re-check:

1. **The invisible-payload predicate was rewritten twice.** It was SUBTRACTIVE (remove known-invisible,
   keep the rest) and delivered eight non-printing classes — C0 controls, unassigned, private-use,
   noncharacters, lone combining marks, lone surrogates. It is now POSITIVE (content = letter, number,
   punctuation, symbol), minus five category-positive blank glyphs found afterwards.
2. **A third egress was guarded.** The adapter's tokenless-standby relay never enters `apiCall`; the
   earlier fix had DELETED the guard covering it.
3. **Method classification became closed-world** — every Telegram method a sender calls is declared
   reader-visible-with-its-field or explicitly bodyless; anything else fails as review-required.
4. **Structured refusal records** were added (method, field, rule, length, engine — never the payload).
5. **A new lint** derives the sender population by mechanism, with a shrink-only ratchet.
6. **The constitution gained article 89** and its seven gap sweeps were re-reached.
7. **Two stale figures were deleted** (not corrected) from the artifact and a script header.

## THE QUESTION — asked in full, with the answer withheld

**Judged fresh, as a first reader, is this tree sound?** Answer that on your own evidence.

Then, and separately, the two questions the series has learned to ask:

- **What did the last repairs break?** Seven increments landed since pass 29. Test them.
- **What can this reading see that the previous twenty-nine could not?** Passes 1–29 have already swept
  the guards, the figures, the archive and the account layer repeatedly. Choose an angle they did not.

**Explicitly NOT supplied:** any expected verdict, any count of what you should find, any claim about
whether the branch is converging, and any characterisation of the previous reading's result. The trajectory
is deliberately withheld from this prompt — pass 26 established that carrying a prior reading's frame into
the next one is how a series measures its own question instead of the work.

**Refuting anything in this file is the more valuable result.** The list above is the author's account of
what changed; it is not evidence, and it has been wrong before.

## Sections required in the answer

`FINDINGS` · `REGRESSION-CHECK` · `FRESH-ATTACK-REPORT` · `MY-ACCOUNT-CHECK` · `MAGNITUDE-METRIC` ·
`TRAJECTORY` · `CONVERGENCE` · `COHERENCE` · `VERDICT`

**Per article 89, each finding must declare its own class: DESIGN (changes what would be built or how it
behaves, or is factually wrong about the system) or PRECISION (improves the document without changing
what is built).** The comparator consumes the declared class; do not leave it to be inferred from wording.

**And state your own exclusions.** If your magnitude metric counts a finding OUT, say which and why, in the
same place you state the number. Reading 29's metric excluded the finding it called the most consequential
in the pass — that is the failure this requirement exists to prevent.
