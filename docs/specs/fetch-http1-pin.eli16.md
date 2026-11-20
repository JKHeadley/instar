# Outbound web requests stay on HTTP/1.1 — Plain-English Overview

> The one-line version: every instar program now tells Node to use the older, simpler web protocol (HTTP/1.1) for its outgoing requests, because the newest Node uses HTTP/2 by default and that path made one agent server eat tens of gigabytes of memory.

## The problem in one breath

An instar agent server talks to the outside world through Node's built-in `fetch`: sending Telegram messages and files, calling Slack, the Claude API, and other machines behind Cloudflare tunnels. Node versions 20, 22 and 24 always speak HTTP/1.1 for this. Node 26, which a Homebrew upgrade installed on the Laptop, switched to HTTP/2 whenever the other side offers it. On 2026-11-20 the Laptop's Echo server ballooned to between 10 and 37 gigabytes of memory five times in 16 hours, and every memory sample showed the program's main thread stuck inside Node's HTTP/2 sender, packing frames for a request stream that no longer existed. The same agent on the Studio, on Node 22, never did this.

## What already exists

- **The Telegram egress door** — the one place that sends to Telegram. It already asked for a custom connection pool, but Node 26 refuses that pool (it comes from a different copy of the networking library), so on Node 26 it quietly fell back to Node's default, which is HTTP/2.
- **The supervisor's health check** — restarts a server that stops answering for about a minute. It does not look at memory, and it holds off while the machine is busy, so a balloon could grow for many minutes.
- **A local memory watchdog script on the Laptop** — killed the server above 8 GB. It is a one-machine stopgap, not part of instar.

## What this adds

At the very start of every instar program (server, lifeline, and command line), before any command runs, Node's default `fetch` connection pool is replaced with an identical one that is not allowed to use HTTP/2. This uses Node's own pool class, so it works on Node 20 through 26. It costs about 15 milliseconds once per program start and makes no network request.

- If something else deliberately installed its own pool first (for example a proxy), it is left alone and a line is logged.
- Direct HTTP/2 use where a service requires it (Apple's push service for the iPhone app) is not touched.
- Setting `INSTAR_ALLOW_FETCH_HTTP2=1` turns the pin off.

## The safeguards

**It cannot break requests.** Every service instar calls accepts HTTP/1.1, and Node 20-24 agents have only ever used it. Tests run the real protocol negotiation against a local secure server that offers both, on Node 22 and on Node 26.

**It never throws.** If the pin cannot be applied, a line is logged and fetch keeps Node's default.

## What ships when

One small change: the pin module, the call at program start, and tests at all three levels. A separate change will add a memory ceiling to the supervisor so that any future runaway is stopped with a loud notice instead of a local script.

## What you actually need to decide

Nothing; this is a reversible fix (a revert or the opt-out variable restores the old behaviour). The question it answers: should instar always use HTTP/1.1 for outgoing web requests, as it already does on every Node version before 26? Yes.
