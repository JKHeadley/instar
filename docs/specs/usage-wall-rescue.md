---
slug: usage-wall-rescue
title: Usage-Wall Rescue — a walled session moves to an account with room
author: echo
parent-principle: "The Agent Carries the Loop"
eli16-overview: usage-wall-rescue.eli16.md
approved: true
approved-basis: "Operator decision relayed by the coordinating session: Justin, topic 134156, 2026-11-04T17:49:46Z, \"yes to switching it on by default\" (scope: automatic account switching on a usage wall plus session tagging, only for pools with 2+ usable accounts). The PR's required human review is the operator's read of this spec."
review-convergence: "2026-11-04T18:36:30.157Z"
review-iterations: 6
review-completed-at: "2026-11-04T18:36:30.157Z"
review-report: "docs/specs/reports/usage-wall-rescue-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Usage-Wall Rescue

## Problem statement

On 2026-11-04 two Telegram sessions launched on a default Claude login at 100%
weekly usage. They sat at the usage wall for hours: no account swap and no
notice to the user, while the subscription pool held accounts at 10% and 47%
with fresh readings. A manual `POST /subscription-pool/swap` moved one at once,
so the swap engine works. Nothing triggered it (feedback fb-6e43a66a-75d,
fb-d2862f4d-b52). Four causes, all confirmed in code on `origin/main`:

1. **No wall trigger.** `SessionWatchdog.checkRateLimited` feeds
   `evaluateThrottleSettle`, which deliberately classifies a usage wall as
   `no-throttle` (a wall is not a server throttle). So `RateLimitSentinel` never
   escalates on a real wall, and the only reactive swap path
   (`rate-limit:escalated` → `onQuotaPressure`) never runs for one.
2. **Untagged sessions are outside every swap path.** Unless
   `subscriptionPool.pinSessionsToPool` is set, sessions carry no
   `subscriptionAccountId`. The reactive handler returns when there is no tag,
   and it is gated on `autoSwapOnRateLimit` (default off). `ProactiveSwapMonitor`
   skips untagged sessions by design (Q3); its replacement, the default-slot
   repoint, ships dark and dry-run.
3. **The standby notice reads a live wall as "recovered".**
   `PresenceProxy.detectQuotaExhaustion` counts every non-empty line below the
   banner. Claude Code 2.1.300 prints "Continuing automatically at 8am · esc to
   cancel · /usage-credits to continue now", the input box and the
   bypass-permissions status line under "Usage limit reached · limit resets
   8am"; two or more such lines made the function return null. The user got a
   generic "starting to handle the request" standby and then nothing.
4. **No spawn guard.** Nothing stops a new session launching on a default login
   the pool already knows is walled.

Operator requirement: a session that hits a wall moves to an account with room
and continues. Only when no account has room is the user told, plainly.
Accounts that need re-authentication are repaired by the agent, never handed to
the user (selection already excludes non-active accounts; repair is the
existing assisted-relogin path, unchanged here).

## Proposed design

One new module, `src/core/UsageWallRescue.ts`, owns the decisions; the move
itself stays in the existing `QuotaAwareScheduler.onQuotaPressure` (reactive
semantics: an eligible same-framework account under the soft threshold, resume
via `--resume`, the existing deduped no-alternate attention item when nothing
has room). The scheduler's reactive selection is unchanged (I6).

### (a) A separate, settled usage-wall signal

`rateLimitDetection.ts` gains:

- `USAGE_WALL_PATTERNS`: strong banner phrasing only, ANCHORED to the banner
  shape (the phrase opens the line after indentation, an optional result glyph
  and an optional "API Error:"). A bare "resets 8am", or the words quoted
  mid-line by grep, a spec or a test, never count.
- `PANE_CHROME_PATTERNS` / `isPaneChromeLine`: the auto-continue notice, input
  box, box rules, permission-mode status line, shortcuts hint, the limit menu —
  each matching a COMPLETE chrome row (start and end anchored, with only the
  known trailing hints allowed), so prose or output that merely starts like a
  chrome row ("/upgrade completed successfully") stays session output.
- `detectUsageWall`: the banner is followed ONLY by chrome (zero session lines)
  and no retry spinner (checked on the raw lines, before chrome is dropped).
- `evaluateUsageWallSettle`: the same settled-output discipline as the throttle
  (banner current AND pane byte-identical for the settle window).

`SessionWatchdog.checkRateLimited` calls a new `checkUsageWall` on the same
capture and emits `'usage-wall'` (5-minute per-session emit cooldown). The
throttle decision is untouched: a wall still is not a throttle.

### (b) Untagged sessions are covered

