# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Codex usage is now readable over HTTP — the codex `/status` rate-limit
windows, without the interactive TUI.** Codex has no public usage API, but the
codex CLI persists the authoritative account rate-limit windows it gets back
from OpenAI — primary (5h rolling) and secondary (weekly) — into each session
rollout's `token_count` events. A new reader
(`readLatestCodexUsage`) finds the newest rollout, reads only its tail (the
windows are appended per-turn, so the freshest is near the end), and returns a
structured snapshot. A new read-only route, `GET /codex/usage`, surfaces it:

```
{ "available": true,
  "usage": {
    "primary":   { "usedPercent": 13, "remainingPercent": 87, "windowMinutes": 300,   "resetsAtIso": "…", "resetsInSeconds": … },
    "secondary": { "usedPercent": 93, "remainingPercent": 7,  "windowMinutes": 10080, "resetsAtIso": "…", "resetsInSeconds": … },
    "model": "gpt-5.5", "planType": "plus", "rateLimitReachedType": null } }
```

`available:false` (still HTTP 200, never 503 — it is a disk reader) means there
is simply no codex session data on disk yet (e.g. a pure-Claude agent). This is
the data an agent needs to answer "how much codex usage is left?" and to drive a
model-swap when a window is exhausted (`rateLimitReachedType` non-null, or
`secondary.remainingPercent` low).

The route is classified in the capability index (discoverable via
`GET /capabilities`), surfaced in the CLAUDE.md template for new agents, and
back-filled into existing agents' CLAUDE.md by the migrator (so deployed agents
learn it on update). Also restores the feature-delivery-completeness test to
green by tracking two prior dark/operational migrator sections
(`Autonomous-fix loop`, `Multi-Machine Session Pool`) that had not been
registered.

**Codex agents can auto-swap to a fallback model when their weekly window is
exhausted (ships DARK).** Building on the usage reader above: at codex session
launch, if the main model's weekly window is spent (or codex flags a limit hit),
the next session launches on a configured fallback model that draws on a separate
quota bucket — instead of stalling. The decision is a pure policy
(`resolveCodexLaunchModel`) wired into both codex launch paths in
`SessionManager` (headless + interactive). Gated behind
`codex.rateLimitModelSwap.{enabled,fallbackModel,weeklyRemainingThreshold}`;
off by default with zero spawn-path overhead. The fallback model id is operator
config — never hardcoded — because the exact id and its subscription
availability are the account owner's to confirm.

## Summary of New Capabilities

- `GET /codex/usage` — the freshest codex account rate-limit snapshot (primary
  5h + secondary weekly windows, with used/remaining percent, window length,
  absolute + relative reset, plan type, and which window — if any — is
  exhausted). Read-only; never mutates session state.
- An optional `?codexHome=` query parameter targets a specific `$CODEX_HOME`
  (defaults to `~/.codex`).
- Agent-awareness: the capability appears in `GET /capabilities`, the CLAUDE.md
  template, and is migrated into existing agents.
- Codex rate-limit model-swap (dark): `codex.rateLimitModelSwap` —
  auto-launch the next codex session on `fallbackModel` when the weekly window's
  remaining percent is at or below `weeklyRemainingThreshold` (default 10) or
  codex reports a limit hit. Off by default; best-effort and fail-safe (a usage
  read never blocks a launch).

## What to Tell Your User

You can now ask me how much codex usage is left and I can answer directly,
without opening the codex status screen myself — I read the same five-hour and
weekly limit windows the codex tool reports. I can tell you the percent used and
remaining on each window, when each one resets, which model is in effect, and
whether either window is currently maxed out. This also gives me the signal I
need to switch models before the weekly limit runs out. Nothing changes for you
on update; the capability is simply there when you need it.

And if you want it, I can now do that switch automatically: when a codex agent's
weekly model quota is nearly spent, the next session it starts can launch on a
backup model that has its own separate budget, so it keeps working instead of
stalling. This is off until you turn it on and tell me which backup model to use
— the exact name and whether it works on your subscription is something only you
can confirm — so nothing changes by default.

## Evidence

**Source of truth.** Inspected a live codex rollout
(`~/.codex/sessions/2026/05/30/rollout-…jsonl`) and confirmed each
`token_count` event carries `payload.rate_limits` with `primary`
(window_minutes 300) and `secondary` (window_minutes 10080) sub-objects, each
with `used_percent` and `resets_at`, plus `plan_type` and
`rate_limit_reached_type`. The observed `secondary.used_percent` of 93 (i.e. 7%
weekly remaining) matched the codex `/status` screen at the same moment —
verifying the on-disk windows equal the TUI's.

**Before:** there was no way for an agent to read codex usage programmatically —
the only surface was the interactive TUI (`UsageMeterProvider.isAuthoritative()`
returns false and only does local token accounting), so an agent could not
answer "where does codex usage sit?" or react to an exhausted window.

**After:** `GET /codex/usage` returns the structured snapshot above. Verified by
a 3-tier test suite (16 tests, all green): unit tests parse the latest
`token_count` (newest event wins; malformed lines skipped; missing-window
tolerated; reached-type surfaced), an integration test drives the route over
HTTP against a rollout fixture (data → `available:true`; none → `available:false`
+ 200), and a Tier-3 lifecycle test boots the real AgentServer and confirms the
route is alive (200, Bearer-gated, read-only POST→404).
