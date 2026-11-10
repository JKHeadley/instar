# Side-effects review — PreCompact steering hook (pre-rendered keep-instructions into Claude's compaction prompt)

**Version / slug:** `cb-precompact-steer`
**Date:** 2026-11-09
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (see end)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.1 ("a dedicated PreCompact steering hook … reads pre-rendered keep-instructions from the staged packet directory and never composes them, left alone by the reporter and native-events migrations"), §9.5, §7.1, §4 ("still to verify in Phase 0: the exact hook output format that sets newCustomInstructions and that blocks"). Converged 6 rounds, approved by the operator 2026-11-09 17:22 PST (topic 141133). Phase 0, fifth slice; stacked on `cb-post-compact`.
**Tier:** 2 (fleet-wide hook + settings migration that changes what Claude Code's compaction is told). Size: 8 files, ~520 LOC incl. ~300 test LOC. Effort: one build pass, one L7 run with a negative control.

## Summary of the change

**Verified contract (Claude Code 2.1.321, read from the shipped binary, then proven live):** for each PreCompact hook that succeeded and did not block, its trimmed stdout is pushed, the outputs are joined with blank lines and passed to the compaction as `newCustomInstructions`; each output is cut at 10,000 characters (`DFe=1e4`). A blocking hook result (exit 2) blocks the compaction. In a subagent context only the block is honoured.

1. **Writer** `src/monitoring/keepInstructions.ts` — the single writer of the schema: stages text at `state/context-layers/_keep/<instarSessionId>.md` and a pointer `.json` (`schema`, `textPath`, `sha256`, `chars`, `source`, `writtenAt`). Text first, then pointer, both by atomic rename; dirs 0700, files 0600. Refuses an unsafe id or source, empty text, and text over 9,000 characters (Claude cuts each hook's output at 10,000, so it always arrives whole). Keyed on `INSTAR_SESSION_ID`, which survives compaction and `/clear`. Standing: not claimed on use; applies to every compaction until rewritten or removed.
2. **Hook** `.instar/hooks/instar/pre-compact-steer.sh` (`getPreCompactSteerHook` + `KEEP_INSTRUCTIONS_PY`): Claude Code only, needs `INSTAR_SESSION_ID`, reads state under `INSTAR_AGENT_HOME` for worktree sessions, requires `hook_event_name: "PreCompact"`, honours `contextBudget.compactionRecovery.enabled: false`, verifies schema, session, that the text path resolves inside the layer root, size, and sha256, then prints the text and nothing else. Every path exits 0; it never composes text and never blocks.
3. **Settings**: its own `PreCompact` entry (matcher `""`, timeout 5) separate from the event reporter's, through `settings-template.json`, `init` and `migrateSettings` (idempotent, sniffs `pre-compact-steer.sh`, keeps operator entries). Hook file through `installHooks` and always-overwrite `migrateHooks`.

**Nothing writes keep-instructions in production yet.** The producers are the standing packet (Phase 1) and the fold's stage step (Phase 0 task 7, FoldCoordinator); both call `writeKeepInstructions`. <!-- tracked: CMT-1536 (Phase 0 task 7 fold stage; Phase 1 standing packet) --> Until then the hook prints nothing on every fleet compaction: today's behaviour exactly.

## Decision-point inventory

- No decision point that blocks or filters is added. The hook adds text to a prompt; it holds no authority over whether compaction happens (it cannot block by construction: no non-zero exit path, asserted by a test).

## 1. Over-block

No issue identified. The hook cannot block a compaction. Worst case it adds up to 9,000 characters of instruction to the summary prompt.

## 2. Under-block

- Staged text is not re-scrubbed by the hook. It is produced by Instar's own renderers from the layer store, which §9.7 already scrubs; the hook prints only text whose hash the writer recorded, so it cannot be swapped underneath.
- If two machines host the same Instar session id (they do not: the id is per spawn), each reads its own machine's file.
- Claude Code may change the contract (stdout → `newCustomInstructions`). Then the text is silently ignored or shown as a hook message; the adapter verification suite (Phase 0 task 11) re-checks this contract per version. Fails toward today's behaviour.

## 3. Level-of-abstraction fit

Right layer: Claude Code exposes this lever only through a PreCompact command hook. The hook is a dumb printer; composing the text belongs to the renderers that own the layers (spec: "never composes them").

## 4. Signal vs authority compliance

No authority. The text steers a summary; it does not gate anything. Complies.

## 5. Interactions

- **Event reporter / native-events migrations** (`reconcileReporterHooks`, the reporter add/remove paths): they touch only reporter hooks. Integration test runs reconcile to native and back and the steering entry survives unchanged; the init/migrator reporter paths remove only `type: http` entries.
- **PreCompactionFlush / CompactionSentinel Trigger 1**: consume the reporter's PreCompact event; independent.
- **Operator PreCompact hooks**: kept; Claude Code joins all outputs.
- **Clear-seed / seeded markers / PostCompact records**: separate subdirectories of the same root (`_clear-seed`, `_seeded`, `<topic>/post-compact`); no shared files.
- **File Viewer**: `state/context-layers/` is already never-served (previous slice).
- **Session display**: Claude Code also shows each PreCompact hook's output in the session as `PreCompact [...] completed successfully: <text>` (`userDisplayMessage`). So staged keep-instructions (up to 9,000 characters) are visible in the pane and in any dashboard terminal stream of it. The text is derived from that same session's conversation, so this shows the session its own content; producers must not stage anything the session's viewers may not see.

## 6. External surfaces

New hook file and settings entry on every agent (Migration Parity: template + init + migrateSettings + migrateHooks). Changes the compaction prompt only when keep-instructions are staged, which nothing does in production yet. No route, no user message, no CLAUDE.md change.

## 7. Multi-machine posture

Machine-local by design: the hook reads the machine hosting the session; the writer runs on that same machine (the fold and the standing packet render where the session runs). Files are under git-ignored `.instar/state/`, never served.

## 8. Rollback cost

Low. Revert; or `contextBudget.compactionRecovery.enabled: false` silences the hook at once on that machine; or `removeKeepInstructions`. A leftover hook with no staged text prints nothing.

## Evidence

- **L7, real Claude Code 2.1.321, throwaway project, real `/compact` (haiku-5-5):** staged text "include this exact codeword on its own line: PERIWINKLE-4417"; the compaction's own summary (`isCompactSummary` entry) begins `Summary:\nPERIWINKLE-4417`, and Claude Code logged `PreCompact [bash ".../pre-compact-steer.sh"] completed successfully: In the summary, include…`. **Negative control**: same setup with the text file altered after staging (hash mismatch) → compaction ran (`compact_boundary` present), hook "completed successfully" with no output, 0 codeword hits in the transcript.
- `tests/unit/pre-compact-steer.test.ts` (10): writer layout/permissions/refusals/removal; hook prints exact text and keeps printing (standing); silent with nothing staged, on hash mismatch, for another session's pointer, for a forged pointer escaping the root, on another event, non-JSON, another engine, no session id, switch off; reads agent-home state for a worktree session; no non-zero exit in the script.
- `tests/integration/pre-compact-steer-settings.test.ts` (2): migrateSettings adds exactly one entry next to the reporter and an operator hook, idempotent; survives reporter reconcile to native and back (positive control: reconcile reports a rewrite).
- `tests/e2e/pre-compact-steer-lifecycle.test.ts` (2): update path installs the executable hook and entry; the installed settings command prints nothing before staging and exactly the production writer's text after.

## Second-pass review

**Reviewer (independent subagent, 2026-11-09):** "Concur with the review." Contract re-confirmed in the 2.1.321 binary (per-output cut, then `\n\n` join; block only sets `blockedBy`). Verified: every path exits 0, bounded stdin read, embedded python safe under the shell quoting, UTF-16 vs code-point counting can only under-count on the hook side, realpath confinement, writer/hook schema in step, migration parity and coexistence. Minor notes, all addressed in this commit: (1) staged text is also displayed in the session (`userDisplayMessage`) — now disclosed in section 5; (2) the 9,000 margin's stated reason was wrong (the cut is per output) — corrected in code comment and Summary; (3) unused `INSTAR_DIR` — kept, it mirrors the clear-seed hook and seeds `CB_STATE_ROOT`; (4) symlinked text inside `_keep` pointing outside — unit test added. The reviewer's own run used the default vitest config, which does not collect integration/e2e files; both pass under their configs (`vitest.integration.config.ts`, `vitest.e2e.config.ts`).

## Addendum (2026-11-10) — silent-fallback marker

`writeKeepInstructions`' catch returns a typed `{ written: false, reason: 'write-failed' }` to its caller and stages nothing (the hook then prints nothing: today's compaction). The no-silent-fallbacks lint counted it; it now carries a `@silent-fallback-ok` reason. No behaviour change.
