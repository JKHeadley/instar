---
review-convergence: "internal-adversarial-1"
approved: true
approved-by: justin
approved-at: 2026-05-24
approval-context: "Justin's 2026-05-24 Telegram message: 'yes, please follow through with this, but also note that the API rate limit scenario is still not recovering even though we claimed to deploy a fix' — confirmed scope approval for the three-part plan including the additional production-bug fix"
slug: sentinel-reachability
companion-eli16: SENTINEL-REACHABILITY-SPEC.eli16.md
date: 2026-05-24
author: echo
note: "Closes a class of bugs where recovery sentinels detect failure correctly but their resume/notify outputs are silently no-op'd for sessions without a Telegram topic binding. Ships alongside worktree-isolation hardening because both surfaced from the same May 22 incident and share the recovery-reachability discipline."
---

# Sentinel Reachability + Worktree Isolation

## Problem

Two recovery features that were shipped with green tests and claimed-fixed turned out to be silently non-functional for an entire class of sessions in production:

### Bug 1 — RateLimitSentinel never recovers a non-topic-bound session

Reproduced 2026-05-24 from Justin's interactive Claude Code window for the echo agent at `/Users/justin/.instar/agents/echo`:

1. Anthropic's shared-capacity throttle fires (`Server is temporarily limiting requests · Rate limited`).
2. `SessionManager` correctly classifies the session as idle.
3. `detectRateLimited()` correctly matches the throttle pattern.
4. `SessionManager` emits `rateLimitedAtIdle` → `RateLimitSentinel.report()` schedules backoff.
5. After backoff, the sentinel calls `resumeFn(sessionName)`. That function (defined in `src/commands/server.ts:5198-5205`) does:

   ```js
   const topicId = telegram?.getTopicForSession(sessionName);
   if (topicId == null) return false;   // ← silent no-op
   ```

6. Similarly, `notifyFn(sessionName, text)` (`server.ts:5207-5215`):

   ```js
   const topicId = telegram?.getTopicForSession(sessionName);
   if (topicId == null) return;          // ← silent no-op
   ```

The user's interactive session is not bound to any Telegram topic (it's a developer's local Claude Code window, not a Telegram-routed agent session). So the sentinel detects correctly, schedules correctly, attempts correctly — and every output drops on the floor.

From outside, this is **indistinguishable from the sentinel never having existed.** Which is exactly what Justin observed: 7+ minutes idle with the throttle visible, no recovery, no notification, no record in any user-facing channel.

### Bug 2 — SocketDisconnectSentinel + ActiveWorkSilenceSentinel only log by default

`server.ts:5316,5333` wire these two sentinels via `SentinelNotifier`. The notifier accepts a `telegramEscalation` flag (`server.ts:5310`), which defaults to **false** via `config.monitoring?.sentinelTelegramEscalation === true`. With the flag off, every detection event is recorded to logs only — no user-facing message goes out.

The May 22 gsd worktree incident sat silent for 1h 16m almost certainly because the silence sentinel emitted a detection but escalation was off. The default-off was chosen out of caution to avoid topic spam during the rollout; the consequence is that the feature **doesn't function** for any operator who hasn't manually flipped the flag.

### Bug 3 — Worktree convention is structurally incomplete

`WorktreeManager.createWorktree` (`src/core/WorktreeManager.ts:769`) uses plain `git worktree add`. That always creates a `.git` text file in the worktree that points back to the *parent* repo's `.git/worktrees/<name>/` metadata directory. So even though the worktree's files live in sandbox-safe `~/.instar/agents/<self>/.worktrees/`, every git operation reaches back into the parent path.

Confirmed on disk 2026-05-22: the `topic-intent-layer` worktree's `.git` file reads `gitdir: /Users/justin/Documents/Projects/instar/.git/worktrees/topic-intent-layer`. When macOS sandbox revokes access to that parent path mid-session (the exact failure mode the convention was meant to prevent), every git command in the worktree fails with `Operation not permitted`.

## Root cause (shared discipline)

All three bugs share the same shape: a recovery feature was implemented + tested, but its **delivery channel was conditional on a precondition that the failing case violates.** Tests covered the path where the precondition held; the production failure happens when it doesn't.

- RateLimitSentinel: tested with topic-bound sessions; fails for non-topic-bound.
- Socket/Silence sentinels: tested with `telegramEscalation: true`; fails with default-false.
- Worktrees: tested with parent path accessible; fails when sandbox revokes parent.

The discipline we missed: **recovery features must have a reachable output channel under all production conditions, not just the test fixture configuration.** This spec hardens that.

## Design

### Part A — Sentinel-output reachability

**A1. Lifeline-topic fallback for `notifyFn`.**

For every sentinel that currently no-ops when `getTopicForSession` returns null, fall back to the agent's lifeline topic (the existing single system topic, retrieved via `telegram.getLifelineTopicId()`). If neither is available, fall back to logging an audit event with a `recovery-unreachable` marker — which the operator can grep for later, instead of silent.

