# Side effects — quick-tunnel captures cloudflared stderr (429 detection)

## What was broken

`CloudflareQuickProvider` (the Tier-1 zero-config quick tunnel) classified
failures via `classifyError(msg, stderr)`, whose rate-limit branch checks the
text for `429` / `1015` / "rate limit" / "too many requests". But the provider
listened only to the cloudflared wrapper's `url` / `error` / `exit` events — it
**never listened to the wrapper's `stderr` event**, which is the only place
cloudflared's real stderr (including the `429 Too Many Requests` / `error code
1015` rate-limit line) is delivered. So `stderrTail` stayed empty, `exit` logged
the opaque `process-exit code 1: no stderr captured`, and the 429 branch was
**dead code on the exit path** — the manager could never recognize (or back off
on / surface) a Cloudflare rate-limit.

Found live (2026-05-31): a quick-tunnel start hit Cloudflare 429, but instar
surfaced only "process-exit code 1: no stderr captured"; the 429 was visible
only by running `cloudflared tunnel --url` directly.

## The fix

1. `CloudflareQuickProvider.startInner` now registers
   `tunnel.on('stderr', (data) => { stderrTail = (stderrTail + ' ' + data).slice(-2000); })`,
   capturing cloudflared's real stderr (bounded to the last 2000 chars). The
   existing `error`/`exit` handlers already feed `stderrTail` into the
   classifier, so the 429/1015 text now reaches it.
2. The classification logic is extracted to a pure, exported
   `classifyQuickTunnelError(msg, stderr)` (unchanged behavior), so the
   decision boundary is unit-testable.

## Who is affected

- **Any agent with a quick tunnel that hits Cloudflare 429** (the free
  trycloudflare service rate-limits under load): the failure is now classified
  `rate-limited:` instead of opaque `process-exit`, so the TunnelManager's
  failure handling (per the tunnel-failure-resilience spec) acts on the correct
  reason. No behavior change on the success path or for non-rate-limited
  failures (those classify exactly as before).

## Blast radius

- 1 source file: `src/tunnel/CloudflareQuickProvider.ts` (one added event
  listener + a pure-function extraction). No config, no schema, no migration —
  picked up by existing agents on the normal dist update. The TunnelManager,
  other providers, and the success path are untouched.

## Failure modes considered

- **Listener fires after resolution?** Harmless — it only appends to a bounded
  buffer; once `url` resolves, the buffer is unused.
- **stderr never arrives (true silent exit)?** Behavior is exactly as before:
  `stderrTail` empty → `exit` logs "no stderr captured" → classified generic.
  The fix can only ADD signal, never remove it.
- **Buffer growth?** Bounded to the last 2000 chars via `.slice(-2000)`.

## Tests

`tests/unit/CloudflareQuickProvider.test.ts` (6): `classifyQuickTunnelError`
across 429/1015/"too many requests"/"rate limit", ENOENT→binary-missing,
DNS/ECONNREFUSED→network, and unrecognized→preserved; plus a mock-`cloudflared`
test proving the new `stderr` listener feeds a 429 stderr line into the
classifier so `start()` rejects `rate-limited` (rather than the opaque
`process-exit`). `tsc --noEmit` clean.
