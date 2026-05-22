---
review-convergence: "internal-adversarial-1"
approved: false
approved-by: null
slug: rate-limit-sentinel
companion-eli16: rate-limit-sentinel.eli16.md
note: "External cross-model (/crossreview) not available on this host; one internal adversarial side-effects review run, all BLOCKER + SHOULD-FIX findings folded in (see Review log)."
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
  - `SessionManager` idle-error path (`SessionManager.ts:595-607`) — when the matched error is a
    throttle (not a generic API error), it **skips its immediate nudge** and emits
    `'rateLimitedAtIdle'` instead, deferring ownership to the sentinel. Generic API errors keep the
    existing single-nudge behavior.
    - **(S3)** The skip path does **not** add the session to `errorNudgedSessions` (so a later
      *generic* API error on the same session can still get its one nudge), and does **not** reset
      `idlePromptSince`. Because the throttle string persists across many monitor ticks, this path
      re-emits `rateLimitedAtIdle` every tick — that is intentional and safe: `report()` dedupes via
      the active map (synchronous `active.set` before any await), so only the first emit starts a
      lifecycle. The zombie-kill veto (below) is in place from that same synchronous `report()`, so
      the idle-clock continuing to run is harmless.
- **Authority (decide + act):** `RateLimitSentinel.report(sessionName, trigger)` dedupes both
  triggers and runs the lifecycle.
- **(S2)** Add `rateLimitedAtIdle: [sessionName: string]` to the `SessionManagerEvents` interface
  (`SessionManager.ts:128`) for type safety and discoverability.

### Detection predicate

Detection captures the **last 20 pane lines** (`captureOutput(tmuxSession, 20)`) — enough to hold the
throttle line, any trailing prompt, and a still-present retry spinner, without the 10-line recency
gate `detectCompactionIdle` uses (recency here is enforced by the idle precondition, not line count).

The matched strings are taken from authoritative sources, not invented: the throttle string from the
user's live screenshot (`API Error: Server is temporarily limiting requests (not your usage limit) ·
Rate limited`), the 529 form and the retry-spinner format (`Retrying in Ns · attempt x/y`) from the
Claude Code error reference. **These exact strings become test fixtures (S5); treat them as
empirical-until-reverified per "verify against real APIs before shipping."**

Fires only when ALL hold (case-insensitive, against sanitized output — `·` middot stripped to
tolerate ANSI/encoding drift, so spinner match keys on `retrying in … attempt`):

1. Matches a throttle pattern:
   - `/server is temporarily limiting requests/`
   - `/not your usage limit/`
   - `/repeated 529 overloaded errors/` or `/\b529\b[^\n]*overloaded/`
2. Does **not** match a usage-limit pattern (`you've hit your (session|weekly|opus|usage) limit`,
   `resets \d…`). Usage exhaustion is PresenceProxy/QuotaExhaustionDetector's domain — wait-for-reset,
   not retry.
3. Does **not** show an active retry spinner — match on `/retrying in\s+\d+/i` after middot-stripping
   (the framework is still retrying internally; we do not intervene). Fixtures must include the real
   rendered spinner; if its true format differs from the doc string, the regex is corrected before
   merge.
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
   (size+mtime, by Claude session UUID, exactly as CompactionSentinel does). **Defer** (via the
   injected `deferIf` predicate, see S6) if a compaction recovery is already active for this session.
2. **Notify immediately** (fixed template, no LLM — cheap + safe), routed through the suppression
   coordination below: *"Heads up — Claude hit a temporary server-side throttle on Anthropic's side
   (not your usage limit). I'm backing off and will keep retrying. You haven't been dropped — I'll
   check back in."*
