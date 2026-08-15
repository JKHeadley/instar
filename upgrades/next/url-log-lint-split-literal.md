<!-- internal-only -->

## What Changed

`scripts/lint-no-direct-url-log.js` now folds adjacent string-literal
concatenations before testing its credentialed-URL pattern, so a
`scheme://user:pass@host` literal split across a `+` is detected as the string it
actually builds. The sibling variable-name pattern is unchanged.

The module also gains a direct-invocation guard: it now exports its scan, and
without the guard importing it would run the whole repo scan and `process.exit`.

## Evidence

- 3 new defect cases fail against the shipped fold behaviour; 13 controls pass
  both ways. Source restored byte-identical after the mutation.
- Four anti-over-block fixtures return identical verdicts under the shipped and
  fixed lint — zero new false positives, measured rather than argued.
- Real tree exit 0 before and after.
