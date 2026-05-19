---
title: "FrameworkSessionStore — per-runtime transcript path resolution (portability Gap 3)"
slug: "portability-session-store"
author: "echo"
status: "converged"
type: "dev-infrastructure-spec"
eli16-overview: "portability-session-store.eli16.md"
review-convergence: "2026-05-19T21:00:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T21:00:00Z"
review-report: "docs/specs/reports/portability-session-store-convergence.md"
approved: true
approved-by: "Justin (pre-authorized 2026-05-19, autonomous-mode; explicitly directed empirical discovery via the live ~/.codex/ rather than treating Codex specs as unknown)"
approved-date: "2026-05-19"
approval-note: "Gap 3 of six. Codex layout EMPIRICALLY verified from live ~/.codex/ (not guessed) per Justin's direction. Ships v1.0.12."
lessons-engaged:
  - "P1 (Structure>Willpower): a real resolver module both consumers call, not a doc."
  - "P4 (Testing Integrity): 7-case FrameworkSessionStore test + 35 PreCompactionFlush/ResumeValidator regression tests green."
  - "P10 (Comprehensive-First): module + both consumers (PreCompactionFlush, ResumeValidator) wired in this PR."
  - "Trust-Verify-Improve: Codex format verified against the live ~/.codex/ on disk; ResumeValidator's pre-existing slashes-only encoding bug found and corrected against the real ~/.claude/projects/ naming — documented, not silent."
  - "L1-equivalent (audit-driven, empirically grounded): closes verified Gap 3 with real Codex paths, no fabrication."
  - "L6/L9/L10: siblings."
---

# FrameworkSessionStore — per-runtime transcript path resolution (Gap 3)

## Problem

`PreCompactionFlush` and `ResumeValidator` hardcoded Claude Code's transcript
convention. A Codex session is never found there, so pre-compaction flush and
resume validation silently no-op for Codex agents.

## Empirical grounding (not guessed)

Per Justin's direction, the Codex layout was inspected from a live `~/.codex/`
(Codex CLI 0.78.0), not assumed:

- Codex transcripts: `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601-dashes>-<uuid>.jsonl`,
  date-partitioned (NOT cwd-keyed). The trailing `<uuid>` is the session id;
  the first JSONL line is a `session_meta` record with `payload.id == uuid`.
- Claude transcripts: `~/.claude/projects/<cwd with [/.] → ->/<sessionId>.jsonl`.
  The real directory naming (e.g. `-Users-justin--instar-agents-echo`,
  double-dash from `/.`) confirms BOTH `/` and `.` are replaced.

## Change

New `src/core/FrameworkSessionStore.ts`:
`resolveFrameworkTranscriptPath({framework, sessionId, projectDir, ...})`:

- `claude-code`: deterministic `<root>/<encoded-cwd>/<sessionId>.jsonl`,
  encoding `[\/.]→-` — byte-for-byte the prior PreCompactionFlush logic.
- `codex-cli`: globs `<root>/YYYY/MM/DD/rollout-*-<sessionId>.jsonl`,
  returns the first match, `''` when none (safe no-op, same as before).
- Unknown framework → claude-code resolver (defensive default).

`PreCompactionFlush` and `ResumeValidator` both delegate to it. Both gain an
optional `framework` dep defaulting to `'claude-code'`, so Claude installs
are unchanged.

## Correctness note (pre-existing bug fixed, not silent)

`ResumeValidator` previously encoded the cwd with `/\//g` (slashes only),
while the real Claude convention (verified against `~/.claude/projects/`)
also replaces `.`. For any project dir containing a dot (e.g. `.instar`),
ResumeValidator was building a path that does not exist — a latent bug that
made resume-validation silently fail. Routing it through the shared resolver
(which uses the empirically-correct `[\/.]` encoding) fixes this. Called out
explicitly here and in the side-effects review; it is a correctness
improvement, not an unreviewed behavior change.

## What this is NOT

- Not a change to transcript *content* parsing — only path resolution.
- Not a wiring of the `framework` dep through every call site — callers that
  do not pass it get the Claude default (status quo). Threading the real
  per-session framework value is incremental and additive.

## Testing

`tests/unit/FrameworkSessionStore.test.ts` — 7 cases: empty sessionId; Claude
dot+slash encoding (real convention); Claude default root; Codex glob with a
decoy that must not match; Codex no-match → ''; Codex missing root → '';
unknown framework → Claude fallback. Plus 35 PreCompactionFlush +
ResumeValidator regression tests green.

## Manual lessons-aware check

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ shared resolver module |
| P4 Testing Integrity | ✓ 7 new + 35 regression |
| P6 Zero-Failure | ✓ suite green |
| P10 Comprehensive-First | ✓ module + both consumers |
| Trust-Verify-Improve | ✓ Codex format from live disk; ResumeValidator bug found+fixed+documented |
| L6/L9/L10 | ✓ siblings |

No contradictions. No fabrication — Codex format is empirically verified.

## Implementation slice

1. This spec + ELI16 + convergence report.
2. `src/core/FrameworkSessionStore.ts` (NEW).
3. `src/core/PreCompactionFlush.ts` — delegate + `framework`/`codexSessionsRoot` deps.
4. `src/core/ResumeValidator.ts` — delegate + `framework` dep (fixes latent encoding bug).
5. `tests/unit/FrameworkSessionStore.test.ts` (NEW, 7 tests).
6. `upgrades/NEXT.md` + `upgrades/side-effects/feat-portability-session-store.md`.
