---
review-convergence: "pending"
approved: false
approved-by: null
slug: rate-limit-sentinel
companion-eli16: rate-limit-sentinel.eli16.md
---

# RateLimitSentinel — Surviving Anthropic's Server-Side Throttle

## Problem

Claude Code surfaces a server-side capacity throttle as:

```
API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited
```

(and a sibling form, `API Error: Repeated 529 Overloaded errors`). Per the Claude Code error
reference, these are short-lived **shared-capacity** throttles — *not* the account's plan/usage
quota. Claude Code already auto-retries them up to `CLAUDE_CODE_MAX_RETRIES` (default 10) with
internal exponential backoff, showing a `Retrying in Ns · attempt x/y` spinner. **When the message
finally appears on the pane, those internal retries are already exhausted.**

This is a recently-surfaced scenario (clustered GitHub bug reports late April 2026, several flagged
as regressions; it bites hardest when multiple sessions start close together, e.g. right after a
limit reset). For an instar agent driving a Claude Code session in tmux on behalf of a Telegram
user, the failure mode is: **the session stops with the error and no reply is ever relayed.** The
user sees silence and assumes they were dropped.

### Verified gaps in current code (v1.2.29)

1. **`SessionManager` nudges immediately, with no backoff, exactly once.**
   `TERMINAL_ERROR_PATTERNS` (`src/core/SessionManager.ts:95`) includes `'API Error:'`, which
   matches the throttle string. The idle-error path (`SessionManager.ts:595-607`) fires a single
   nudge — *"You hit an API error. Please continue your work…"* — the instant the session goes idle.
   Re-engaging an actively-throttled endpoint immediately just hits the throttle again and **burns
   quota for nothing** (one upstream reporter lost ~20% of a 5-hour allowance this way). After that
   one nudge, `errorNudgedSessions` blocks any further nudge, so a persistent throttle leaves the
   session idle until the zombie-killer reaps it — **dropped, no response.**

2. **`PresenceProxy` does not recognize the throttle string.**
   `QUOTA_EXHAUSTION_PATTERNS` (`src/monitoring/PresenceProxy.ts:253-260`) matches only usage-limit
   phrasing (`you've hit your limit`, `usage limit … reached`, `rate limit … exceeded`, `resets …`).
   The throttle string — which literally says `(not your usage limit)` and `Rate limited` (no
   "exceeded") — matches none of them. Correct (it must *not* be mislabeled a usage cap), but it
   also means no tailored "you're throttled, backing off, still here" message ever goes out.

3. **No backoff, no escalating retry, no periodic check-in** specific to this scenario.

## Background

| Fact | Source |
| --- | --- |
| Now an officially documented Claude Code error under "Usage limits"; explicitly *not* a plan quota | code.claude.com/docs/en/errors |
| Auto-retried up to `CLAUDE_CODE_MAX_RETRIES` (default 10) with exponential backoff before shown | code.claude.com/docs/en/errors → "Automatic retries" |
| 529 overloaded = "API at capacity across all users", does not count against quota; switching model can help | error reference → 529 section |
| Recently surfaced; worst observed: prompt input locks until full restart (Desktop) | github.com/anthropics/claude-code issues 53915, 52553, 53922 |

**Design consequence:** instar must NOT reimplement per-request backoff — Claude Code owns that. Our
job begins when Claude's own retries are *exhausted* and the error reaches the pane. We own
**session-level** recovery: hold off, re-engage gently, keep the user informed, escalate if it
won't clear.

## Design

A new `src/monitoring/RateLimitSentinel.ts`, modeled directly on `CompactionSentinel` (the
own-the-lifecycle pattern: detect → notify → backoff → re-engage → verify → check-in →
finalize/escalate, with dedupe across triggers and a zombie-kill veto while in flight).

### Signal vs. authority

Per the signal-vs-authority standard: low-context pattern matchers **detect and emit a signal**;
the sentinel is the **single high-context owner** that decides what to do.

- **Signal sources (detect only):**
  - `SessionWatchdog.detectRateLimited()` — new sibling of `detectCompactionIdle()`
    (`SessionWatchdog.ts:375-428`). On each `checkSession` tick it captures recent pane output and
    emits `'rate-limited'` (with a per-session cooldown) when the throttle is present AND the
    session is idle/stopped.
  - `SessionManager` idle-error path — when the matched error is a throttle (not a generic API
    error), it **skips its immediate nudge** and emits `'rateLimitedAtIdle'` instead, deferring
    ownership to the sentinel. Generic API errors keep the existing single-nudge behavior.