Affected sentinels:

- `RateLimitSentinel` — `server.ts:5207`
- `SocketDisconnectSentinel` — via `buildSocketDisconnectDeps`
- `ActiveWorkSilenceSentinel` — via `buildActiveWorkSilenceDeps`

**A2. Non-topic-prefixed resume injection for `resumeFn`.**

The current `resumeFn` prefixes its nudge with `[telegram:N]` so InputGuard accepts it. For non-topic-bound sessions, use a sibling injection path that bypasses the topic prefix requirement.

Concretely: extend `SessionManager.injectMessage` (or add `injectInternalMessage`) with an internal flag that bypasses the InputGuard topic-prefix check but logs the injection with `source: 'sentinel-recovery'` for audit. The flag is gated to internal callers only — not exposed to general API consumers.

**A3. Default `sentinelTelegramEscalation` to true (consolidated).**

Flip the default to `true`. To prevent the volume regression the default-off was protecting against, route all sentinel escalations through one consolidated message per minute window per topic, mediated by `SentinelNotifier`'s existing coalesce logic (verify it works; add coalescing if missing).

`PostUpdateMigrator` entry: when migrating an existing config that has `sentinelTelegramEscalation` unset (not explicitly false), set it to `true`. Configs with an explicit `false` are left alone (operator opt-out preserved).

**A4. Recovery-reachability audit trail.**

Every sentinel emits a `recovery-reached` or `recovery-unreachable` audit event each time it attempts delivery. The `recovery-unreachable` event includes `{ sessionName, sentinel, fallbackTried: [...] }`. Available at `/sentinels/audit?since=` via the existing audit-log route.

### Part B — Worktree clone isolation

**B1. `WorktreeManager.createWorktree` uses `git clone` into agent home.**

Replace `git worktree add` with `git clone --local --branch <branch> <parent-path> <agent-home-path>`. The clone gets its own real `.git/` directory entirely inside the agent home — no pointer back to the parent. Push/pull continues to work because clone sets `origin` to the parent path.

For branch-creation-then-clone: if the requested branch doesn't exist in the parent, create it there first (`git -C <parent> branch <branch>`), then clone.

**B2. Migration path for existing worktrees.**

`PostUpdateMigrator` adds `migrateWorktreesToCloneIsolation()`:

1. Scan `~/.instar/agents/<self>/.worktrees/` for entries with a `.git` *file* pointing into a path outside the agent home.
2. For each: if the worktree has no uncommitted changes, replace it with a fresh clone of the same branch. If it has uncommitted changes, leave it in place, log a `worktree-needs-migration` audit event, and surface a Telegram message to the lifeline topic.
3. Idempotent: skip worktrees that already have a real `.git/` directory.

**B3. `instar worktree health` command.**

New CLI subcommand that inspects every entry in `.worktrees/` and reports:

- `OK` — has real `.git/` directory, parent reachable
- `BROKEN-POINTER` — `.git` file pointing into inaccessible parent (suggest migration)
- `DIRTY-MIGRATION-PENDING` — has uncommitted changes preventing auto-migration

Exposed at `GET /worktree/health` too, so the dashboard can surface it.

**B4. SessionStart hook surface.**

When an agent starts up in a worktree that has a `BROKEN-POINTER` status, the session-start hook emits a one-line warning to the lifeline topic so the operator knows immediately. Suppressed if the worktree is `OK`.

## Verification (the test that would have caught these)

The previous Tier-3 test for RateLimitSentinel passed because it asserted on internal events emitted by the sentinel — not on user-reachable delivery.

### Tier-3 reachability tests (new)

**T1. Non-topic-bound rate-limit recovery delivers to lifeline.**

Spawn a tmux session that is NOT bound to any Telegram topic. Plant the exact rate-limit string in its pane. Start the full server stack including all three sentinels. Wait for the sentinel cycle. Assert that:

- A message arrived in the lifeline topic's outbound queue (mock Telegram sink) containing the rate-limit notice.
- An audit event `recovery-reached` was recorded with `sentinel: 'rate-limit'`.
- After verify window passes (and we simulate jsonl growth), `recovered` event fires.

**T2. Socket-disconnect default-on delivery.**

Same shape with the socket-disconnect string. Start the server with **default** config (no explicit `sentinelTelegramEscalation`). Assert delivery to lifeline.

**T3. Active-silence default-on delivery.**

Same shape: simulate a session that has gone silent past the threshold, with default config. Assert delivery.

**T4. Worktree survives parent revocation.**

Create a worktree via the new clone path. `chmod 000` the parent repo's `.git/` directory. Run `git status` in the worktree — must succeed (because the worktree has its own `.git/`). Restore parent permissions. (This test only runs on POSIX-permissioned filesystems; skipped on Windows CI.)

**T5. Wiring integrity.**

