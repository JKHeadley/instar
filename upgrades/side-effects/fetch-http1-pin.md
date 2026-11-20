# Side-Effects Review — outbound fetch pinned to HTTP/1.1

**Version / slug:** `fetch-http1-pin`
**Date:** `2026-11-20`
**Author:** `Echo`
**Second-pass reviewer:** `not required (no gate, sentinel, watchdog, messaging block/allow, or session lifecycle change)`

## Summary of the change

2026-11-20 outage post-mortem A3: the Laptop's Echo server (Node 26.13.0, bundled undici 8.12.2) ballooned to 10-37 GB five times in 16 hours; all six native samples (`.instar/logs/server-rss-sample-20261120T*.txt` on the Laptop) show the main thread inside `node::http2::Http2Session::SendPendingData` → `nghttp2_session_mem_send` → `Http2Stream::Provider::Stream::OnRead` → `FindStream`, i.e. packing DATA frames for a stream Node no longer tracks. Measured on the Laptop: Node 26's global `fetch` opens an HTTP/2 session (`http2.connect`) to api.telegram.org, slack.com and api.anthropic.com; Node 22.23.5 (Studio) opens none. The Telegram egress door's npm-undici dispatcher is refused by Node 26 (existing comment in telegram-egress.ts), so it falls back to Node's default, which is HTTP/2. A local preload that forced HTTP/1.1 on the Laptop (installed Nov 5, last active Nov 15) was wiped by an update; the balloons on Nov 19-20 all ran without it.

New `src/core/http1GlobalFetch.ts`: one `data:` fetch makes Node create its default dispatcher; that dispatcher's own constructor builds a replacement with `allowH2: false` in the same slot (`undici.globalDispatcher.2` on Node 26, `.1` on Node 20-24). Called once from `src/cli.ts` before any command runs, so the server, the lifeline and every CLI command are covered. A dispatcher that is not one Node installs itself (`Agent` / `EnvHttpProxyAgent`) is left alone and logged. `INSTAR_ALLOW_FETCH_HTTP2=1` opts out. Tier 1, 3 source files + 3 test files, ~250 LOC.

## Decision-point inventory

None. This changes transport configuration, not a decision about agent behaviour or information flow.

## 1. Over-block

No request is refused. A host that ONLY speaks HTTP/2 over TLS would fail; none of instar's fetch targets do (Telegram, Slack, Anthropic, OpenAI, GitHub, Cloudflare tunnels, peer agent servers all accept HTTP/1.1, and every Node 20-24 agent has only ever used HTTP/1.1 with them). APNs, the one HTTP/2-only service, uses `node:http2` directly and is untouched.

## 2. Under-block

- `node:http2` used directly (MobilePush APNs transport) is not covered. Bodies are a few KB and sent in one frame; no balloon has been tied to it, but the same Node bug could in principle hit it. The supervisor memory ceiling (separate change) is the backstop for every path.
- A process that does not start through `dist/cli.js` (a script importing instar modules directly) is not pinned.
- A dispatcher passed per-request (`fetch(url, { dispatcher })`) is the caller's choice. Only telegram-egress does this, with an HTTP/1.1-only npm undici 6 Agent.
- It does not fix Node's HTTP/2 bug; it avoids the path.

## 3. Level-of-abstraction fit

Right layer: the global dispatcher is the single point every `fetch` call goes through, and the CLI entry is the single point every instar process starts from. Patching individual callers would miss new ones.

## 4. Signal vs authority compliance

No decision point; not applicable. Reference: `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

- `MacLocalNetworkAccess` subscribes to `undici:client:connectError` / `connected` diagnostics channels; these are emitted by Node's bundled undici for any Client it creates, and the replacement Agent is built from that same bundled class, so the subscription keeps seeing every connect.
- telegram-egress: on Node 26 its fallback now lands on the pinned dispatcher (integration test). On Node 22 it keeps its own dispatcher, unchanged.
- The old default dispatcher is replaced before any network request, so no open connections are orphaned (only a `data:` URL went through it).
- Tests that mock fetch by replacing `globalThis.fetch` are unaffected; tests that install their own global dispatcher run after import and are left alone by design (they are not `Agent` from Node, or they replace the slot afterwards).

## 6. External surfaces

Outbound connections use HTTP/1.1 instead of HTTP/2 on Node 26: more TCP connections per host instead of one multiplexed one (undici's default pool limits apply). One log line only if the pin is skipped or fails; a failure is also reported through DegradationReporter (feature `http1-global-fetch`, lazily imported only on that path). One env var for opt-out. No config, routes, or state.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: it is per-process transport configuration, applied identically by every machine at process start. Nothing is stored or replicated.

## 8. Rollback cost

Revert the commit, or set `INSTAR_ALLOW_FETCH_HTTP2=1` for a process. No state or migration.

## Conclusion

Smallest structural fix for the confirmed trigger: return Node 26 to the protocol every earlier Node already uses. Ship.

## Second-pass review (if required)

Not required.

## Evidence pointers

- `tests/unit/http1GlobalFetch.test.ts` (Node 22 on the Studio and Node 26.13.0 on the Laptop: unpinned baseline is `2.0` on 26, pinned is `1.1` for GET, multipart upload, and after an aborted upload).
- `tests/integration/telegram-egress-http1.test.ts`, `tests/e2e/cli-fetch-http1-pinned.test.ts`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect (runtime transport default of a Node upgrade) and no self-triggered controller — not applicable.
