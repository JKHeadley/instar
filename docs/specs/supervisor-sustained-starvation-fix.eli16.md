# Supervisor restart loop fix — plain-English overview

## What was going wrong

Every instar agent has a small supervisor that watches its server and restarts it if it looks dead. The way it checks "is it dead?" is to ping the server's health endpoint every 10 seconds. If the ping keeps failing, the supervisor restarts the server.

But there's a catch: when the computer is overloaded (way more work than CPU cores), a perfectly-alive server can be too slow to answer that ping in time. Restarting it doesn't help — the fresh server is just as starved — it only drops whatever the server was doing and starts a heavy boot sequence that makes the overload *worse*. So there's already a smart guard: "if the machine is CPU-starved, DON'T restart — wait for the load to ease."

## The bug

That guard checked the CPU load at a **single instant**. On a busy machine the 1-minute load average bounces around the cutoff line. Every so often it dips just below the line for one reading — and that single dip tricked the guard into thinking "not starved anymore → restart!", even though the machine had been starved the whole time. The restart spiked the load again, the next ping failed, and the cycle repeated roughly every 11–15 minutes (the 2026-06-17 incident: an agent's server restart-looping, causing message lag and queued replies).

## What already existed

- The CPU-starvation guard itself (it correctly defers restarts while starved).
- A hard cap (~5 minutes) that force-restarts even while starved, as a backstop for a server that is genuinely frozen rather than merely slow.
- Injectable load source + a dedicated unit-test file, so the fix is fully testable.

## What's new

The guard now judges **sustained** load, not a single instant. It records the load on each failing health check and keeps the last ~60 seconds of readings; it treats the box as starved if it was starved at **any** point in that window. A momentary dip can no longer authorize a restart while the machine has been busy the whole time. When the load genuinely stays down for the full window, the server restarts as before — so the guard is not permanent.

## Safeguards (unchanged, verified)

- A genuinely **dead** process still restarts instantly (the window logic never runs in that path).
- A server truly stuck on an **idle** machine still restarts fast (low load → window stays low → restart).
- The ~5-minute hard-cap backstop is preserved.
- The recent-load window is dropped the moment the server recovers, so stale "busy" readings can't over-defer a later, unrelated problem.

## What you need to decide

Nothing structural — this is a conservative bug fix that only ever makes the supervisor *wait longer* before restarting under load (the safe direction). It ships to the whole fleet because every agent inherits the same supervisor. The review surface is this PR plus its tests.
