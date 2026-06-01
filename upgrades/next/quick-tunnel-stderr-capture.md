# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Quick tunnels now correctly recognize when Cloudflare is rate-limiting them.**
When the zero-config quick tunnel failed because Cloudflare's free tunnel service
returned "429 Too Many Requests", instar only saw an opaque "process exited" with
no detail — it couldn't tell a rate-limit apart from any other failure, so it
couldn't react appropriately. The provider now captures cloudflared's real error
output, so a rate-limit is identified as exactly that and handed to the tunnel
manager's failure handling with the right reason.

## What to Tell Your User

Nothing to configure. If your quick tunnel ever gets rate-limited by Cloudflare,
instar now recognizes it as a rate-limit (instead of a generic failure), which
lets it respond more sensibly under that degraded condition. Named tunnels and
the healthy path are unaffected.

## Summary of New Capabilities

- `classifyQuickTunnelError(msg, stderr)` — pure, exported, unit-tested
  classifier mapping a cloudflared failure to a fixed reason
  (rate-limited / binary-missing / network / passthrough).
- `CloudflareQuickProvider` now listens to the cloudflared wrapper's `stderr`
  event, so the rate-limit text actually reaches the classifier (it never did
  before, which made the 429 detection dead on the process-exit path).

## Evidence

- Found live (2026-05-31): a quick tunnel hit Cloudflare 429, but instar
  surfaced only "process-exit code 1: no stderr captured"; the 429 was visible
  only by running cloudflared directly.
- Tests: `tests/unit/CloudflareQuickProvider.test.ts` (6) — the classifier
  across all reason branches, plus a mock-cloudflared test proving the new
  stderr listener feeds a 429 line into the classifier so start() rejects with
  rate-limited. `tsc --noEmit` clean.
- Spec: tunnel-failure-resilience (the manager's single-owner failure handling
  this classification feeds).