For each sentinel: assert that `notifyFn` and `resumeFn` are non-null and not the default null-ops at server start. Specifically, instantiate the server with default config, fish out the live sentinel instances from the server registry, and call their delivery paths with a known sessionName — assert the call doesn't return a no-op sentinel value.

## Migration parity

Per Migration Parity Standard:

- Config defaults — `PostUpdateMigrator.migrateConfig()` entry for `sentinelTelegramEscalation` default-on (A3).
- Existing worktrees — `migrateWorktreesToCloneIsolation()` (B2).
- CLAUDE.md template — add a "Recovery sentinels reach the lifeline topic; turn off via `sentinelTelegramEscalation: false`" section so agents know what they'll see.
- Hook scripts — session-start lifeline warning is in the always-overwrite `instar/` directory.

## Rollback

Each part is independent and reversible:

- A1/A2 — revert to the silent no-op (reintroduces the bug; trivial git revert).
- A3 — operators can set `sentinelTelegramEscalation: false` to restore prior behavior; the migrator's explicit-false check guarantees this stays sticky.
- B1 — revert to `git worktree add` (reintroduces the sandbox issue; trivial git revert).
- B2 — migrator is idempotent + read-only on dirty worktrees, safe to disable.

## Out of scope

- Redesigning `SentinelNotifier`'s coalescing window beyond verifying it works.
- Changing the rate-limit detection patterns themselves.
- Migrating gsd-spawned sessions to be topic-bound by default (separate scope).

## Adversarial review log (internal-1, 2026-05-24)

**R1 — `git clone --local` uses hardlinks by default; if parent `.git` is later deleted, hardlinks dangle.**
Resolution: use `git clone --local --no-hardlinks <parent> <agent-home-path>`. This costs disk + a few seconds at clone time and gives a true independent copy of object files. Branch creation pre-clone unchanged. Acceptance test (T6 added below): delete parent `.git/objects/pack/` after clone; verify `git log --oneline` in the worktree still resolves.

**R2 — Default-on flip surprises existing operators with a sudden burst of sentinel messages.**
Resolution: PostUpdateMigrator emits a single first-time heads-up to the lifeline topic ("Sentinel escalations are now ON by default; turn off via `sentinelTelegramEscalation: false` in `.instar/config.json`") on the FIRST upgrade past the flip version. Tracked via a one-shot migration marker so the heads-up doesn't repeat.

**R3 — InputGuard bypass for non-topic-prefixed injection is a security boundary.**
Resolution: `injectInternalMessage` is a method on `SessionManager` only — NOT exposed as an HTTP route. Internal callers (the three sentinels) pass an `internal: true` flag along with `source: 'sentinel-recovery'` for the audit log. HTTP-route callers continue to require topic prefixing via the existing `injectMessage`. Verified by integration test T7 (added): an HTTP POST that omits the topic prefix is still rejected.

**R4 — Auto-migrating clean worktrees could nuke branches that exist only in the worktree (not pushed to origin).**
Resolution: before re-cloning a clean worktree, verify the branch is reachable in either `origin` or the parent repo's local branches. If neither, treat the worktree as if it were dirty (skip migration, emit lifeline notice). Branches still in the parent are safe because the clone's `origin` will include them.

**R5 — Coalescing window may still be too noisy under a real outage.**
Resolution: the coalescing layer in `SentinelNotifier` keeps its existing per-minute window for incident-level events; additionally, per-sentinel-per-session cooldowns (defaulting to 5 min between repeat notifications about the same session) are applied above the coalescing. Verified by a unit test that fires 20 detections for the same session in a minute and asserts ≤2 messages are emitted.

**R6 — `getLifelineTopicId()` returns null during initial setup before any topic exists.**
Resolution: the audit-only fallback already covers this; additionally, an in-process `recovery-unreachable` event is written to `.instar/sentinel-alerts.json` (append-only log) which the dashboard surfaces in the Sentinels tab. Operators see the alert even without Telegram. The dashboard's existing alert-banner logic gets one new entry.

**R7 — Migration runs in parallel with running sessions; could disrupt active gsd worktrees.**
Resolution: migration acquires a per-worktree lock (via the existing `.session.lock` mechanism in `WorktreeManager`) and SKIPS any worktree with a live lock. The worktree is migrated only when no session holds it.

**R8 — `--no-hardlinks` clone of a multi-GB instar repo costs ~3-5s + disk.**
Acceptable. The clone happens once per worktree creation; not in a hot path.

### Added tests

- **T6 (parent-deletion survival):** after creating a worktree via the new path, delete the parent repo's `.git/objects/pack/` directory. Assert `git log --oneline` in the worktree still resolves.
- **T7 (InputGuard boundary):** HTTP POST to `/sessions/:name/inject` without topic prefix → 400. The new internal injection path is NOT reachable over HTTP.
- **T8 (coalesce + per-session cooldown):** fire 20 socket-disconnect events for the same session in 60s; assert ≤2 outbound messages.
