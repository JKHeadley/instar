# Upgrade Guide — v1.0.12 (portability hardening 4 of 6)

<!-- bump: patch -->

## What Changed

Fourth shipped of the six cross-framework portability hardening patches
(v1.0.9–v1.0.14).

Two safety features — pre-compaction context flush and resume validation —
could only locate Claude Code session transcripts, so they silently did
nothing for a Codex agent. A new shared resolver locates the transcript for
whichever runtime produced the session. The Codex transcript layout was
verified by inspecting a live Codex install on disk, not assumed.

It also fixes a pre-existing latent bug: the resume validator built the
Claude transcript path replacing only slashes in the project directory, while
the real Claude layout also replaces dots. For any project whose path
contains a dot, resume validation was looking in a directory that does not
exist and silently failing. Routing it through the shared, empirically-correct
resolver fixes that.

## Evidence

Reproduction prior to this change: run a Codex agent through a context
compaction. The pre-compaction flush looked for the transcript under Claude
Code's directory convention, found nothing, and produced no learning capture.
Separately, validate a resume for any agent whose project path contains a dot
(for example a path with `.instar`): the resume validator's slash-only path
encoding produced a non-existent directory and the JSONL sample came back
empty.

Observed after this change: the shared resolver returns
`~/.codex/sessions/YYYY/MM/DD/rollout-...-<id>.jsonl` for Codex (verified
against a live `~/.codex/`, Codex CLI 0.78.0) and the correctly-encoded
Claude path (dots and slashes both replaced, matching the real
`~/.claude/projects/` directory naming) for Claude Code. Claude installs whose
project path has no dot are byte-for-byte unchanged.

Unit verification: `tests/unit/FrameworkSessionStore.test.ts` — seven cases
including the dot-and-slash Claude encoding, the Codex date-tree glob with a
decoy file that must not match, and safe-empty returns when nothing is found.
Thirty-five existing pre-compaction-flush and resume-validator tests pass
unchanged.

## What to Tell Your User

- "Context-saving before compaction and resume validation now work for Codex agents, not just Claude Code. We also fixed a quiet bug where resume validation failed for any project whose folder path contained a dot. Claude Code agents without a dot in their path are unaffected."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Per-runtime transcript resolution | Automatic. The session-store resolver locates transcripts for Claude Code and Codex. |
| Correct Claude path encoding | Automatic. Resume validation now uses the real directory-naming convention (dots and slashes both replaced). |

## Deferred (Tracked Follow-ups)

- Threading the real per-session framework value through every flush/resume
  call site is incremental; callers that do not pass it get the Claude
  default (unchanged behavior).
- Two cross-framework gaps remain (v1.0.x): framework-aware connector-server
  registration, and the migrator/identity-renderer unification (an
  architecture decision being reviewed with the operator).
