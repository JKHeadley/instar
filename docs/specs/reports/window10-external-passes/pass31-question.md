# External review pass 31 — THE QUESTION, recorded before the reading

**Second reading in the series to have its question archived first**, and the first that can be COMPARED to
its predecessor's. Article 89's move (A) exists so a later reader can tell whether a verdict tracked the
work or the framing; that comparison becomes possible here, because `pass30-question.md` and this file are
both on disk.

**Deliberately near-identical to pass 30's brief.** This is the FIRST half of a freeze pair, and the pair's
whole purpose is to hold the question and the tree constant and see what a second independent reading finds.
Changing the brief here would make the pair measure the brief instead of the tree — which is the failure
article 89 was ratified about.

---

## Frozen tree

`c0731d998` on `echo/window10-deep-property-guards`. Working tree clean and `local == remote` — both
verified by command, not assumed.

## What changed since pass 30 read the tree

Pass 30 read `12c6aab19` and returned REJECT at 5 load-bearing, all 5 DESIGN. **All five are repaired.**

1. **Finding 1** — the lint accepted three false-clean states (a guard call inside a string literal; a
   method declared only inside a comment; a sender using `(fetch)(url)`). All three closed. **My first
   repair failed a correctly-guarded file** — a naive string-stripper mis-lexed a 35k-line source — and was
   replaced by a targeted quote-boundary rule. A false-positive control was added.
2. **Finding 2** — one refused operation emitted TWO structured records, because both send paths retried
   through the guard on a bare catch. A content refusal is terminal now, at all three sites.
3. **Finding 3** — the positive predicate OVER-REFUSED graphic marks (`Mc`, `Me`). Admitted; the surviving
   line is advance width.
4. **Finding 4** — one parity assertion was tautological. Rewritten; **my first rewrite was also
   unexercised** because the registry never cites the pass I sabotaged with, so the test now consumes the
   guard's own missing-verdict verdict alongside its own scan.
5. **Finding 5** — the stale `90`-arm denominator was still live after I reported it swept. My sweep had
   grepped remembered phrasings rather than the number. Struck.

## THE QUESTION — asked in full, with the answer withheld

**Judged fresh, as a first reader, is this tree sound?** Answer that on your own evidence.

Then, and separately:

- **What did the last repairs break?** Five repairs landed since pass 30, and two of them needed a second
  attempt. Test them.
- **What can this reading see that the previous thirty could not?** Choose an angle they did not.

**Explicitly NOT supplied:** any expected verdict, any count of what you should find, any claim about
whether the branch is converging, and the trajectory. Pass 26 established that carrying a prior reading's
frame forward is how a series measures its own question.

**Refuting anything in the list above is the more valuable result.** It is the author's account of what
changed, it is not evidence, and on this branch it has been wrong repeatedly — including twice tonight,
where a repair was reported sound and a later reading proved otherwise.

## Sections required in the answer

`FINDINGS` · `REGRESSION-CHECK` · `FRESH-ATTACK-REPORT` · `MY-ACCOUNT-CHECK` · `MAGNITUDE-METRIC` ·
`TRAJECTORY` · `CONVERGENCE` · `COHERENCE` · `VERDICT`

**Per article 89, each finding must declare its own class** — DESIGN (changes what would be built or how it
behaves, or is factually wrong about the system) or PRECISION (improves the document without changing what
is built). The class is declared, never inferred from wording.

**And state your own exclusions** beside the number: if the magnitude metric counts a finding OUT, say
which and why, in the same place. Reading 29's metric excluded the finding it called the most consequential
in that pass.
