# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

Update-class messages now consistently land in the dedicated **Agent Updates** topic instead of leaking into random conversations. Three separate emitters were each picking a topic differently and two picked the wrong one:

1. The lifeline's HTTP-426 version-skew alert ("Heads up: my server auto-updated to vN but my lifeline is still on vM…") was being sent to whichever topic the user happened to be typing in when the forward came back. Now it resolves `agent-updates-topic` from server state and routes there, falling back to the Lifeline topic if Updates is unset — never the inbound topic.
2. The `ForegroundRestartWatcher` "Applying update to vN — restarting now" heads-up was routing through the central `notify()` helper without an explicit topic, which silently defaulted to the **Attention** topic. The caller now reads `agent-updates-topic` and passes it explicitly, falling through to the prior Attention default only when Updates is unconfigured.
3. Agent-authored ship/restart narration ("Quick heads-up: shipped X", "Back up and running on vN") had no template guidance steering it through the post-update channel — it landed in whatever topic the session was bound to. A new CLAUDE.md section + idempotent migration teaches every existing agent to route those self-broadcasts through `POST /telegram/post-update`.

## What to Tell Your User

- My update notifications, restart heads-ups, and post-restart "I'm back" messages will now show up in the Agent Updates topic where they belong, instead of leaking into whatever conversation you happened to be in when an update fired. If you don't see them in random topics any more — that's the fix working.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Lifeline version-skew alert resolves Updates topic | Automatic — no agent action required. The lifeline reads `agent-updates-topic` state on every 426 episode and routes the alert there; falls back to the Lifeline topic if Updates is unset. |
| `ForegroundRestartWatcher` "applying update" routes to Updates | Automatic — no agent action required. The pre-restart heads-up now consults `agent-updates-topic` and falls through to the prior Attention default only when unset. |
| Agent self-broadcast guidance (CLAUDE.md template + migration) | Existing agents pick up the new section via `PostUpdateMigrator.migrateClaudeMd()` on next update. New agents get it via `init`. Trigger: any conversational message whose subject is "I shipped / I updated / I restarted" → `curl -X POST .../telegram/post-update` instead of authoring in the active topic. |

## Evidence

- Bug report: Justin, 2026-05-27 (topic 14668), with screenshot of two update-narration messages landing in a Case Study topic instead of the Agent Updates topic.
- Diagnosis: three independent emitter paths each picking a topic differently — two wired wrong.
- Spec: `docs/specs/UPDATE-MESSAGE-TOPIC-ROUTING-SPEC.md` (Fix 1 lifeline / Fix 2 watcher / Fix 3 template + migration).
- ELI16 summary: `docs/specs/UPDATE-MESSAGE-TOPIC-ROUTING-ELI16.md`.
- Tests added (3 files, 20 new tests, all green):
  - `tests/unit/lifeline/version-skew-alert-routing.test.ts` — source-level assertions that `handleVersionSkew` resolves Updates via the new `resolveUpdatesAlertTopic()` helper, never the inbound topic; preserves 24h dedupe; drops cleanly when both Updates and Lifeline topics are unset.
  - `tests/unit/foreground-restart-watcher-notify-routing.test.ts` — source-level assertions that the `onRestartDetected` callback reads `agent-updates-topic` and passes it explicitly to `notify()`; uses `|| undefined` so the unset case falls through to the prior central-notify default.
  - `tests/unit/PostUpdateMigrator-updateTopicSelfBroadcast.test.ts` — full migration test: idempotency on second run, preserves existing CLAUDE.md content, graceful skip when CLAUDE.md is missing, parity with the source template.
- Smoke suite: 2941/2941 passed.
- Migration parity: the two code fixes ride the normal dist refresh on update; the CLAUDE.md template change has a dedicated migration in `PostUpdateMigrator` so existing agents pick it up, not just newly-initialized ones.

## Risk + Rollback

- Risk: **low**. Each fix is a pure routing change with a documented fallback. No contract change, no schema migration, no rolling restart needed beyond the standard post-update flow.
- Rollback: revert the PR. The lifeline 426 path returns to sending the alert to the inbound topic; the foreground watcher path returns to the central-notify Attention default; the CLAUDE.md section remains in already-migrated agents but does no harm (it's awareness, not enforcement).

## Follow-Ups (tracked, not in this PR)

- Structural enforcement of Fix 3 via a PreToolUse hook that detects agent-authored ship/update narration and redirects to `/telegram/post-update` — the Structure-over-Willpower version of the template guidance.
- Audit of remaining `notify('IMMEDIATE', 'system', …)` callsites in `commands/server.ts` for any other update-class messages that should route to Updates rather than Attention.
