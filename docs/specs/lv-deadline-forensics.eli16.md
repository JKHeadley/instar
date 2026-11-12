# Local Verify: say what was running when a lane times out, and stop the rest (ELI16)

**What changes:** each test lane that decides whether a change can merge now keeps a small, constantly updated note of which test files are running right now. When a lane runs out of time and is killed, the verifier reads that note and writes the names of the files that were still running (and for how long) into the run's log and its error reason. In the same moment it stops the other lanes of that run, instead of letting them run on.

**Why it matters:** in the 24 hours to 2026-11-12, 15 of 27 verify runs died on a time limit, 13 of them in the integration lane, and not one of them said which test was stuck. The JSON report vitest writes only appears at the end, and a killed lane never reaches the end. So every fix so far was a guess. Both outside reviewers in the first daily throughput brainstorm (Fable 5.2 and GPT-6 Astra) named this as the first thing to fix. Separately, a run that has already lost to a time limit kept its other lanes going: on PR 3090 the end-to-end lane ran 11 more minutes after integration was killed, holding the machine's one test slot for a result nobody could use.

**What stays the same:** no verdict rule changes. A deadline is still an error, a passing run still needs all three lanes, and a real test failure still stops the other lanes only when fail-fast is on (and never for `main`). The progress note is information only. If it is missing or unreadable, the log says "unknown", never "nothing was running".

## Second fix in this change: `main` no longer gets stuck "unverified"

Before any change can merge automatically, the system wants a recent green check of `main` itself. If that check errors (for example on a time limit), it retries three times and then stops for good. On 2026-11-12 that happened at 12:34Z: `main` stayed "unverified", and while `main` is not healthy the merge watcher offers no change to the test queue at all. Changes that had been turned away while the queue was full were never offered again (PR 3088 among them), and only hand-requested ones got in. Now, when a change passes a full test run on this machine after `main`'s retries ran out, that pass counts as "something changed" and `main` gets one more check. It cannot loop: each passing change can trigger at most one extra `main` check.

## Third fix in this change: each machine can set its own number of unit-test workers

The unit tests always ran with 4 workers on every machine. On 2026-11-12 the M5 was 45 to 90 percent idle while its unit lane still hit the 20-minute limit, so 4 workers was the limit there, not the machine. Each machine can now set its own count (1 to 12) in its existing lane setting. It does not change which tests run or any pass rule, only how many run at once. The default stays 4.
