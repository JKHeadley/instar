---
title: Topic-keyed autonomous-mode session identity
date: 2026-05-23
author: echo
review-convergence: internal-plus-second-pass-2026-05-23
approved: true
approved-by: Justin
approved-via: Telegram topic 12143 ("Yes, I approve of this with one caveat" 2026-05-23, caveat resolved via channel-neutral delivery seam + Channel Parity initiative topic 12270; "Yes, lets go for A" confirming scope)
eli16-overview: autonomous-topic-keyed-identity.eli16.md
---

# Topic-keyed autonomous-mode session identity

## Problem

Autonomous mode keeps a Claude Code session working until its job is done, enforced
structurally by `autonomous-stop-hook.sh` (Stop hook): while the job is active the
hook returns `{"decision":"block"}` and feeds the task back; it only allows exit on
duration expiry, emergency stop, or a matched completion promise.

Ownership of the job — "is THIS session the autonomous worker?" — was keyed on the
Claude **session UUID**, recorded in `.instar/autonomous-state.local.md` as
`session_id`. A long autonomous run hits the context/memory limit and is restarted;
each restart gets a **new** session UUID, but the state file still held the **old**
one. On the resulting mismatch the hook concluded "this is some other session" and
**failed open** — it allowed exit. From the first restart onward, every turn-end was
permitted, the session went idle, and autonomy was silently dead until the user
poked it. (Observed: a full session lost this way on 2026-05-23.)

A naive fix ("owner went quiet → take over") cannot distinguish a crashed session
from one legitimately deep in a long task — that is the identity-swap hazard that has
bitten this system before.

## Key insight

"Quiet for a while" ≠ "dead." The robust identity signal is not elapsed time and not
the volatile session UUID — it is the **topic** the session serves. instar already
binds each Telegram topic to a stable **tmux session name** (`.instar/topic-session-registry.json`,
`topicToSession`), and `SessionRecovery.respawnSession(topicId, sessionName, …)`
**reuses that same tmux name** when it restarts a session. The tmux name is therefore
a stable "street address" that survives restarts, while the session UUID is a
"worker's badge" that rotates. Key on the address, not the badge.

## Design

The stop hook resolves ownership in this order:

### 1. Topic-keyed ownership (primary)

- Resolve the hook's own tmux session name: `tmux display-message -p '#S'`
  (overridable for tests via `INSTAR_HOOK_TMUX_SESSION`; `INSTAR_HOOK_NO_TMUX=1`
  forces "no tmux").
- Read `report_topic` from the state file (already persisted with the job).
- Reverse-look-up the registry: `OWNER_TMUX = topicToSession[report_topic]`.
- If `MY_TMUX == OWNER_TMUX` → **this is the autonomous session** → block.
  This holds across restarts: the new UUID is irrelevant, the address matches.
- If `OWNER_TMUX` is non-empty but `!= MY_TMUX` → the topic is served by a different
  session → **allow exit** (never trap a foreign session).

### 2. Liveness-gated backstop (rare)

Reached only when topic resolution is unavailable (no tmux, or `report_topic` not in
the registry — e.g. older runs, or a registry reconfigured mid-run):

- Recorded `session_id` empty/invalid → self-bootstrap (first fire claims the job).
- Recorded `session_id` == hook session → block (session match).
- Recorded `session_id` != hook session → gate on the **recorded owner's liveness**:
  derive its transcript path (`dirname(hook transcript)/<recorded_uuid>.jsonl`) and
  compare mtime against `INSTAR_AUTONOMOUS_LIVENESS_SECS` (default 120s).
  - Owner alive (fresh transcript) → a genuinely different live session → allow exit
    (no steal).
  - Owner dead/unknown → adopt the job → block (and treat as a restart-resume).

This is the demoted role of the liveness idea from the original brief: a thin edge
guard, not the main mechanism. With topic resolution available (the normal case for
instar-spawned autonomous sessions, which always run in tmux), the backstop is never
consulted and collisions are structurally impossible (the registry maps one topic to
exactly one tmux name).

### 3. One-line recovery note

On a genuine restart-and-resume (topic-verified ownership OR dead-owner adoption,
AND the recorded UUID differs from the live one), the hook:

- appends one audit record to `.instar/autonomous-recovery.jsonl`
  (`{ts, event:"restart-resume", topic, oldSession, newSession, method, iteration}`),
- best-effort delivers a single user-facing line via `telegram-reply.sh` to
  `report_topic`: *"Heads up — my session restarted mid-run and I've picked the
  autonomous job back up (topic N, iteration M). No action needed."*,
