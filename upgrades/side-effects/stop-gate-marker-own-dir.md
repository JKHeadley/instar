# Side effects: the stop-gate's one-time reminder note moves into the agent's own folder (SEC-131)

In plain words: the stop-gate router's one-shot green-PR block remembers that it fired with a marker file. That marker now lives in the agent's own state folder and is created exclusively, never in the shared temp folder and never through a link.

Tier 1. Size: 1 source file (the hook text inside `PostUpdateMigrator.getStopGateRouterHook`), 1 new unit test file.

## What changes for running agents
- Marker path: `<CLAUDE_PROJECT_DIR>/.instar/state/stop-gate-markers/greenpr-block-<session>-<pr>` (session and PR URL-encoded), instead of `<os.tmpdir()>/instar-greenpr-block-<session>-<pr>`.
- The folder is created with mode 0700 and the marker with `open(..., 'wx', 0o600)`. An existing file or link at that name means "already fired"; nothing is written through it.
- Fail direction: if the folder or marker cannot be created for any reason, the hook skips the green-PR block. Before, a failed write still blocked, and blocked again on every stop. That could trap the agent, which this block is meant never to do.
- The first stop of a session with a green PR blocks exactly as before, with the same message. Markers left in the temp folder by older versions are ignored; the reminder can fire once more per open session and PR after the update.
- Reaches existing agents: `stop-gate-router.js` is rewritten on every update by `PostUpdateMigrator`.

## Signal vs authority
A one-shot reminder; it grants nothing. The change only moves and hardens where its "already shown" note is kept.

## Rollback
Revert the commit; the next update rewrites the hook. Stray markers under `.instar/state/stop-gate-markers/` are tiny and harmless. One empty marker per session and green PR accumulates there (as it did in the temp folder); that folder is gitignored, so markers never sync.

## Tests
- `tests/unit/stop-gate-greenpr-marker.test.ts` (new) renders the real hook and runs it as a subprocess against a local server that answers the hot-path read with a green PR.
  - Case 1 (fails on main): the first stop blocks; the marker is under `.instar/state/stop-gate-markers` with mode 0600; nothing appears in the temp folder; the second stop goes through.
  - Cases 2 and 3 guard the new behaviour: a link pre-planted at the marker name is not written through and counts as fired, and a dangling link is not followed to create its target.
- Also pass: `stop-gate-false-excuse-deferral`, `generated-hooks-parse`, `no-bare-require-in-generated-hooks`.

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, given only the diff and the problem statement), 2026-11-21. Verdict: concur, no blocking findings. It rendered the hook and confirmed the new block has no template interpolation and that `fs`, `path`, `projectDir` and `sessionId` are in scope. It also confirmed that `'wx'` refuses any link at the final name, dangling ones included, with no check-then-create gap, and that the encoded name cannot become a path step. Skipping the block on failure is the right direction. Nothing else uses the old temp path. `stop-gate-router.js` is rewritten on every update and is the same file Codex uses. Non-blocking notes, all handled: the stale "tmp marker" comment (fixed), a dangling-link test (added), and marker accumulation (recorded under Rollback).