- **Authority (decide + act):** `RateLimitSentinel.report(sessionName, trigger)` dedupes both
  triggers and runs the lifecycle.

### Detection predicate

Fires only when ALL hold (checked against the last ~15 pane lines):

1. Matches a throttle pattern (case-insensitive):
   - `/server is temporarily limiting requests/`
   - `/not your usage limit/`
   - `/repeated 529 overloaded errors/` or `/\b529\b.*overloaded/`
2. Does **not** match a usage-limit pattern (`you've hit your (session|weekly|opus|usage) limit`,
   `resets \d…`). Usage exhaustion is PresenceProxy/QuotaExhaustionDetector's domain — wait-for-reset,
   not retry.
3. Does **not** show an active `/Retrying in \d+s?\s*·?\s*attempt/` spinner — if Claude is still
   retrying internally, the framework owns it; we do not intervene.
4. Session is idle at prompt with no active processes (reuses existing idle detection).

The `(not your usage limit)` anchor is the clean discriminator between this and the usage cap.

### Lifecycle & state machine

```
type RateLimitStatus =
  | 'detected'        // reported; first user notice sent; first backoff scheduled
  | 'backing-off'     // waiting out the current backoff interval
  | 'resuming'        // nudge injected; waiting verifyWindow for jsonl growth
  | 'recovered'       // jsonl grew → throttle cleared; user notified
  | 'escalated';      // max attempts/window exhausted; final user notice sent
```

1. **report()** — dedupe (active map + `recentReports` window). Capture JSONL baseline
   (size+mtime, by Claude session UUID, exactly as CompactionSentinel does). **Defer** if a
   compaction recovery is already active for this session (avoid double ownership).
2. **Notify immediately** (fixed template, no LLM — cheap + safe):
   *"Heads up — Claude hit a temporary server-side throttle on Anthropic's side (not your usage
   limit). I'm backing off and will keep retrying. You haven't been dropped — I'll check back in."*
