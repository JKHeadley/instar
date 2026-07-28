# Side-effects review — Stage-A transcript capture (mentor cycle)

**Scope**: Close the last known mentor-cycle gap. The tick-driven path "ran but
delivered nothing" because the Stage-A prompt-generation session's output was
captured by (1) a recursive `~/.claude/projects` walk that exhausted its 10k
guard before reaching the file, and (2) a post-reap tmux read that raced the
session lifecycle. Make Stage-A capture deterministic and clean-prose.

**Files touched**:
- `src/monitoring/SessionReplyExtractor.ts` — new pure exported
  `findClaudeTranscriptShallow(projectsDir, claudeSessionId)`: scans the
  immediate children of `projects/` (+ root, defensively) for the exact
  `<id>.jsonl`. Replaces the inline recursive walk. Adds `fs`/`path` imports.
- `src/server/AgentServer.ts` —
  - `extractMenteeReplyFromTranscript` is now `async`; its Claude path polls
    up to ~240s for `claudeSessionId` (re-fetched from `state.getSession`) and
    the final assistant block, using `findClaudeTranscriptShallow`. Codex path
    unchanged (rollout-by-mtime, returns before the poll).
    Caller (mentee role-handler) now `await`s it.
  - `spawnStageA` keeps the last non-empty pane snapshot while the session is
    alive (fallback), then prefers the transcript via the same helper; falls
    back to the snapshot/pane only if no transcript is found. Adds two
    `[stage-a-diag]` log lines (low frequency — once per tick).
- `tests/unit/SessionReplyExtractor.test.ts` — 5 new cases for
  `findClaudeTranscriptShallow` (depth-1 hit, root hit, deep-subtree
  regression, no-descent guarantee, null-safety).
- `upgrades/NEXT.md` — release note (patch bump).

**Under-block (false negatives — does it ever now FAIL to capture a real reply?)**:
- The Claude path requires the exact `<claudeSessionId>.jsonl`. If a session
  never flushes `claudeSessionId` (e.g. killed before completion), the poll
  returns null after ~240s — but `spawnStageA` then falls back to the
  capture-while-alive pane snapshot, so a completed session still yields its
  text. Net: strictly more robust than before (which had only the post-reap
  read). The mentee role-handler retains its own tmux-capture fallback too.
- The 240s poll only runs on the Claude branch. A codex mentee (Codey) returns
  from the codex branch immediately — no added latency to the proven reply leg.

**Over-block (false positives — does it capture the WRONG thing?)**:
- Deliberately does NOT use newest-by-mtime for Claude: the agent runs many
  concurrent Claude sessions, so mtime would grab an unrelated transcript. The
  exact-id lookup is the correct disambiguator. This is the key reason the
  helper is not symmetric with the codex (mtime) path.
- `findClaudeTranscriptShallow` intentionally does NOT recurse: a transcript
  buried >1 level deep is not matched. Claude never writes there, so this is
  correct, not a gap (unit-tested: `does NOT descend into nested subdirs`).

**Level-of-abstraction fit**: The transcript-locating logic moved OUT of an
inline closure in `AgentServer` INTO the `SessionReplyExtractor` module, which
already owns transcript reading. `AgentServer` keeps only the I/O orchestration
(poll + fall back). The pure locator is now independently unit-testable — the
root-cause fix has a real regression test instead of being trapped in a private
method.

**Signal vs authority**: No authority change. Stage-A capture is signal-only
into the mentor tick; it gates nothing else. `isMenteeBusy` /
OutstandingPromptTracker (the actual tick safe-window) is untouched.

**Interactions**:
- `extractMenteeReplyFromTranscript` becoming async ripples to exactly one
  caller (the mentee role-handler), which now awaits it — verified by tsc.
- The mentee codex reply leg (the proven `FULL-…` round-trip path) is behavior-
  unchanged: same codex rollout extraction, no poll.
- Adds two `console.log('[stage-a-diag] …')` lines in `spawnStageA`. They fire
  once per mentor tick (low frequency) and carry only session id / framework /
  lengths — no transcript content (no Stage-A leak surface).

**Migration parity**: Pure code change in shipped `dist/` — no agent-installed
files (settings hooks, config defaults, CLAUDE.md template, hook scripts,
skills) touched. Existing agents pick it up via the normal auto-update of the
`instar` package. No `PostUpdateMigrator` entry required.

**Spec**: MENTOR-LIVE-READINESS-SPEC §Recipient side (Stage-A is the
prompt-generation step that feeds `deliverToMentee`). This fix is the third
instance of the same capture-race class (#480 fixed the mentee-reply and
isMenteeBusy instances); it completes the §Recipient-side capture story.