- reconciles the recorded `session_id` to the live one, so the note fires **exactly
  once** per restart (subsequent fires see a match and stay silent).

Delivery is structural (the hook sends; it does not rely on the agent remembering to).
The audit record is the durable source of truth; live delivery is best-effort.

### Channel-neutral delivery (no Telegram assumption)

The recovery note routes to **whatever channel owns the job**, not Telegram by
default. The autonomous state records `report_channel` (set by
`setup-autonomous.sh`, default `telegram` for back-compat with older state files),
and the hook dispatches through a `deliver_recovery_note` seam keyed on it:

- `telegram` → wired now via `telegram-reply.sh`.
- `slack | whatsapp | imessage | future` → owned by the unified notification layer
  tracked in the **Channel Parity initiative** (Telegram topic 12270). Until that
  lands, the channel-neutral audit record carries the event and the hook logs that
  live delivery is pending — it never silently misfires to Telegram.

The audit record includes the `channel`, so it is channel-neutral end to end. This
is the "seam now, unification later" split agreed with the user (2026-05-23): the
design no longer bakes in Telegram; wiring the remaining channels is the Channel
Parity initiative's scope, not this hook's.

## Collateral fixes (same hook, same change)

- **Timezone bug:** `date -j -f "%Y-%m-%dT%H:%M:%SZ"` parsed UTC timestamps as
  **local** time, skewing duration and report-interval math by the local offset.
  Added `-u` to the three BSD date-parse callsites (GNU `date -d` already handles Z).
- **Pipefail fragility:** under `set -uo pipefail`, a `grep` for an **absent** optional
  frontmatter key (`last_report_at`) made the pipeline exit non-zero and aborted the
  whole hook. Frontmatter reads now go through a `fm_get` helper that never trips
  pipefail.
- **Fail-safe expiry:** if `started_at` is unparseable, `date` falls back to epoch 0,
  which would inflate elapsed time and prematurely expire the run. The duration-expiry
  check now only fires when `started_at` parsed to a positive epoch; otherwise it logs
  and keeps running (fail toward continuing, never toward a premature exit).

## Migration (parity)

`installAutonomousSkill()` is install-if-missing, so existing agents never receive
hook updates via `init`. Per the Migration Parity Standard, `PostUpdateMigrator`
gains an idempotent `migrateAutonomousStopHookTopicKeyed()`:

- content-sniff on the `topic-session-registry` marker (skip if already topic-keyed),
- stock-fingerprint guard on `Autonomous Mode Stop Hook` (leave customized hooks
  untouched),
- re-copy the bundled hook + `chmod 755`,
- wired into `run()`. Mirrors `migrateBuildSkillMethodology`.

## Signal-vs-authority

The hook is a **consumer** of an existing detector (the topic-session registry +
transcript liveness), not a new brittle check with blocking authority. Its blocking
authority is exactly the pre-existing autonomous-mode authority — unchanged in scope,
only made restart-correct. No new gate is introduced.

## Test strategy (all three tiers)

- **Unit (Tier 1):** `tests/unit/autonomous-stop-hook-topic-keyed.test.ts` executes the
  real hook across every path — restart-survives (the regression), foreign-topic-exits,
  liveness backstop both sides, recovery-note-once + dedup, preserved terminal exits,
  and the fail-safe/robustness cases. Plus the updated source-analysis tests.
- **Integration (Tier 2):** `tests/unit/PostUpdateMigrator-autonomousStopHook.test.ts`
  drives the real migrator + bundled file + filesystem: upgrades an old session-keyed
  hook, idempotent on repeat, leaves customized hooks untouched, no-op when absent, and
  asserts the migration is wired into `run()` (anti-dead-code). (No HTTP surface exists
  for this feature, so the migrator integration test stands in for the HTTP tier.)
- **E2E (Tier 3):** `tests/e2e/autonomous-restart-resume-lifecycle.test.ts` runs the real
  hook through a production-shaped sequence with persisting state — bootstrap → restart
  with rotated UUID → exactly one recovery note → dedup → completion — proving autonomy
  survives a restart end to end.

The bug was reproduced first (RED): the restart-survives assertion fails on the old
session-keyed hook before the fix and passes after.

## Acceptance criteria

1. A restarted session (new UUID, same topic) blocks exit; autonomy survives.
2. A foreign-topic session is never trapped.
3. Exactly one recovery note per restart, durably audited, best-effort delivered.
4. Duration / emergency-stop / completion-promise / progress-report paths unchanged.
5. Existing agents receive the fix via the idempotent migration.
6. All three test tiers green; full suite green at push.
