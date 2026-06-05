# Spec — Quiet Update Mechanics

**Status:** shipped
**Parent principle:** Near-Silent Notifications (housekeeping → logs, not the user)
**Sibling:** `mature-update-announcements.md` (the *feature-announcement* layer; this is the *mechanics* layer)

## Problem

The Agent Updates topic was flooding with update **mechanics** — raw version
numbers and restart plumbing the user has no use for. Real messages observed in
a live Updates topic:

- `Just updated to v1.3.181. Restarting to pick up the changes.`
- `Update to v1.3.183 was applied but I'm still running v1.3.184. The next restart should pick it up.`
- `Update v1.3.215 queued — rolling into the pending restart at 02:21 (about 10m)…`
- `Update to v1.3.217 was applied but I'm still running v1.3.218. The next restart should pick it up.`

None of this is user-relevant. It is operational status that leaked into a
user-facing topic, and it reads as meaningless version churn — "notifications
that reference features the user has no clue about" (user feedback, 2026-06-04).

`mature-update-announcements` (PR #698) made the **feature-announcement** path
silent-by-default and maturity-honest, but it never touched the **mechanics**
path — these messages are not announcements, they are hardcoded restart/version
status emitted from `AutoUpdater` and the restart handshake. So the noise
remained.

## Policy (option A — full silence, the default)

The user hears about an update only when one of these is true:

1. **A genuinely new capability shipped** — governed by the `user_announcement`
   front-matter layer (`mature-update-announcements`), NOT by this module.
2. **A restart is actually interrupting their active work right now**
   (`interruption`) — a plain, **version-free** heads-up ("back in a few
   seconds"), never "v1.3.X".
3. **They must take an action** (`actionable`) — e.g. auto-apply is off and a
   manual update is available.
4. **An update is genuinely stuck after retries** (`failure-escalated`) — the
   restart isn't taking the new code after repeated attempts.

Everything else — version churn, restart-batch coordination, transient version
skew that self-heals on the next restart, a transient apply failure that retries
next cycle — is `mechanics` and goes to the **logs only**.

### Option B — background-refresh heartbeat (opt-in)

Some operators prefer a single quiet "I just refreshed in the background, I'm
current" note over total silence. Opt in with
`updates.backgroundRefreshHeartbeat: true` in `.instar/config.json` (default
`false` = option A). It surfaces ONLY the post-restart background-refresh
confirmation as a plain, version-free line; every other `mechanics` event stays
silent regardless, so the flag can never re-introduce the version-churn flood.

## Design — single classification at the funnel ("Structure > Willpower")

A pure policy module, `src/core/updateNotifyPolicy.ts`, exports
`decideUpdateNotify(kind, opts) → { reachUser, reason }` over four kinds:
`mechanics | interruption | actionable | failure-escalated`.

`AutoUpdater.notify(message, kind = 'mechanics', opts)` consults the policy at
the single notify funnel: a non-`reachUser` decision logs and returns; otherwise
it sends to the Updates topic exactly as before. The **default kind is
`mechanics`**, so any future, un-audited `notify()` callsite is silent by default
rather than accidentally spamming the user. The restart handshake's failure emit
in `src/commands/server.ts` applies the same policy (non-escalated mismatch →
silent; escalated → reaches the user, version-free).

### Callsite map

| Source | Old message (gist) | Kind | Reaches user? |
|---|---|---|---|
| `AutoUpdater` version-skew nudge | "vX downloaded, still running vY" | `mechanics` | no (silent) |
| `AutoUpdater` manual-update-available (auto-apply off) | "new version vX available, say update" | `actionable` | yes (version-free) |
| `AutoUpdater` transient apply failure | "tried vX, didn't work, retry next cycle" | `mechanics` | no (silent) |
| `AutoUpdater` max-deferral forced restart | "deferred… max wait reached, restarting now" | `interruption` | yes (version-free) |
| `AutoUpdater` restart narration (active sessions) | "Just updated to vX. Restarting…" | `interruption` | yes (version-free) |
| `AutoUpdater` idle restart | (was silent) | `mechanics` + bg-confirmation | only under option B |
| `AutoUpdater` deferral threshold warnings | "vX installed, restart in ~5m / ~30m" | `interruption` | yes (version-free) |
| `AutoUpdater` cascade-batch | "rolling into the pending restart at HH:MM" | `mechanics` | no (silent) |
| `server.ts` handshake mismatch (non-escalated) | "vX applied but still running vY" | `mechanics` | no (silent) |
| `server.ts` handshake mismatch (escalated) | "restart didn't pick up the new code" | `failure-escalated` | yes (version-free) |

Patch-only restart narration remains suppressed (Fork 3 of
`mature-update-announcements`); the handshake still runs for verification.

## Tests

- `tests/unit/update-notify-policy.test.ts` — pure policy, both sides of every
  branch (silent vs reach-user, heartbeat on/off, confirmation vs not, unknown
  kind → silent fail-safe).
- `tests/unit/update-notify-routing.test.ts` — wiring integrity: a real
  `AutoUpdater.notify()` of kind `mechanics` never calls `telegram.sendToTopic`,
  while `interruption`/`actionable`/`failure-escalated` do; option-B gating.
- Updated `notification-spam-prevention`, `auto-updater-failures`,
  `graceful-updates-phase2`, `update-notification-topic-lock` to assert the new
  contract (mechanics silent; interruption/actionable version-free).

## Migration parity

- **Code-only behavior change** — the silencing ships in `AutoUpdater` /
  `server.ts` / `updateNotifyPolicy`, so existing agents get it on npm update; no
  config migration is required (absence of `backgroundRefreshHeartbeat` = option
  A = the desired default).
- **Agent awareness** — a "Quiet update mechanics" block is added to the
  CLAUDE.md template (`generateClaudeMd`) and backfilled to existing agents via
  `PostUpdateMigrator.migrateClaudeMd()` under its own content-sniff guard
  (separate from the maturity-honesty marker, so agents that already have the
  maturity section still receive this one).
- **Type** — `UpdateConfig.backgroundRefreshHeartbeat?: boolean` and
  `AutoUpdaterConfig.backgroundRefreshHeartbeat?: boolean`, wired through the
  `server.ts` construction.