`UsageWallRescue.resolveSessionAccount` resolves the account a session is on:
its tag; else an explicit `CLAUDE_CONFIG_DIR` matching a pool account; else the
account the default login holds NOW (`InUseAccountResolver`). The first two
establish the session's identity; the third is only a CANDIDATE, because the
default slot can be repointed after launch and whether a running Claude Code
process follows a repoint is not established. A proven identity (tag, explicit
home) is corroborated against its own reading before any move and is the only
kind of source that is ever attributed. A default-slot candidate is never
BLAMED, whatever its reading: nothing is recorded as walled, its reading cannot
veto the move and its reset time cannot hold the session. It is still EXCLUDED
as a target, because the session may well be on it: a "move" back onto the
walled account would count as a success, reset the breaker and loop. (If the
candidate is the only account with room, the session waits and the user hears
the standard notice — the cost of not knowing.) The
banner stands as the evidence; the cost of being wrong is one restart onto an
account with room. Spawn tagging removes this ambiguity for new sessions. Unresolvable → hold, never guess;
an explicit `CLAUDE_CONFIG_DIR` that matches no pool account is unresolved (it
says nothing about the default login).
Untagged Codex sessions are out of scope (`disabled`, not a failure).

New spawns are tagged: when the rescue is effective and `pinSessionsToPool` is
not explicitly false, the spawn-account resolver tags every claude-code spawn
with the usable account that has a FRESH reading (≤ 60 min, i.e. the poller
recently read it with a working login) under the soft threshold and the MOST
room. Accounts with no or stale reading are never picked; nothing qualifying →
the default login, untagged, as before. An explicit `pinSessionsToPool: true`
keeps its existing resolver (drain-first), unchanged.

### (c) Standby notice fixed, and the user is told the truth

`detectQuotaExhaustion` ignores chrome lines when deciding whether the session
moved past the banner (it keeps its one-stray-line tolerance, since it only
chooses words) and extracts a bare reset time ("8am").

A new optional `describeQuotaWall(sessionName)` hook chooses the wording from
the SAME admission the move uses (same account resolution, same target
exclusion — the resolved account, proven or candidate — same corroboration). If a check
already ran for THIS wall — an outcome of a wall-triggered check, ended by the
watchdog's `usage-wall-cleared` signal when the pane moves past the wall, and
in any case no older than two base intervals — it speaks from that outcome: "no room" → nothing more if the
conversation was told directly within 6 hours (a distinct "already told"
result that ends the standby's tier chain without a message), otherwise the
no-room words below; any other non-move outcome → the standard "paused until
the quota resets" notice. "Told" means a CONFIRMED delivery: a direct notice
that failed or could not be confirmed never silences the standby. Before
any check, it says "it is being moved to another account that has room…
nothing for you to do" only when the rescue is effective, the account resolves
by the same rules (cached default), no failed move exists, no breaker/hourly
cap applies, the same corroboration passes, and another account has room.

The rescue also tells the conversation directly (Telegram topic of the session,
plain words, no ids) in the two cases where it cannot move the session:

- no account has room (none under the soft threshold) → "no other connected
  account has enough room right now. It will carry on by itself when the limit
  resets." (at most once per 6 hours per session; a standby the user triggers
  meanwhile uses the same words);
- the per-session breaker opens after 5 failed moves → "moving it to another
  account did not work after several tries. It will carry on by itself when the
  limit resets. I will look into why the move failed."

After a successful move the resumed session itself answers; nothing extra is
sent. The operator-facing no-alternate attention item is rewritten in plain
words.

### (d) Spawn guard

With pinning explicitly off, the resolver still returns an account with room
when the default login is KNOWN walled (binding utilization ≥ 100 on a reading
that is fresh or whose walled window has not reset yet, or a corroborated wall
seen on it in the last 30 minutes). Unknown default → no
action. The default-login identity used here is cached and refreshed every 60
seconds (a stale positive can steer one spawn to another healthy account,
which is harmless).

### The single switch

`subscriptionPool.wallRescue.enabled`, default `true` in `ConfigDefaults`
(operator-approved 2026-11-04, see Frontloaded Decisions), read live. EFFECTIVE
only when the pool holds 2+ usable (`isLocallyExecutable`) accounts of the
session's framework. An explicit `autoSwapOnRateLimit: false` also turns it off
(Frontloaded Decision 5); `GET /subscription-pool/wall-rescue` names which
setting turned it off (`disabledBy`). An explicit `pinSessionsToPool: false`
limits spawn tagging to the walled-default guard. An explicit
`autoSwapOnRateLimit: true` keeps its legacy meaning (also move on a
server-throttle escalation), now through the same funnel and brakes, resolving
untagged sessions instead of skipping them.

Read live: `wallRescue.enabled`, `autoSwapOnRateLimit` (both values),
`pinSessionsToPool: false`. Restart-required: switching `pinSessionsToPool` to
`true` (it selects the legacy resolver at startup).

