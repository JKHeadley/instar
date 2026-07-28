# SessionWatchdog non-blocking scans — Plain-English Overview

> The one-line version: a background health-checker was scanning every running session's processes using a "freeze everything until this finishes" call — and with dozens of sessions on a busy machine, those freezes piled up long enough that my server couldn't answer its own "are you alive?" check in time, so it looked dead and got restarted in a loop. Now the same scans run without freezing the server.

## The problem in one breath

My watchdog checks each session every 30 seconds for stuck commands. For every session it asks the operating system "what processes are running here?" — and it asked in a way that **blocks my entire server** until the answer comes back. One session is fine. Thirty-eight sessions on an overloaded Mac means the server spends seconds at a time frozen, and during those freezes it can't respond to its own 8-second health check. Miss the health check enough and the supervisor thinks the server died and restarts it — over and over.

## What already exists

- **SessionWatchdog** — the background monitor that spots sessions stuck on a hung command and escalates them. Useful and staying exactly as-is in *what* it decides.
- **The health check** — every 10 seconds the supervisor pings the server's `/health`; three misses in a row (30s) and it's declared down. Single-threaded, so anything that blocks the server blocks health too.

## What this adds

It changes *how* the watchdog reads processes, not *what* it does with them. The process probes (`ps`, `pgrep`) now run **asynchronously** — the server keeps serving requests (including its own health check) while the operating system fetches the process list, instead of freezing until it's done. And the poll now briefly **yields** between sessions, so scanning many sessions can never hog the loop in one burst.

## The new pieces

- **`shellExecAsync`** — an async replacement for the old freeze-the-loop shell call. Same result (the command's output, or empty on failure/timeout), but it runs off to the side instead of blocking. Every process-scanning method now uses it.
- **A yield between sessions** — after each session is checked, the poll hands control back to the event loop for an instant, so a health check waiting in line gets served promptly.

## The safeguards

**Same decisions, only faster plumbing.** The commands run, the output parsing, the stuck-time thresholds, the pipeline guard, and the LLM "is this legitimately long-running?" gate are all unchanged. Only the synchronous-vs-async I/O mechanism changed, so the watchdog can't start escalating things it didn't before.

**Failure behaves identically.** A process that's already gone, or a probe that times out, still reads as "nothing found" — exactly like the old synchronous version returned an empty string. The 5-second per-probe timeout is preserved.

**Tolerates mid-scan changes.** Because probes now yield, a session could vanish between two of them — but the code already handles "process gone" as a no-op, so this degrades safely.

## What ships when

One PR, contained to the watchdog file plus its tests. The watchdog stays opt-in. No new API, config, or migration.

## Evidence

`tests/unit/SessionWatchdog-nonblocking.test.ts`: the scanning helpers return Promises (run off the loop); a 0ms timer fires while a real process probe is still in flight (the loop stayed live); source guards assert the synchronous `spawnSync` call is gone, the async helper is used, the three scan methods are async, and the poll yields between sessions. The existing compaction/pipeline/mcp/rate-limit watchdog suites pass unchanged. 72 watchdog unit tests green; `tsc --noEmit` clean.
