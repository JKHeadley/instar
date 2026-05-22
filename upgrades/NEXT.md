# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- minor = new agent-facing capability (RateLimitSentinel — server-throttle survival) without breaking changes. Default-on; off-switch is one config flag. -->

## What Changed

**feat(monitoring): RateLimitSentinel — ride out Anthropic's server-side throttle instead of dropping the session.**

Anthropic recently started surfacing a new Claude Code error: *"Server is temporarily limiting requests (not your usage limit) · Rate limited"* (and the related *"Repeated 529 Overloaded errors"*). This is a short-lived, shared-capacity throttle on Anthropic's side — **not** your account's usage cap. Claude Code already auto-retries it ~10 times with its own exponential backoff before it ever shows the message, so by the time you see it on screen, those built-in retries are exhausted and the session sits idle with no reply ever relayed to the user.

Instar's prior behavior made this worse, not better. SessionManager's idle-error path fired a single *immediate* nudge the moment it saw an "API Error:" — which slams straight back into the live throttle, burns quota for nothing, and then goes silent until the zombie-killer reaps the session. There was no user-facing signal that the agent was throttled-but-alive.

This release adds a dedicated **`RateLimitSentinel`** (same own-the-lifecycle shape as `CompactionSentinel`) that owns recovery end to end:

1. **Detect** — a pure predicate (`src/monitoring/rateLimitDetection.ts`) distinguishes the server throttle from the user's plan/usage quota (PresenceProxy's domain — wait-for-reset, not retry) and from Claude's own in-progress retry spinner (the framework still owns it). Strings are taken from the user's live screenshot and the Claude Code error reference, not invented.
2. **Notice immediately** — a fixed-template message tells the user they're throttled, backing off, and *not* dropped. No LLM call.
3. **Back off BEFORE re-engaging** — escalating schedule (30s → 1m → 2m → 5m, last value repeats). This is the core quota-burn mitigation: we sit on top of Claude's already-exhausted retries instead of hammering.
4. **Re-engage neutrally** — a plain "continue where you left off" nudge, *not* the compaction-resume payload (which would falsely tell the agent its memory was reset).
5. **Verify** — JSONL size/mtime growth means Claude processed the nudge and the throttle cleared.
6. **Check in** — periodic user updates at verify-fail transitions, minimum-spacing gated so it never spams.
7. **Escalate** — after a capped attempts/window envelope (6 attempts or 30 min), a final "this is on Anthropic's side, status.claude.com has live notices, message me to retry" message.

**Two signal triggers, one authority.** Per `feedback_signal_vs_authority`: both `SessionWatchdog` (periodic poll) and `SessionManager` (idle-error path) emit signals; the sentinel holds sole recovery authority and dedupes the two. SessionManager skips its single-nudge for the throttle case and hands ownership over — *without* consuming the nudge token, so a later generic API error still gets its one nudge.

**Coexistence with the other recovery engines:**
- **Zombie-kill veto** — `setActiveRecoveryChecker` now ORs both sentinels (the predicate is *edited*, not a second call — a second `setActiveRecoveryChecker` would silently drop the compaction veto). The reaper won't kill a session mid-throttle-recovery.
- **Bidirectional deferral** — `RateLimitSentinel` and `CompactionSentinel` each defer to the other via `deferIf`, so the two never inject into one pane concurrently.
- **PresenceProxy suppression** — while a throttle recovery owns a topic's session, PresenceProxy stays silent across *every* tier (including Tier 1), so the user hears one voice. It re-checks after a delay and resumes only if the agent is still silent post-recovery.

**Opt-in retry-count raise.** A new `claudeCodeMaxRetries` config field, when set, injects `CLAUDE_CODE_MAX_RETRIES` at session spawn so Claude rides out transient throttle/overload longer before surfacing to the sentinel. Unset by default (Claude's default of 10 stands) so genuine outages aren't masked.

Spec: `docs/specs/rate-limit-sentinel.md` (ELI16 overview up top, full technical spec below). The spec folded in an adversarial side-effects review (over/under-block, race conditions, quota-burn safety, signal-vs-authority, interactions with the other sentinels) before build.

## What to Tell Your User

Sometimes Anthropic's servers get briefly overloaded and slow everyone down for a minute or two. This is different from running out of your usage — it's a temporary "the servers are busy right now" speed bump on their end. Before this release, when that happened your agent could go quiet with no explanation, and the way it tried to recover actually wasted your usage hours by knocking on the door over and over.

Now your agent handles it gracefully. The moment it hits one of these server slowdowns it sends you a quick note — *"heads up, Anthropic's servers are briefly throttling, I'm backing off, you haven't been dropped"* — then waits a bit, tries again, waits a little longer, tries again, and keeps you posted while it's stuck. When the servers free up, it picks right back up where it left off and tells you it's back. If it's still stuck after about half an hour, it lets you know it's an Anthropic-side issue and that you can just message it to retry.

You don't have to do anything — it's on by default for every agent. If you ever want the old behavior back, it's a single config switch.

## Summary of New Capabilities

- **`RateLimitSentinel`** — new monitoring module that owns the full detect → notice → backoff → resume → verify → check-in → escalate lifecycle for Anthropic's server-side throttle.
- **`GET /rate-limit/status`** — read-only observability route (Bearer-gated): active recoveries with `sessionName`, `status`, `attempts`, `nextBackoffMs`. Returns `{ enabled: false, active: [] }` (never 503) when the sentinel is absent.
- **`monitoring.rateLimitSentinel` config** — `{ enabled: true }` by default; `enabled: false` restores pre-feature behavior. Backoff schedule, max attempts, window, verify window, check-in spacing, and dedupe window are all overridable.
- **`claudeCodeMaxRetries` config** — opt-in `CLAUDE_CODE_MAX_RETRIES` raise at session spawn.
- **Migration parity** — `rateLimitSentinel` default flows to existing agents automatically via the canonical `ConfigDefaults` registry applied by `PostUpdateMigrator` on update. No agent ships dead.

## Evidence

- **Tier 1 unit tests:** `tests/unit/RateLimitSentinel.test.ts` (14 tests) covers the lifecycle, dedupe across both triggers, escalation on attempt/window exhaustion, escalation when resume declines, check-in min-spacing, independent per-session recovery, and `listActive` shape. `tests/unit/rate-limit-detection.test.ts` (12 tests) covers throttle-vs-usage-limit-vs-retry-spinner discrimination with real fixture strings. All 26 passing.
- **Tier 2 integration tests:** `tests/integration/rate-limit-status-routes.test.ts` (4 tests) — `GET /rate-limit/status` through the real `createRoutes` pipeline (active + disabled cases), plus wiring-integrity tests guarding the zombie-veto composition (EITHER sentinel owning a session holds the veto — the S1 regression where a second `setActiveRecoveryChecker` drops the compaction veto) and the bidirectional `deferIf`. All passing.
- **Tier 3 E2E lifecycle:** `tests/e2e/rate-limit-sentinel-lifecycle.test.ts` (4 tests) boots the real `AgentServer` with the sentinel passed through exactly as `server.ts` wires it, and asserts `GET /rate-limit/status` returns **200 with `enabled: true`** — the "feature is alive" check that catches the case where `AgentServer`'s `?? null` plumbing drops the sentinel. Also verifies a reported throttle surfaces on the wire with the documented shape and that `isRecoveryActive` (the production zombie-veto predicate) tracks correctly. All passing.
- **Type-check:** `npx tsc --noEmit` clean.
- The full test suite must remain green before merge per the Zero-Failure Standard.