3. **Backoff before re-engaging.** Wait the next interval from
   `backoffScheduleMs` (default `[30000, 60000, 120000, 300000, 300000, 300000]`) — *then* nudge.
   This is the core quota-burn mitigation: give Anthropic capacity time to recover instead of
   hammering. (We sit on top of Claude's already-exhausted internal retries.)
4. **Re-engage (nudge).** Inject a "continue" prompt via the injected `resumeFn` (the existing
   `recoverCompactedSession`-style topic-tagged `injectMessage`). Transition `resuming`.
5. **Verify (JSONL growth).** After `verifyWindowMs` (default 25 000, matches CompactionSentinel),
   check whether the session's JSONL grew. Grew → **recovered**.
6. **Periodic check-in.** On each failed verify, if `checkInEveryMs` (default 120 000) has elapsed
   since the last user message, send: *"Still throttled on Anthropic's side — next retry in
   {nextBackoff}. Still here, haven't dropped you."* (Rate-limited so we never spam.)
7. **Recovered.** Notify: *"Back online — Anthropic's throttle cleared. Continuing where I left
   off."* Finalize; keep state briefly (zombie-veto race guard) then clear.
8. **Escalate.** After `maxAttempts` (default 6) OR `maxWindowMs` (default 30 min), send a final
   notice: *"Still can't get through after {n} tries over {duration}. This is on Anthropic's side —
   status.claude.com has live capacity notices. I'll keep watching at a slower cadence; you can also
   just message me to retry."* Finalize as `escalated`.

### Zombie-kill veto (composition, not replacement)

`SessionManager.setActiveRecoveryChecker` currently takes one predicate, wired to
`compactionSentinel.isRecoveryActive` (`server.ts:4996`). This must become a **composition**:

```ts
sessionManager.setActiveRecoveryChecker(session =>
  compactionSentinel.isRecoveryActive(session.tmuxSession) ||
  rateLimitSentinel.isRecoveryActive(session.tmuxSession));
```

So a session in throttle-backoff is not reaped mid-recovery.

### Coordination with PresenceProxy / triage

PresenceProxy and the stall-triage nurse must defer to the sentinel for a topic in active
rate-limit recovery (mirrors the existing `StallTriageNurse` → PresenceProxy-Tier-3 deferral at
`server.ts:4266-4274`): if `rateLimitSentinel.isRecoveryActive(session)` for the topic's session,
PresenceProxy suppresses its standby heartbeat (the sentinel is already messaging). All sentinel
user-messages route through `ProxyCoordinator` (`server.ts:5298`) so the 🔭/⏳ emitters don't
double-post.

### CLAUDE_CODE_MAX_RETRIES

Make Claude Code's own retry count configurable via instar config and inject it into the spawn env
(`claudeCodeMaxRetries?: number`, default **unchanged at 10** to avoid masking genuine outages —
raising it is opt-in). Verify the spawn-env injection point during implementation; if the value is
unset, no env change is made (pure additive).

### Config (`RateLimitSentinelConfig`)

```ts
rateLimitSentinel?: {
  enabled?: boolean;            // default true
  backoffScheduleMs?: number[]; // default [30000,60000,120000,300000,300000,300000]
  maxAttempts?: number;         // default 6
  maxWindowMs?: number;         // default 1_800_000 (30 min)
  verifyWindowMs?: number;      // default 25_000
  checkInEveryMs?: number;      // default 120_000 (min spacing between check-ins)
  dedupeWindowMs?: number;      // default 60_000
}
```

`enabled:false` reverts to today's behavior (kill switch / rollback).

### Observability

Read-only `GET /rate-limit/status` (Bearer-auth) returning active recovery states
(sessionName, status, attempts, nextBackoffMs, lastNotifiedAt). Backs the E2E "feature is alive"
test and a future dashboard surface. Emits `rate-limit:detected | resuming | recovered | escalated`
events with a single `[RateLimitSentinel]` log prefix (greppable lifecycle).

## Migration parity

- **Config defaults** — `migrateConfig()` adds `rateLimitSentinel` with existence checks (only
  missing fields).
- **CLAUDE.md template** — `generateClaudeMd()` monitoring section gains a RateLimitSentinel line so
  agents know throttle resilience exists.
- **Hooks** — none new (detection is in-process via the watchdog poll).
- **Skills** — none.
- **Wiring** — `server.ts` instantiates the sentinel, composes the recovery checker, wires both
  triggers, registers `/rate-limit/status`.

## Testing (all three tiers — non-negotiable)

- **Unit (`RateLimitSentinel`)** — fake timers, fake `resumeFn`, fake JSONL. Cover **both** sides of
  every boundary: throttle-fires vs usage-limit-does-not; retry-spinner-present suppresses; backoff
  escalation order; recovered vs escalated; check-in spacing; dedupe across both triggers; defer when
  compaction active.
- **Unit (`detectRateLimited`)** — pattern matrix incl. the exact rendered strings and negative
  cases (usage limit, generic API error, mid-retry spinner).
- **Integration** — `/rate-limit/status` returns state through the real HTTP pipeline; wiring
  integrity (deps not null, `resumeFn` delegates, recovery-checker composition includes BOTH
  sentinels).
- **E2E** — feature-is-alive via the production init path: server boots, `/rate-limit/status` → 200,
  composed zombie-veto honors both compaction and rate-limit recovery.

## Risks & rollback

| Risk | Mitigation |
| --- | --- |
| Over-block (treats a different terminal error as throttle) | Strict patterns anchored on `(not your usage limit)` / explicit 529-overloaded; idle + no-retry-spinner preconditions |
| Quota burn from re-engaging | Backoff-**before**-nudge; capped attempts + 30-min window; sits atop Claude's own exhausted retries |
| Double ownership w/ compaction recovery | `report()` defers if compaction active; veto is OR-composed |
| Double-posting w/ PresenceProxy | Proxy defers when sentinel active; messages via ProxyCoordinator |
| Masking a real Anthropic outage | `maxWindowMs` escalates to the user with status.claude.com; default `CLAUDE_CODE_MAX_RETRIES` unchanged |

**Rollback:** `rateLimitSentinel.enabled = false` → exact pre-change behavior. No data format change,
no messaging-adapter surface touched, additive endpoint only.

## Open questions (for cross-model review)

1. Should the first user notice be suppressed for very short throttles (e.g. only notify if the
   first backoff verify fails) to reduce chatter, at the cost of a slightly later "you're not
   dropped" signal?
2. Is 30 min / 6 attempts the right escalation envelope, or should it adapt to time-of-day / repeat
   incidents?
3. On `escalated`, do we keep a slow background watch (e.g. 10-min cadence) that can self-recover and
   notify, or fully hand back to the user?
