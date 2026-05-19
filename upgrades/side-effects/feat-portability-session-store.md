# Side-effects review — FrameworkSessionStore (Gap 3)

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER — flush/resume silently no-op for Codex. After: no over-block.
Claude path is byte-identical (default framework = claude-code, same encoding
empirically confirmed against ~/.claude/projects/). Codex path returns '' when
no file (same safe no-op the callers already handle). No new over-block.

## 2. Level-of-abstraction fit

Path resolution extracted into one pure module (`FrameworkSessionStore`).
Consumers delegate. Correct altitude — resolution logic in one tested unit,
orchestration unchanged in the consumers.

## 3. Signal vs Authority compliance

`framework` (dep) is the SIGNAL of which runtime produced the session; the
resolver is the single AUTHORITY for the path. Missing/unknown framework
fails safe to claude-code (status quo).

## 4. Interactions with adjacent systems

- **PreCompactionFlush** — only `resolveTranscriptPath` changed; tail-read,
  flush, audit logic untouched. 35 regression tests (with ResumeValidator)
  green.
- **ResumeValidator** — delegates; the `readSessionJsonl` test override path
  is unchanged (still wins when provided). Latent slash-only encoding bug
  fixed (see §6).
- **CompactionSentinel / other transcript readers** — not touched; they can
  adopt the resolver incrementally. No behavior change for them.
- **Codex sessions dir** — read-only globbing; no writes, no mutation.

## 5. Rollback cost

Low. One new module + two delegating edits + one new test. `git revert`
restores prior behavior. The new optional deps are ignored by callers that
don't set them.

## 6. Backwards compatibility / drift surface

Claude-code: byte-identical path for slash-only project dirs; for dirs
containing a dot, ResumeValidator now produces the CORRECT path (the real
~/.claude/projects/ naming replaces `.` too) — this fixes a pre-existing
latent failure rather than introducing one. PreCompactionFlush already used
the `[\/.]` encoding, so it is unchanged. This correctness delta is
documented, not silent. Drift surface: reduced — one resolver instead of two
divergent inline encodings.

## 7. Authorization / Trust posture

No new authority. Pure read-only path resolution + fs.existsSync/readdir.
Cannot write, cannot escalate. Unreadable/missing Codex tree → '' (safe
no-op).

## Outcome

Ship. Empirically grounded (no fabrication), both consumers wired, a latent
correctness bug fixed transparently, trivial rollback. Fourth shipped of the
v1.0.9–v1.0.14 hardening series (1.0.12).
