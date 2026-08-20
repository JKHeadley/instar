## What Changed

**Background jobs on the subscription lane were being killed ~16 seconds in and recorded as successful.**

When instar runs a background job through the rerouted-interactive lane (`intelligence.subscriptionPath.mode` = `force`, or `auto` where the reroute gate allows), it opens a real chat session and asks the model to print a per-session completion marker as its final line. The monitor watches the session's terminal and reaps it when that marker appears.

The prompt carrying that instruction is *injected into the session*, so the assembled marker landed on the very terminal the monitor scans — before any work started. The monitor read its own instruction back and reaped the session as `completed` on its first check after the 15-second grace period.

Nothing failed loudly. Every job recorded `success`.

The fix hands the model the marker's pieces and asks it to join them, so the assembled literal reaches the terminal only when the model actually prints it. If a model ever joins it incorrectly, the session falls through to the existing hard lifetime cap and is recorded as a **timeout** — a loud non-completion instead of a silent false success.

Agents on the headless lane (`completionMode: 'exit'`) were never affected: there, "finished" means the process exited, which screen content cannot fake.

## What to Tell Your User

If your agent runs background jobs on the subscription lane, those jobs have most likely not been completing — they were stopped a few seconds in and logged as successful, so every status surface stayed green.

After this update they run properly. Expect two visible changes: scheduled jobs now take their real time instead of finishing almost instantly, and they consume their real share of your quota. That is the intended cost of the work actually happening. If a job now reports a **timeout**, that is genuine information rather than a new fault — previously it would have claimed success.

Nothing to configure, and nothing to clean up.

## Summary of New Capabilities

No new capabilities — this restores intended behaviour for scheduled and background jobs on the rerouted-interactive lane.

## Evidence

Measured on a live three-machine fleet, on the machine holding the serving lease, before the fix:

- **31 of 31** rerouted-interactive sessions killed between **15.3s and 41.3s**; every one recorded `completed`. No exceptions.
- **25 scheduled jobs** at `lastResult: success`, `consecutiveFailures: 0` — health-check, commitment-detection, the maintenance overseers, feedback-factory-process — each doing roughly sixteen seconds of work.
- **1,074** `sentinel-complete` reaps in the ~43 hours the machine's reap-log covers.
- Live reproduction: polling `GET /sessions/:name/output?lines=30` showed the marker inside the scanned window continuously from ~10s after spawn, followed by the reap. The reap-log recorded `skipped:active-process` at 16s (a partial guard delaying, not preventing, the false verdict) and `reaped | sentinel-complete | terminal` at 41s.
- Control: a comparable job on the headless lane ran 3m38s and completed correctly.
- The marker-assembly instruction was verified against the real model on the affected machine before being relied on.

Tests: unit 27 passed (both new assertions confirmed to **fail** on the unfixed source), integration passed, e2e 4 passed, `tsc --noEmit` clean.

Scope: this closes the collision at the producer. The underlying signal-vs-authority issue — a literal-token matcher holding kill authority over terminal text, unable to tell the model's output from an echo or a quotation — is unchanged and tracked as ACT-1798.
