# Standards enforcement measurement: count test events, not decorated lines

The short version: Node can print the same test result differently across supported versions. The enforcement measurement used to scrape human-readable summary lines, so it worked on Node 22 but could not recognize any completed tests on Node 25. It now reads Node's structured test events directly.

## What was wrong

The verifier launched a real observer three times and authenticated all three child exits, but it found test counts by looking for TAP lines such as `# tests 1`. The command did not pin TAP. Node 22 happened to emit those lines when the author ran the suite; Node 25.6.1 emitted information-glyph summaries instead. The vacuous control still failed closed, but the genuine observer also stayed unverified because every count was `null`. That made the mechanism honest but unable to discriminate.

## What changes

A small verifier-owned runner now calls `node:test.run()` for the protected observer and consumes the returned `TestsStream`. It counts actual `test:pass` and `test:fail` events, excludes skipped/todo tests and suites, and identifies assertion failures from the structured error object. It sends one schema-checked summary over child-process IPC. The verifier still observes and authenticates the real child exit; it now binds the artifact to structured counts instead of scraping stdout.

Missing, duplicate, or malformed event summaries mean UNKNOWN. An executed observer that survives the mutation remains NOT-PROVEN. A genuine observer earns ratchet only when one or more tests pass clean, fail after the protected mutation through a structured assertion error, and pass again in the pristine confirmation with the same count.

## Proof that renderer text has no authority

The positive fixture now prints fake, contradictory human summaries claiming 999 tests in both old `#` and new `ℹ` styles. On the judge's exact Node 25.6.1 runtime, the returned source is still `node:test TestsStream`, all three observed counts are exactly one, the mutation run carries a structured `ERR_ASSERTION`, and the observer reaches ratchet. The vacuous and mutation-insensitive controls remain NOT-PROVEN. The full focused suite changes from the judge's 11 passed / 4 failed to 15 passed / 0 failed.

This is a measurement-path repair only. It does not modify the other guard whose harness exposed the same rendering mistake, and it does not touch shared entry-path comparison logic. Independent judgement remains required before this can be called machine-verified.
