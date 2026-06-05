# The mentor loop's last outcome now survives restarts (and ticks show up in the log)

The mentor system runs a heartbeat every 15 minutes: a small job session wakes up, pokes the server's "do one mentor tick" endpoint, and the outcome of that tick is supposed to be readable at the mentor status endpoint. Today, asking "is the mentor loop alive?" gave a permanently empty answer — `lastResult` was blank for days, even though the loop was configured on and live.

Two compounding causes, both observability-only:

1. **The last outcome lived only in memory.** Every server restart wiped it. On a day with frequent fleet releases, the server restarts about as often as the tick fires — so the one record of "what happened last tick" was erased before anyone could read it, essentially every time. The loop could have been working perfectly or completely broken; the status route couldn't tell you which.

2. **Successful ticks logged nothing.** Only failures produced a log line. A server log with zero mentor lines was equally consistent with "every tick succeeded silently" and "no tick ever arrived" — we hit exactly this ambiguity while diagnosing it (three days of job sessions, two visible tick arrivals, zero outcome lines).

The fix keeps the same shape as the runner's existing design: the host hands the runner two optional services — "load the last outcome" and "save the last outcome" — wired to a small JSON file in the agent's state directory (atomic write, corrupt-file-tolerant load). The runner hydrates from it once at construction and saves on every outcome write (disabled short-circuit, success, and failure all flow through one funnel). And every accepted tick now logs one line on start and one on completion, so the loop's pulse is visible in the server log.

Nothing about WHAT the mentor does changed — no behavior, gating, or cadence change. If the file is missing or unwritable, the runner behaves exactly as before (in-memory only). Pure diagnosis plumbing for a loop that was flying blind.
