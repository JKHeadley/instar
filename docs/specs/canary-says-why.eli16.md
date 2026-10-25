# A failing sandbox check says why — plain-English overview

## The one-sentence version

When the feedback pipeline's pre-flight sandbox check fails, it now records what the
failing command actually printed, instead of recording only the words `exit 1`.

## What already exists

Before the pipeline lets an AI session write a fix for one of your bug reports, it
rehearses the locked-down workspace that session will run in. That rehearsal — the
"confinement canary" — runs about twenty probes. Most of them must FAIL (reading the
agent's config, writing outside the workspace, reaching the network, touching the
login keychain): a probe that *succeeds* there means the lock is not holding, and the
pipeline refuses to start. A handful must SUCCEED (`git status`, opening a SQLite
database, the repository's lint, and one small existing unit test) — because a
workspace where nothing can pass is useless for proving a fix works.

If any probe comes out wrong, the executor latches: no fix attempts start. The retry
wait climbs 1 h → 2 h → 4 h → 8 h → 24 h with each consecutive failure.

## What was broken

The must-fail probes already record their verdict *and* the evidence behind it, and a
session-path probe records the value it observed (shipped 2026-10-21). The must-succeed
probes did neither. Their whole record was the exit code:

```
failedDetail: [{ probe: "base-unit-smoke", detail: "exit 1" }]
```

The command's own output — the error message, the failing test name, the permission
denial — was captured by the runner and then thrown away. And the workspace that
produced it is deleted with the attempt, so the output could not be recovered later.

That cost three days. `base-unit-smoke` failed five times in a row (2026-10-22 →
2026-10-24), each failure pushing the retry further out, until the only way to learn
anything was to hand-patch extra logging onto the running machine — which every
automatic update then wiped. Three separate hypotheses were tested by hand and all
three were wrong, because the one piece of evidence that would have settled it was
being discarded at the moment of failure.

## What is new

1. **A failed must-succeed probe quotes its own output.** The last ~700 characters of
   stderr, then of stdout, go into the probe's detail, so the stored record reads
   `exit 1 — stderr: EPERM … | stdout: Test Files 1 failed` instead of `exit 1`.
2. **The output is bounded before it is stored, not after.** The durable scrubber
   replaces an over-size field *wholesale* with a withheld-marker, so an unbounded
   tail would have been discarded entirely — the exact failure mode this change exists
   to remove. The canary bounds each stream itself; the durable budget was widened to
   fit one.
3. **The canary's own secret nonce is stripped from any captured text**, so a probe
   tail can never become the channel that carries it into durable state.
4. **npm's cache is redirected into the attempt's temp directory — for the rehearsal
   AND for the real run.** The smoke probe runs through `npx`, and npm reads and writes
   its cache under the home directory, which this sandbox denies, exactly like the
   vitest and esbuild caches that were redirected for the same reason in October. This
   is the leading suspect for the `exit 1`, and it is listed as a suspect, not a
   confirmed cause: the point of change 1 is that the next failure will say so itself
   rather than needing a guess. Crucially, all the cache redirects now live in ONE
   helper shared by the rehearsal and by the checks that actually judge a written fix.
   Adding it to the rehearsal alone would have been worse than not adding it: the
   rehearsal would have gone green on a condition the real checks still hit, so instead
   of one honest day-long stop you would get a string of fix attempts dying for a reason
   blamed on the wrong step.

5. **Resuming has a lever.** Stopping was automatic and free; starting again had no
   control at all. The wait was written into durable state and no route could clear it,
   so a stop at the top of the ladder held every fix attempt for a full day even after
   its cause had been found, fixed and installed. There is now a request that clears the
   *wait* — and only the wait: the rehearsal still runs and still has to pass, so
   clearing grants nothing a passing rehearsal would not. It is refused while a check is
   already running, refused if used again within ten minutes, and it keeps the ladder
   position, so a sandbox that is genuinely broken still backs off 1 h → 24 h instead of
   being reset to the bottom by repeated clears. The ten-minute brake lives in its own
   record rather than inside the stop itself: the first version put it inside, where a
   failing check wiped it — releasing the brake in exactly the case where clearing again
   costs a full check run, and holding it only when nothing had run.

## The safeguards, in plain terms

- **No verdict changes.** Whether a probe passes is computed exactly as before
  (`exitCode === 0 && !timedOut`). The new text is written *after* that decision, on
  the failure path only. A leaky sandbox still fails, and still latches.
- **The lock is not loosened.** Redirecting a cache path grants no filesystem access —
  the sandbox profile decides what is reachable, and it is untouched. The new path
  points inside the attempt's own temp directory, which was already writable.
- **Secrets.** Captured text passes through the durable secret scrubber as before, and
  the canary's nonce is additionally redacted at the source, before the text is cut to
  length, so a value straddling the cut cannot leave a readable fragment. Stated plainly
  because it is a real limit: a secret that is neither the canary's own nonce nor a
  recognised credential shape would not be caught by either layer. And because the
  scrubber makes text *longer* where it redacts, a redaction-heavy record can still
  exceed the limit — in which case the end is kept behind a visible "truncated" marker,
  because the end is where the error is.

## What you actually need to decide

Nothing. This is observability on a failure path, one cache redirect that matches a
precedent already in the file, and a lever that removes a wait without removing a check.
If it is wrong, reverting the commit fully undoes it — there is no persistent state
beyond a longer string in a record that already existed, and no user-visible surface.
