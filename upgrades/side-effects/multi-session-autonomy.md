# Side-Effects Review — Multi-session autonomy (per-topic state)

**Version / slug:** `multi-session-autonomy`
**Date:** 2026-05-23
**Author:** echo
**Second-pass reviewer:** internal conformance pass (will add review-agent pass before final PR)

## Summary of the change

Lets instar run multiple autonomous jobs at once — one per topic — by replacing the
single `.instar/autonomous-state.local.md` with per-topic files
`.instar/autonomous/<topicId>.local.md`. The stop hook resolves its own topic (tmux
name → topic-session registry) and reads that topic's file; ownership becomes implicit
(my topic's file = my job). A legacy single-file job is still honored and migrated to
the per-topic path on first touch. `setup-autonomous.sh` writes the per-topic path.
The only `src/` file in this phase is `src/core/PostUpdateMigrator.ts` (the migration
that delivers the updated hook + setup script to existing agents). Phases 2–3 add the
concurrency cap, quota gate, stop-all/per-topic stop, and the list API.

## Decision-point inventory

- `autonomous-stop-hook.sh` — state-file selection + ownership + paused-check — **modify**:
  per-topic file preferred, legacy fallback + migrate; implicit ownership for per-topic
  files; honors `paused: true` (allow exit). (`.claude/`, not `src/`.)
- `setup-autonomous.sh` — write path + start gate — **modify**: per-topic write; refuses a
  new start when `GET /autonomous/can-start` denies (cap/quota), local cap backstop. (`.claude/`.)
- `src/core/AutonomousSessions.ts` — **add**: list/count/cap+quota/stop/pause control layer.
  `canStartAutonomousJob` is the only decision point (cap-then-quota, refuse-new) — it reads
  config + the live quota result (full context), not a brittle filter.
- `src/server/routes.ts` — **add** four `/autonomous/*` routes (list, can-start, stop-all,
  stop-topic) — thin wrappers over the module.
- `src/server/CapabilityIndex.ts` — **add** the `/autonomous` capability entry (discoverability
  lint requires every route prefix be claimed; this is agent-facing).
- `src/messaging/TelegramAdapter.ts` — **modify**: on a sentinel emergency-stop, also clear
  that topic's autonomous job so it can't zombie-resume on the next session.
- `src/core/types.ts` — **add** optional `autonomousSessions.maxConcurrent` (default 5 in code).
- `PostUpdateMigrator.migrateAutonomousStopHookTopicKeyed` — **modify** (Phase 1): multi-session
  marker; re-copies hook + setup. No new decision authority.
- `src/scaffold/templates.ts` (`generateClaudeMd`) — **add** the Multi-Session Autonomy
  capability block (Agent Awareness Standard — new agents).
- `PostUpdateMigrator.migrateClaudeMd` — **add** the awareness section for existing agents
  (content-sniff guarded); + shadow-capability marker so Codex/Gemini agents learn it too.
  No decision logic — documentation parity only.

## 1. Over-block (trapping a session that should exit)

- A session whose topic has no per-topic file → allow exit (tested: per-topic isolation +
  "no job → exit"). A foreign topic's hook never reads another topic's file (file selection
  is keyed on the session's own resolved topic).
- Legacy path retains the v1.2.55 foreign-topic-exits behavior.

## 2. Under-block (letting the real autonomous session exit)

- Each topic's job is enforced from its own file; a restart (new UUID, same topic) still
  blocks (tested). The legacy liveness backstop is unchanged. No new under-block path.

## 3. Level-of-abstraction fit

Correct. Per-topic files are the natural extension of the already-shipped topic-keying; the
hook already resolved its topic. The migration reuses the same install-if-missing →
dedicated-migration pattern (`migrateBuildSkillMethodology`).

## 4. Blocking authority

- [x] The hook remains a consumer of the topic registry + per-topic state. The one new
  authority is `canStartAutonomousJob` (the cap/quota start gate): it refuses NEW starts only,
  reading config (`maxConcurrent`) + the live `QuotaTracker` result — a full-context gate, not
  a brittle low-context filter. It never preempts a running job (that's the pause path).

## 5. Interactions

- **In-flight legacy job:** migrated to per-topic on first touch (same content, atomic mv);
  never disrupted. Tested.
- **Recovery note / liveness / duration / completion:** all operate on the selected file —
  carry over unchanged per topic.
- **Migration ordering:** `migrateAutonomousStopHookTopicKeyed` is content-sniff guarded and
  idempotent; order-independent vs other migrations.

## 6. External surfaces

- **Filesystem:** new directory `.instar/autonomous/` holding per-topic state files. The
  legacy file is moved (not copied) on migration. `autonomous-emergency-stop` flag written by
  stop-all. No reads outside the project dir.
- **HTTP:** four new authed routes under `/autonomous/*` (list / can-start / stop-all /
  stop-topic), registered in the capability index. Read + control over local state files only;
  no new external/credentialed calls.

## 7. Rollback cost

Low. Reverting restores the single-file behavior; the migration is content-sniff guarded
(a rollback re-ships the prior hook, which lacks the multi-session marker, so it re-deploys
cleanly). Per-topic files left on disk are harmless (the old hook reads only the legacy
path; an orphaned per-topic file is simply ignored).

## 8. Test evidence

- Unit (multi-session): two topics isolated; foreign-topic exits; restart survives per-topic;
  legacy fallback; legacy→per-topic migration; no-job→exit.
- Migration: v1.2.55→multi-session hook upgrade; setup-script upgrade; idempotent;
  customized-untouched; wiring guard.
- E2E: full restart-resume lifecycle on the per-topic file.
- Existing topic-keyed + session-validation + skill-deployment suites green (legacy path).
