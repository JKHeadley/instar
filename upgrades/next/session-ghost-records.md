# Upgrade Guide — Session ghost-record supersession (no more duplicate dashboard sessions)

<!-- bump: patch -->

## What Changed

Fixes the registry leak that made the dashboard show N "duplicate sessions" that were really one terminal plus N−1 stale bookkeeping records (2026-06-11 Mac Mini: 5 `running` records all pointing at the single tmux session `echo-resource-limitation-mitigation`, leaked one-per-respawn during the June crisis).

`StateManager.saveSession` — the single funnel every spawn/update callsite passes through — now enforces *one live record per tmux session name*: a record registering as `running`/`starting` supersedes any OTHER record still marked live for the same `tmuxSession` (closed as `completed` with `endedReason: 'superseded'` + new additive `Session.supersededBy` field naming the replacement). Ghosts close through `saveSession` itself, so the coherence journal records each transition. Best-effort + fail-open: hygiene can never block the live registration. Per-machine registries only — a tmux name legitimately reused on another machine collides with nothing. Existing on-disk ghosts self-heal on each name's next respawn.

## What to Tell Your User

- "The dashboard no longer shows duplicate copies of one session — each real terminal appears exactly once. Leftover duplicates from old restarts clean themselves up the next time that session restarts."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| One dashboard entry per real terminal | Automatic — no settings, no migration |
| Ghost forensics | A superseded record carries `supersededBy` (the replacing record's id) + `endedReason: 'superseded'` |

## Evidence

- 6 new unit tests (3 behavior — proven failing on the unfixed code first, including the exact 5-ghost Mac Mini shape — + 3 no-op guards: same-id re-saves, distinct names, terminal saves). One existing fixture updated (it unknowingly relied on two running records sharing one tmux name — the bug shape itself).
- StateManager test family (7 files, 96 tests) green; full unit suite green; `pnpm build` clean.
- Independent second-pass review (session-lifecycle adjacency) appended to the side-effects artifact.
