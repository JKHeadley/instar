# Side-Effects Review — a secret-store test accepts Node 26's failed-decrypt wording

**Version / slug:** `secret-store-test-node26`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, test-only, one file: `tests/unit/secret-store-key-coherence.test.ts`. One case's error-text assertion is widened from `/Unsupported state|unable to authenticate/i` to also accept `bad decrypt` (Node 26 / OpenSSL 3.x provider wording), and an assertion is added that the message is not the wrong-key diagnosis.

## Decision-point inventory

None. No production code.

## 1. Over-block

Not applicable. The test could now fail where it passed only if the thrown value were not an `Error` (new `toBeInstanceOf(Error)`); `SecretStore.read()` rethrows the cipher's `Error`.

## 2. Under-block

The widened pattern accepts one more wording, so a regression that produced the text "bad decrypt" for some other reason would pass the first assertion; the added negative assertion (not the wrong-key message) keeps the distinction the case exists for. A third wording in a future Node would fail the case again, visibly.

## 3. Level-of-abstraction fit

The dependency on wording is in the test, so the change is in the test. Making `SecretStore` classify cipher failures itself (so no test needs the library's text) would be a product change and is not needed for this.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No block/allow surface. Test-only.

## 4b. Judgment-point check

None.

## 5. Interactions

None. No other test reads this assertion. `git grep` for the old pattern finds only this line.

## 6. External surfaces

None.

## 6b. Operator-surface quality

Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

This IS a cross-machine fix: the test passed or failed depending on which Node a machine runs (Studio and M5: v24.14.1, pass; laptop: v26.13.0, fail). After the change the outcome should not depend on the machine. Not yet confirmed by a run on Node 26.

## 8. Rollback cost

Revert the commit.

---

## Second-pass review

**Reviewer:** not required. Test-only; no gate, sentinel, session-lifecycle or messaging decision is touched.

---

## Conclusion

Removes a machine-dependent test failure that blocks using the laptop as a third test line. Clear to ship; one fact still to confirm (the exact Node 26 text), stated in the release note.

## Evidence pointers

- Laptop echo home, `trial-main-1113.txt` and `trial-main-1113-rerun.txt` (2026-11-13): unit lane 1 failed / 65,719 passed; the file alone, 3 of 3 failures, with the message quoted in the release note.