Observability: `GET /subscription-pool/wall-rescue` returns the switch,
`disabledBy`, whether it is effective, the usable-account count, the pinning
posture, the cached default account, moves in the last hour and the last 20
outcomes.

## Decision points touched

| Decision point | Classification | Rule |
|---|---|---|
| Is the pane at a usage wall? | invariant | Deterministic classification of the provider client's own banner plus a settle window; it only emits a signal. |
| Move a walled session? | invariant | Existing reactive swap authority, reached for walls only after deterministic corroboration: the account's fresh reading must not contradict the wall, and the walled window must not reset within 15 minutes (then waiting is cheaper than a restart). The competing signals named in review (the pane's own auto-continue, an in-progress turn) are resolved by these two rules: a settled wall pane has no turn in progress, and a near reset holds. Gated by the switch, 2+ usable accounts, in-flight dedupe, doubling back-off, a breaker on failed moves and a per-machine hourly cap. |
| Which account is the session on? | invariant | Tag > explicit config home > default-login resolver; unknown holds; corroborated before any move. |
| Tag a new spawn | invariant | Fresh reading under the threshold, most room, never unread; nothing qualifying → default login. Operator-approved scope (Frontloaded Decision 1). |
| Spawn-guard on walled default | invariant | Acts only on a positive walled reading; unknown never acts. |
| Standby wording and direct notices | invariant | "Being moved" only when a move would be admitted now; "no room" and "gave up" are sent only on those outcomes. |

## Signal versus authority

The watchdog emits a signal and holds no authority. Before the signal can lead
to a move it is checked against an independent source where one exists: a
proven account identity with a fresh reading that contradicts the wall holds
the move. When no such contradiction is available (stale or absent reading, or
an unproven default-slot candidate) the settled, anchored banner alone
authorizes the move, bounded by the brakes; that is deliberate, because a
missed wall is the incident this fixes and a false one costs one restart. The
authority to move is the existing swap engine reached through one funnel with
brakes, not a parallel mover. Both triggers that can
move a session (the wall, and the legacy throttle opt-in) use that funnel.

Q3 baseline: `ProactiveSwapMonitor` skips untagged sessions
(`ProactiveSwapMonitor.ts` lines with "Q3"). `proactive-default-account-swap.md`
once superseded Q3, but the later default-slot repoint change (#2246,
2026-10-20) reinstated it in code. This design does not change the proactive
monitor. Its consequence on that monitor is named in Frontloaded Decision 3.

## Multi-machine posture

Machine-local by design.

machine-local-justification: physical-credential-locality

Subscription logins, the default credential slot and tmux panes physically live
on one machine; a session is detected and moved only on the machine that runs
it. No new durable store, URL or replicated record. The status route reports
this machine only. Default-on lands per machine through that machine's own
config update and is effective per that machine's own pool size; in a
mixed-version pair, an older peer keeps its sessions untagged, which is safe.
The direct notices go to the session's own topic from the machine that runs the
session, so one session never gets two voices from two machines.

## Self-action convergence (brakes)

- `max-attempts`: per session, a breaker opens after 5 consecutive FAILED moves
  (the swap call itself refused or threw; an error while resolving or checking
  is a hold, never a failed move); it holds 24 hours from the last
  failed move, then is half-open (checks resume at the base interval; the next
  failed move re-arms the hold; a successful move resets it). "No room", "unresolved", "source not walled" and "resets soon" are real
  states, not malfunctions; they do not trip the breaker and retry at the base
  interval, so a session moves as soon as room appears.
- `backoff`: every check waits the 10-minute base interval; after a failed move
  the wait is measured from that failure and doubles per consecutive failed
  move, capped at 2 hours. Timing of failed moves is tracked apart from ordinary
  checks, so a hold outcome never extends a failure back-off. The gate is one
  pure function (`decideRescueGate`), registered in the self-action ratchet.
- `dedupe-key`: the tmux session name; at most one move in flight per session.
- per-machine cap: at most 12 move attempts per rolling hour (`rate-capped`), so
  a detector misfire on many panes cannot restart them all at once. The budget
  is reserved synchronously right before the swap call (after the async
  account resolution, so concurrent sessions cannot overshoot) and handed back
  when the swap found no room (nothing restarted). When the default login walls
  under many sessions, the excess waits for the next hour.
- The watchdog emits at most once per 5 minutes per session.
- Per-session state is pruned after 48 hours.
- Convergence: after a successful move the resumed session receives a
  "continue" prompt and produces output below any replayed banner, so
  `detectUsageWall` (zero session lines after the banner) stops matching. The
  scheduler's existing reactive anti-thrash observation records each move;
  SessionRefresh keeps its own restart rate cap.

## Verify the state, not its symbol

