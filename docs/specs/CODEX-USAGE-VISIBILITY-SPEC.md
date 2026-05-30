---
title: Read codex /status rate-limit usage over HTTP (GET /codex/usage)
review-convergence: retrospective-single-pass
approved: true
eli16-overview: CODEX-USAGE-VISIBILITY.eli16.md
---

# Read Codex `/status` Rate-Limit Usage Over HTTP

## Problem

Codex has no public usage endpoint. The openai-codex `UsageMeterProvider`
implementation says so explicitly: `isAuthoritative()` returns `false` and it
falls back to local accounting from `turn.completed.usage` events. So an instar
agent driving codex has no way to answer "how much codex usage is left?" or
"are we about to hit the weekly limit?" — the only surface is the codex CLI's
interactive `/status` TUI, which an agent cannot read.

This is a concrete operational gap: a codex agent (e.g. codey) whose weekly
window is nearly exhausted will start failing turns with no warning, and the
supervising agent cannot see it coming or react (e.g. by swapping to a model
with a separate quota bucket).

## Key insight

The codex CLI DOES persist the authoritative account rate-limit windows it
receives from OpenAI. Every turn, it appends a `token_count` event to the
session rollout JSONL whose `payload.rate_limits` carries the same windows the
`/status` screen shows:

```
{ "type": "event_msg",
  "payload": {
    "type": "token_count",
    "rate_limits": {
      "limit_id": "codex",
      "primary":   { "used_percent": 13, "window_minutes": 300,   "resets_at": 1780171524 },
      "secondary": { "used_percent": 93, "window_minutes": 10080, "resets_at": 1780174809 },
      "plan_type": "plus",
      "rate_limit_reached_type": null } } }
```

`primary` is the 5h rolling window; `secondary` is the weekly window. This was
verified against a live rollout: `secondary.used_percent = 93` (7% weekly
remaining) matched the `/status` screen at the same instant.

## Solution

A read-only reader + route. No mutation of any session state.

1. **`codexRateLimitReader.ts`** (`src/providers/adapters/openai-codex/observability/`)
   - `readLatestCodexUsage({ codexHome?, nowMs?, maxRolloutsScanned?, tailBytes? })`
     — uses the existing `listAllRollouts` to get the newest rollouts, tail-reads
     each (rate-limit events are appended per-turn, so the freshest is near the
     end), parses the most recent `token_count` `rate_limits`, and returns a
     structured `CodexUsageSnapshot`. Falls through to the next-newest rollout
     when the newest has no `token_count` yet. Returns `null` when no codex
     rollout with rate-limit data exists.
   - `parseUsageFromTail(tail, rolloutPath, nowMs)` — pure parser, exported for
     unit tests. Newest matching event wins; malformed lines are skipped; a
     missing window degrades to `null` for that window only; `model` is a
     best-effort read of the latest `turn_context.model`.
   - Derived fields: `remainingPercent` (100 − used, clamped), `resetsAtIso`,
     and `resetsInSeconds` (relative to an injectable clock).

2. **`GET /codex/usage`** (`src/server/routes.ts`)
   - Returns `{ available: true, usage: <snapshot> }` when data exists, else
     `{ available: false, usage: null, reason }`. Always HTTP 200 when wired —
     it is a disk reader, not a 503 wired-or-not subsystem. Optional
     `?codexHome=` targets a specific `$CODEX_HOME` (defaults to `~/.codex`).
   - Bearer-gated like every non-health route. Read-only (no POST/PUT/DELETE).

3. **Discoverability + awareness.** A `CapabilityIndex` entry under the
   `/codex` prefix (so the route is classified for the capabilities lint and
   surfaced via `GET /capabilities`); a CLAUDE.md template section
   (`generateClaudeMd`) for new agents; and a `migrateClaudeMd` content-sniff
   block (on the `/codex/usage` marker) for existing agents on update.

## Signal vs authority

This change is a pure SIGNAL producer with NO blocking authority. It reads
on-disk data and returns it. It gates nothing, blocks nothing, and filters no
message. The downstream model-swap policy (a separate change) is the consumer
that will *act* on this signal; this spec only surfaces it. Per
`docs/signal-vs-authority.md`, a read-only reporter at the observability layer is
exactly the right shape — there is no decision point here to get wrong.

## Testing

Three tiers (16 tests):
- **Unit** (`tests/unit/codexRateLimitReader.test.ts`) — parser + reader, both
  sides of every boundary (latest-event-wins, malformed-skipped,
  missing-window-tolerated, reached-type-surfaced, no-data→null,
  fallback-to-older-rollout).
- **Integration** (`tests/integration/codex-usage-route.test.ts`) — the route
  over HTTP against a rollout fixture (data → `available:true`; exhausted-window
  signal; none → `available:false` + 200).
- **E2E** (`tests/e2e/codex-usage-lifecycle.test.ts`) — boots the real
  `AgentServer`: route is alive (200), Bearer-gated (401), read-only (POST→404).

## Rollback

Pure additive. Back-out is removing the route + reader + the
`CapabilityIndex`/template/migrator entries; no data migration, no agent-state
repair. The migrator block is idempotent (content-sniffed), so a re-run is
safe.

## Authority note

Shipped autonomously under the 12-hour session's "merge → release → deploy →
verify" mandate, which delegates the `approved: true` flip. Flagged in the PR
for asynchronous human review. `review-convergence: retrospective-single-pass`
reflects that the design converged in a single pass during the autonomous run
rather than through a separate multi-pass `/spec-converge` cycle.
