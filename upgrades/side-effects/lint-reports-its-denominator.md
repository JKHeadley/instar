# Side-Effects Review — the marker lint reports its population beside its verdict

**Version / slug:** `lint-reports-its-denominator`
**Date:** `2026-08-23`
**Author:** `echo`
**Second-pass reviewer:** `peer session (echo-fb, W24) — the structural remedy is theirs; the worked example is mine`

## Summary of the change

`scripts/lint-machine-local-justification.js` now prints how many specs it scanned and how many carried a posture section, on both the clean and the findings path, and exposes the same counts as `population` in `--json`. Files it could not read are COUNTED, not skipped silently.

## Why — the incident this is the reading-side fix for

On 2026-08-21 this gate was found matching its section heading by exact text while spec authors had begun numbering theirs (`## 8. Multi-machine posture`). It saw **91 of 149** posture-carrying specs and silently skipped **58** — including the replicated-store foundation, the mesh self-heal spec, the secure-pairing spec, and the standards-registry spec itself — while printing `clean` about a corpus it had never read.

From the fix's own comment: *"Nobody had to make a mistake; you just had to number your heading."*

Widening the matcher fixed **that** drift. It does not fix the next one. The population can shrink again for reasons no diff records, because no author does anything wrong — and the verdict stays the single most reassuring word available. `clean` is a sentence nobody questions. `clean — 0 findings across 149 spec(s), 91 carrying a posture section` is one somebody does.

## Decision-point inventory

None. This changes only what the gate SAYS. Every verdict, threshold and exit code is byte-identical.

## 1. Over-block

Impossible: no code path can newly fail. `--strict` still exits non-zero on exactly the same condition (`allFindings.length > 0`).

## 2. Under-block

Unchanged, and worth being precise: a denominator does not detect drift. It makes drift **legible to a human who reads the output**. If nobody reads it, it buys nothing. It is deliberately not sold as a detector — an automated ratchet on the population would be the stronger control and is not built here.

## 3. Level-of-abstraction fit

Three counters in the CLI's existing loop. No new file, no new invocation, no new dependency. It is one line of output.

## 4. Signal vs authority compliance

Compliant and unchanged. The lint is a report-first signal; this makes the signal more honest about its own reach.

## 4b. Judgment-point check

None. Three integers.

## 5. Interactions

- `findPostureSection` is now called once more per file to count coverage. Pure, no I/O, negligible.
- The `--json` shape GAINS a `population` key. Additive; nothing reads it yet.
- The self-wiring contract does not pin this script, so nothing else moves.

## 6. External surfaces

None.

## 6b. Operator-surface quality

The operator never runs this. The audience is whoever reads a CI log — and the incident proves that reader was previously given a reassuring word with no scale attached.

## 7. Multi-machine posture

`unified` — trivially. A pure counter in a stateless CLI.

## 8. Rollback cost

Three counters and a string. Reverting restores a verdict with no scale attached, which is the condition the incident occurred under.

## Conclusion

Ship. Zero behaviour change, one line of output, and it addresses the reading-side half of a defect that cost this repository 39% of its posture coverage for an unknown period.

## Evidence pointers

- 40 tests, including: the denominator appears on the clean path AND the findings path (the failing path is where a shrunken population is most dangerous — a reader sees findings, assumes the sweep was whole, and never asks how far it reached); the JSON `population` shape; an unreadable file COUNTED rather than swallowed; and the property the incident turned on — **a one-file run and a two-file run must not print the same sentence**.
- First real output on the live corpus: `135 finding(s) — 1818 spec(s) scanned, 133 carrying a posture section`.

## The discrepancy this surfaced on its first run — and what three instruments then established

The historical comment records **149** posture-carrying specs; this measures **133**. That gap was reported as fully unresolved when this branch was first pushed. It has since been narrowed by two further measurements, and the narrowing is recorded here rather than folded silently into the original text.

**DRIFT IS RULED OUT — the alarming reading is disconfirmed.** A peer session (echo-fb, W24) measured by an independent method (`git grep`, not this lint's regex) and got 133 at HEAD *and* 133 at `c465a94ef`, the widening commit itself, with only two commits touching `docs/specs` in between and the count unmoved. I then reproduced that with a third method: 133 at `c465a94ef`, 133 at `upstream/main`, control on an invented token 0, control on a common token 1811 of 1818.

So the count was **already 133 when the comment claiming 149 was written**. Sixteen specs did not silently lose their posture section.

**A 2-file disagreement between my third method and the other two, resolved rather than averaged.** My first pass returned 131. The difference is case: my throwaway regex was case-sensitive on the second word, while the lint's matcher carries `/i`. The two specs are `matrix-cell-operator-cancel.md` and `playwright-profile-registry.md`, whose headings capitalise "Posture". 133 is correct and matches the lint. Recorded because a two-instrument disagreement is information, and resolving it by preference would have been the error this whole change is about.

**Still unmeasured: what produced 149.** A different branch, a method nobody has guessed, or a figure that was never right. Three candidates, none distinguished, and no claim made between them. What is now measured is the part that mattered — the population is not shrinking under the gate.

## Class-Closure Declaration (display-only mirror)

The class is "a verdict reported without its scale." Closed for this gate. NOT closed generally — no other gate in this repository was audited for it, and nothing enumerates the gates that print a reassuring word with no denominator. That sweep is the real work and is not done here.
