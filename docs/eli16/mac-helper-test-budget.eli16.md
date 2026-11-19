# Desktop helper tests no longer fail on a busy machine — plain-English overview

**What went wrong.** The part of Instar that shows and controls a Mac's screen talks to a small helper program. Each time it asks the helper something, it waits a fixed time for the answer: 2 seconds for an ordinary question, 4 seconds for a picture of the screen. The real helper is a small native program that starts almost instantly, so those waits are right.

The tests do not use the real helper. They put a small Node script in its place that plays the helper's part. Node is much slower to start than the real helper, and on a machine that is busy running thousands of other tests it can take more than 2 seconds just to start. When that happens the test reports a timeout and fails, although the code is fine. On 2026-11-18 that failed two unrelated changes waiting to merge, and the same tests had been retried for the same reason several times that week.

**What changes.** Every wait for the helper now goes through one small piece of code that multiplies it by a single number, the scale. The scale is 1 unless something sets it, so a running agent waits exactly as long as it did before. The file that prepares every test run sets the scale to 10, so in tests the 2 seconds becomes 20. A stand-in that answers is not slowed down at all; only the patience grows.

**What does not change.** Nothing in a running agent. No production code sets the scale, and a test checks that. The one existing test that is about the timeout itself sets the scale back to 1 for its own run, so it still proves the 4-second limit inside its 7-second bound. No existing check was loosened. The Windows side is untouched.

**Safeguards.** The scale can only make a wait longer. A value below 1, or one that is not a real number, is refused and the scale stays 1. A value above 20 is held at 20. If this is wrong, reverting the one commit restores the old behaviour, with no stored data to repair.

**What you need to decide.** Nothing.