| Symbol | Claimed state | Corroboration | Unmeasurable |
|---|---|---|---|
| Anchored wall banner, nothing but chrome after it | The account this session runs on is out of quota now | (1) the pane is byte-identical for the settle window (the turn ended); (2) for a PROVEN identity (tag or explicit home), the account's own FRESH reading must not be under the soft threshold, or the move holds (`source-not-walled`) and a new quota reading is requested (coalesced machine-wide: one poll in flight, at most one a minute), so a reading taken before the wall is replaced before the next check (base interval); (3) for a proven identity, a fresh reading whose BLOCKING window resets in the future within 15 minutes holds (`resets-soon`); the blocking windows are the exhausted ones (≥ 100%), service resumes when the last of them resets, and only when none reads exhausted do the pressured (≥ soft) windows stand in; a reset time already past never holds | Stale/absent reading → the settled banner stands alone; no capture/no banner → no signal |
| Tag / config home / default-login resolver | Which account the session is on | Tag and explicit home are proven identity; the default-login answer is a candidate only (see (b)) | Unresolved → hold (`unresolved-account`) |
| Notice delivery result | The conversation was told | The send path's own confirmation (`resp.ok`) | Unconfirmed or failed → not "told"; the standby still speaks |
| Fresh reading under threshold | A spawn target's login works and has room | A successful poll within 60 minutes | No/stale reading → never a spawn target |
| Utilization ≥ 100 or corroborated wall seen < 30 min ago | Default login is walled (spawn guard) | Two independent sources (poller vs. pane) | Neither → guard does not act |

A false wall that survives these checks costs one `--resume` restart onto
another account, after which the session continues; a missed wall costs
today's behavior.

## Rollback

Set `subscriptionPool.wallRescue.enabled: false` (read live; no restart). Code
rollback is a revert; the config key left behind has no reader and is harmless.
Sessions already moved or tagged stay on their account, which is a valid state.

## Frontloaded Decisions

1. **Default on, including spawn tagging.** Operator decision: Justin, topic
   134156, 2026-11-04T17:49:46Z, "yes to switching it on by default", relayed
   with this scope: automatic account switching on by default for every agent
   whose pool has 2+ usable accounts, covering the move at a usage wall AND
   tagging/pinning so no session is untagged; not for agents with 0 or 1.
   Existing agents receive it through `applyDefaults` add-missing; an explicit
   `false` is kept.
2. **Throttle escalations do not move sessions by default.** A server throttle
   is shared capacity ("not your usage limit"); moving accounts does not help.
   Only an explicit `autoSwapOnRateLimit: true` keeps that legacy behavior.
3. **Proactive monitor population.** Tagged sessions are eligible to the
   pre-wall `ProactiveSwapMonitor` wherever an operator has enabled it (dark by
   default). Tagging new sessions therefore widens what an enabled proactive
   monitor can move. This is the documented purpose of pinning ("the
   prerequisite that makes auto-swap functional") and inside the approved scope
   ("no session is untagged"); untagged sessions keep Q3.
4. **Codex sessions** are covered only when tagged; there is no default-slot
   resolution for Codex.
5. **An explicit `autoSwapOnRateLimit: false` turns the rescue off.** That
   setting was an operator's "do not auto-move my sessions"; honoring it is
   the conservative reading. The status route names it in `disabledBy` so the
   reason is visible.
6. **The user is told only when the session cannot be moved**, in the session's
   own conversation, in plain words (texts above).

## Maturation plan

- **test-agent-live:** the unit, integration and end-to-end tests drive the real
  watchdog signal on the recorded 2026-11-04 pane, the real rescue over a real
  subscription pool and scheduler, spawn tagging through a real
  SessionManager, the status route over HTTP, and the update path
  (`applyDefaults` on an existing config, explicit `false` kept).
- **dev-agent-live:** live on the development agent from the release that
  carries it (Echo runs a multi-account pool). For one week, read
  `GET /subscription-pool/wall-rescue` `recent` outcomes and the server log's
  `[UsageWallRescue]` lines.
- **fleet:** the same release, default on (operator-approved 2026-11-04), and
  effective only where a machine's pool has 2+ usable accounts. Holding it back
  would keep the incident (sessions stuck for hours with room available).
- **graduation criterion:** over the dev-agent week, every `usage-wall` signal
  ends in `swapped`, `no-room` or a named hold, with zero sessions moved more
  than once per wall episode and zero `breaker-open`; at least one real or
  staged wall observed (zero signals means nothing was exercised, which is not
  a pass).
- **dark-window:** none. The feature replaces a silent multi-hour stall;
  shipping it dark would keep that stall. The off switch is an operator
  opt-out, not a maturation rung.
- **ladder:** not applicable: ships default-on (operator-approved 2026-11-04), the switch is an operator opt-out

## Open questions

*(none)*
