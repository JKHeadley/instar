# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Mentor cycle: Stage-A prompt capture no longer silently returns empty.**

The mentor tick's Stage-A step spawns a short haiku session to *generate* the
mentor prompt, then reads that session's output before delivering it to the
mentee. Two bugs made that capture silently return empty — so a tick "ran" but
delivered nothing (`delivered:false`, `stageAMsgLen:0`):

1. **Transcript lookup got lost in a huge directory tree.** The Claude path of
   `extractMenteeReplyFromTranscript` located the session transcript with a
   *recursive* walk of `~/.claude/projects` bounded by a 10,000-step guard. On
   a busy agent that folder holds far more than 10k nested directories, so the
   depth-first walk burned its whole budget inside an unrelated subtree and gave
   up *before reaching the right file* — even though the file sits exactly one
   level down. Replaced with `findClaudeTranscriptShallow`, which scans only the
   immediate children (the layout Claude actually uses:
   `<projects>/<encoded-cwd>/<sessionId>.jsonl`). Finds it in milliseconds.

2. **Capture raced the session lifecycle.** `spawnStageA` read the tmux pane
   *after* the session completed (the reaper had already torn it down → empty),
   and `claudeSessionId` is only flushed to the session record at completion —
   a beat after the session leaves the running list. Now Stage-A (a) keeps the
   last non-empty pane snapshot *while the session is alive* as a fallback, and
   (b) prefers the persisted transcript, polling for `claudeSessionId` to land
   and the final assistant block to be written (up to the session's own 5-min
   max). It uses the *exact* `<claudeSessionId>.jsonl` — never newest-by-mtime,
   since the agent runs many concurrent Claude sessions and mtime would grab an
   unrelated transcript.

## What to Tell Your User

The scheduled mentor tick now reliably generates and delivers its prompt — the
last gap that made the tick "fire but deliver nothing" is closed. No config
changes; behavior is automatic.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Robust Stage-A prompt capture | Automatic — the generated mentor prompt is read from the session transcript (exact `<claudeSessionId>.jsonl`, depth-1 scan) with a capture-while-alive pane fallback. |
| `findClaudeTranscriptShallow` | Pure, exported helper in `SessionReplyExtractor` — locates a Claude transcript by session id at its real depth-1 layout (no recursive walk). Unit-tested incl. a regression for the deep-subtree case. |

## Evidence

- Unit: `tests/unit/SessionReplyExtractor.test.ts` — 5 new cases for
  `findClaudeTranscriptShallow`, including a regression that builds a 50-deep
  unrelated subtree + 30 sibling encoded-cwd dirs and proves the depth-1 file is
  still found (the exact shape the old recursive walk failed on).
- Integration: `tests/integration/mentor-routes.test.ts` (the `/mentor/tick`
  route) green; full mentor/mentee suite (63 tests) green.
- Live: tick-driven round-trip verified — `/mentor/tick` → Stage-A generates
  the prompt → delivered to the mentee → a clean-prose reply persisted to
  `mentor-replies.jsonl` (evidence captured in the PR).
