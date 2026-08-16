# Gemini 3.1 Pro Review: PARALLEL-DEV-ISOLATION-SPEC.md

**Model**: gemini-3.1-pro-preview
**Date**: 2026-04-17
**Focus**: full document
**Verdict**: 8/10 — CONDITIONAL

---

## Raw Model Response

### Three "must fix" issues

1. **Multi-machine sync vs. local worktrees** — `topic-worktree-bindings.json` syncing across machines will reference paths that don't exist on the second machine. Fix: nest by `machineId` or exclude from sync. (Side effects table + Topic-binding state file.)
2. **Lock takeover doesn't stash uncommitted work** — A force-take or stale-lock reclaim on a worktree with unstaged changes will let the new session sweep the dead session's files into its own commits — the exact failure mode the spec was built to prevent, just relocated from `main` to a topic worktree. Fix: `git stash push -m "Auto-stash prior to lock takeover by session <ID>"` before handing the directory over. (Lock protocol.)
3. **AC-13 trailer leaks local paths** — `Instar-Worktree: <path>` writes `/Users/justin/...` into permanent git history. Fix: replace with `Instar-Topic-Id: <id>`. (AC-13 + Open question #3.)

### Notable gaps

- `npm install` latency on auto-create is unspecified; spec needs to state whether create blocks on install and how that latency surfaces to user.
- Pre-commit auto-promotion of read-only → dev (open question #4) is impractical at hook stage; require explicit `/promote-to-dev` instead.
- IDE DX: human opens `main` in VS Code, agent edits in worktree are invisible. Suggests auto-managed `.code-workspace` listing both.

### Strengths called out

Root-cause incident write-up; defense-in-depth (spawn + lock + pre-commit); PID-liveness + heartbeat lock; quarantine-then-delete reaper.

### Top 5 recommendations

1. Fix multi-machine sync (nest by machineId or exclude).
2. Auto-stash on lock takeover.
3. Change trailer to `Instar-Topic-Id`.
4. Drop auto-promotion in favor of explicit `/promote-to-dev`.
5. Define dependency-install behavior in auto-creation policy.

### Answers to remaining open questions
- Q1 lock conflict: `prompt` with timeout — correct.
- Q2 cross-topic refactor: defer.
- Q5 sentinel naming: `platform` is fine.

---

## Subagent Analysis

Substantive review — concentrated on the highest-leverage failure modes (multi-machine, lock takeover, path leakage). All three "must fix" items are also flagged by internal reviewers, which strengthens the convergence signal:
- Multi-machine: matches Security#8 + Integration#5
- Lock takeover work loss: matches Security#7 + Adversarial#6
- Trailer path leakage: NEW finding — internal reviewers focused on trailer authentication, missed the privacy/leakage angle.

Unique to Gemini: IDE DX angle (`.code-workspace` for human vs. agent file visibility) — internal reviewers didn't surface this developer-experience concern.

Gap: did not address pre-commit bypass paths (--no-verify, GIT_INDEX_FILE, etc.) which Security#3 flagged as critical.