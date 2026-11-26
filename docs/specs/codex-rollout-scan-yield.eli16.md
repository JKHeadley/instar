# ELI16 — counting Codex usage no longer freezes the server

## What was wrong

Every minute or so, the agent's server counts how many tokens its Codex sessions have used. It does that by reading Codex's own session files ("rollouts"). On Justin's laptop those files add up to about 14 GB across ~54,000 files. The server read and decoded the newest 500 of them all at once, on the same thread that answers every other request. While it did, the server could not answer anything else: health checks, messages forwarded from another machine, the lease check that decides which machine is in charge. Each read froze the server for 8 to 12 seconds, about once a minute (13 times in one day on Luna's live agent). A CPU profile blamed about 84% of the frozen time on this one scan. This is instar#2121.

## What changes

The reading and decoding now happen on a separate background thread (a "worker"). When it finishes, it hands back a small summary per session, and the main server thread only writes those summaries into its usage database, in the same order as before.

What gets counted stays the same: the same newest 500 files, the same 30-day age limit, the same rule for which sessions belong to this agent, and the same result when two files describe the same session. There is no new cache and no new limit.

## Safety details

- Only one scan runs at a time; a second one simply waits for the next minute.
- If the background thread fails, stalls past two minutes, or the server shuts down, the scan stops cleanly and the next minute tries again.
- The background thread may use as much memory as the server itself could, so one unusually large file cannot make the whole scan fail.

## What you need to decide

This is a bug fix with no decision for the operator. Luna drafted it on the laptop; Echo finished, reviewed and shipped it.
