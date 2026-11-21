# Outbound web requests stay on HTTP/1.1 on every Node version

<!-- bump: patch -->

## What Changed

2026-11-20 post-mortem A3. Node 26 bundles undici 8, whose `fetch` negotiates HTTP/2 with any host that offers it (Telegram, Slack, the Claude API, Cloudflare-fronted tunnels). Node 20, 22 and 24 stay on HTTP/1.1. On a Node 26 machine the agent server's main thread got stuck in `Http2Session::SendPendingData` and its memory grew by gigabytes a minute (10 to 37 GB, killed five times in 16 hours). The Telegram egress door could not prevent it: Node 26 refuses the npm-undici dispatcher it passes, so it fell back to Node's default.

Every instar process now starts by replacing Node's default fetch dispatcher with the same class, built with `allowH2: false` (`src/core/http1GlobalFetch.ts`, called from `src/cli.ts` before any command runs). A dispatcher installed on purpose (a proxy agent, a test mock) is left alone and logged. `node:http2` used directly (APNs push) is unchanged. Opt-out: `INSTAR_ALLOW_FETCH_HTTP2=1`.

## What to Tell Your User

- **Steadier on newer Node**: "On machines with the newest Node, my server no longer risks a runaway memory loop when a web request is cut short. It talks to the outside world the same way it does on older Node."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| fetch pinned to HTTP/1.1 in every instar process | Automatic; `INSTAR_ALLOW_FETCH_HTTP2=1` opts out |

## Evidence

- `tests/unit/http1GlobalFetch.test.ts`: a local TLS server offering h2 and http/1.1 records the protocol. Run on Node 26.13.0 (the Laptop), the unpinned baseline arrives on `2.0`; after the pin GET, a 300 KB multipart upload, and a request after an aborted 5 MB upload all arrive on `1.1`. Same file green on Node 22.
- `tests/integration/telegram-egress-http1.test.ts`: a multipart upload through `telegramFetch` and a request after a deadline-cancelled 20 MB upload arrive on HTTP/1.1.
- `tests/e2e/cli-fetch-http1-pinned.test.ts`: the built `dist/cli.js` has pinned the dispatcher before a command runs; the opt-out leaves it alone.
- Live: the Laptop's Echo server with the equivalent preload (tmux global `NODE_OPTIONS`) since 19:01 UTC; RSS record in the PR body.