3. **Backoff before re-engaging.** Wait the next interval from
   `backoffScheduleMs` (default `[30000, 60000, 120000, 300000, 300000, 300000]`) — *then* nudge.
   This is the core quota-burn mitigation: give Anthropic capacity time to recover instead of
   hammering. (We sit on top of Claude's already-exhausted internal retries.)
4. **Re-engage (neutral nudge — B1).** Inject a topic-tagged **continue** prompt via the injected
   `resumeFn`. **This is NOT `recoverCompactedSession`** — that helper injects a hardcoded *"your
   session just went through context compaction…"* preamble (`compactionResumePayload.ts:74`), which
   is false for a throttled session (its working memory is intact) and would tell the agent to re-read
   context it never lost. The sentinel's `resumeFn` injects a neutral nudge, analogous to the existing
   throttle-free nudge at `SessionManager.ts:602`, e.g.:
   `[telegram:{topicId}] The temporary server throttle should have cleared — please continue where
   you left off.` Server.ts constructs this resumeFn separately (topic lookup → `injectMessage`).
   Transition `resuming`.
5. **Verify (JSONL growth).** After `verifyWindowMs` (default 25 000, matches CompactionSentinel),
   check whether the session's JSONL grew. Grew → **recovered**.
6. **Check-in at the verify-fail transition.** When a verify fails and the next backoff is being
   scheduled, if `checkInEveryMs` (default 120 000) has elapsed since the last user message, send:
   *"Still throttled on Anthropic's side — next retry in {nextBackoff}. Still here, haven't dropped
   you."* (Min-spacing gate, never spam.) This is emitted synchronously at the transition, **not** a
   separate concurrent timer — see the timer model below.
7. **Recovered.** Notify: *"Back online — Anthropic's throttle cleared. Continuing where I left
   off."* Finalize; keep state briefly (zombie-veto race guard) then clear.
8. **Escalate.** After `maxAttempts` (default 6) OR `maxWindowMs` (default 30 min), send a final
   notice: *"Still can't get through after {n} tries over {duration}. This is on Anthropic's side —
   status.claude.com has live capacity notices. I'll keep watching at a slower cadence; you can also
   just message me to retry."* Finalize as `escalated`.

### Timer model (N2)

The lifecycle is **strictly sequential** — at any instant a session is *either* waiting out a backoff
*or* waiting out a verify window, never both. Check-ins are emitted synchronously at the
verify-fail→backoff transition (step 6), not on an independent cadence. Therefore a single
timer-per-session slot (as in `CompactionSentinel.ts:126`) is sufficient and there is **no** timer
collision: the one pending timer always represents the single next state transition. The spec
explicitly forbids modelling backoff/verify/check-in as three concurrent timers.

### Zombie-kill veto (S1 — EDIT the existing single-predicate wiring)

`SessionManager.setActiveRecoveryChecker` is a **single** predicate field
(`SessionManager.ts:150`, setter at 323, consumed at 622), currently set once to
`compactionSentinel.isRecoveryActive` at `server.ts:4996-4998`. Setting it again would *replace*
(not compose) and silently drop the compaction veto. The implementation must **edit that exact call
site** to an OR of both predicates:

```ts
// server.ts:4996 — EDIT IN PLACE (do not add a second setActiveRecoveryChecker call)
sessionManager.setActiveRecoveryChecker(session =>
  compactionSentinel.isRecoveryActive(session.tmuxSession) ||
  rateLimitSentinel.isRecoveryActive(session.tmuxSession));
```

A wiring-integrity unit test asserts the composed checker returns true for a session in *either*
compaction *or* rate-limit recovery.

### Bidirectional cross-sentinel deferral (S6)

The two sentinels are separate instances with independent `active` maps, so deferral must be
**bidirectional** or a `PreCompact` event mid-throttle (and vice-versa) races two injections into one
pane. Add an optional `deferIf?: (sessionName: string) => boolean` dep to **both** sentinels'
constructors, checked at the top of `report()` (after the dedupe maps, before `active.set`). Wire
each to the other in server.ts:

```ts
// after both are constructed
rateLimitSentinel.setDeferIf(s => compactionSentinel.isRecoveryActive(s));
compactionSentinel.setDeferIf(s => rateLimitSentinel.isRecoveryActive(s));
```

(CompactionSentinel gains a no-op-safe `deferIf`/`setDeferIf`; default `() => false` preserves
current behavior.)

### Coordination with PresenceProxy / triage (B2)

The deferral the original draft assumed does **not** exist — there is no proxy-defers-to-external-
sentinel hook today, and `ProxyCoordinator` (`server.ts:5298`) is a PresenceProxy↔PromiseBeacon mutex
that the proxy only consults for **Tier 2/3** (Tier 1 is explicitly never suppressed,
`PresenceProxy.ts:893`). PresenceProxy fires on any unanswered user message and would 🔭-post about
the throttle concurrently with the sentinel.

Fix: add a `hasActiveRateLimitRecovery?: (topicId: number) => boolean` suppression hook to
`PresenceProxyConfig`, wired exactly like the existing `hasRecentBuildHeartbeat` suppression
(`server.ts:5482`), and checked at the **top of every tier** (including Tier 1) so the sentinel —
already messaging the user — is the sole voice during recovery. server.ts implements the hook as
`topicId => { const s = telegram?.getSessionForTopic(topicId); return s ? rateLimitSentinel.isRecoveryActive(s) : false; }`.

### CLAUDE_CODE_MAX_RETRIES (N1)

Make Claude Code's own retry count configurable via instar config and inject it into the spawn env
as an additive `-e` flag, only when set:
`...(claudeCodeMaxRetries != null ? ['-e', \`CLAUDE_CODE_MAX_RETRIES=${claudeCodeMaxRetries}\`] : [])`
— matching the established `INSTAR_SESSION_ID` pattern. Two spawn sites take it: the interactive
Telegram path `spawnInteractiveSession` (`SessionManager.ts:1499-1534`, the one that matters here)
and, for parity, the headless `spawnSession` (`~844-865`). Default **unset** (Claude's own default
10 stands) to avoid masking genuine outages — raising it is opt-in.

**Limitation:** env only applies to *future* spawns; it cannot help a currently-throttled session.
This is prevention, not part of the live-recovery loop.

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

- **Config defaults (B3)** — Add the `rateLimitSentinel` block to `SHARED_DEFAULTS` in
  `src/config/ConfigDefaults.ts:18`. The per-feature `migrateConfig()` blocks were removed;
  `PostUpdateMigrator.migrateConfig` (`PostUpdateMigrator.ts:3043`) now applies `ConfigDefaults`
  wholesale via `applyDefaults`, which recurses nested objects and adds a missing array
  (`backoffScheduleMs`) as a unit (`ConfigDefaults.ts:185-209`). **Note:** `enabled: true` in
  SHARED_DEFAULTS means the feature defaults **on** for every existing agent on update (intended).
- **CLAUDE.md template** — `generateClaudeMd()` monitoring section gains a RateLimitSentinel line so
  agents know throttle resilience exists. (`claudeCodeMaxRetries` stays unset by default, so no
  template/config churn there unless an operator opts in.)
- **Hooks** — none new (detection is in-process via the watchdog poll).
- **Skills** — none.
- **Wiring** — `server.ts` instantiates the sentinel, **edits** the existing recovery-checker call
  (S1) to OR both predicates, wires the bidirectional `deferIf` (S6), the PresenceProxy suppression
  hook (B2), both signal triggers, and registers `/rate-limit/status`.

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

## Review log

Internal adversarial side-effects review (1 round), grounded against v1.2.29 code. Findings folded
into the spec above:

- **B1** (BLOCKER) — `recoverCompactedSession` injects a false "you compacted" preamble; spec now
  mandates a dedicated neutral nudge resumeFn. → §Lifecycle step 4.
- **B2** (BLOCKER) — the PresenceProxy deferral assumed didn't exist; spec now adds a real
  `hasActiveRateLimitRecovery` suppression hook covering Tier 1. → §Coordination.
- **B3** (BLOCKER) — per-feature `migrateConfig` blocks are gone; spec now targets
  `ConfigDefaults.ts` SHARED_DEFAULTS. → §Migration parity.
- **S1** — `setActiveRecoveryChecker` is single-predicate; spec now mandates editing the existing
  call site, not adding a second. → §Zombie-kill veto.
- **S2** — `rateLimitedAtIdle` added to `SessionManagerEvents`. → §Signal sources.
- **S3** — skip path doesn't consume `errorNudgedSessions`; relies on sentinel dedupe. → §Signal sources.
- **S4/S5** — capture window pinned to 20 lines; rendered strings locked to screenshot+docs and made
  fixtures; spinner regex middot-tolerant, corrected-before-merge if real format differs. → §Detection.
- **S6** — cross-sentinel deferral made bidirectional via `deferIf`. → §Bidirectional deferral.
- **N1** — both spawn sites named; env is future-spawn-only. → §CLAUDE_CODE_MAX_RETRIES.
- **N2** — lifecycle is strictly sequential; single timer slot suffices, three concurrent timers
  forbidden. → §Timer model.
