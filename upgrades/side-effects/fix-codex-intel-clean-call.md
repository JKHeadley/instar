# Side-Effects Review — Codex Intelligence-Provider Clean-Call Fix

**Version / slug:** `fix-codex-intel-clean-call`
**Date:** 2026-05-26
**Author:** Echo
**Spec:** `docs/specs/CODEX-INTELLIGENCE-PROVIDER-CLEAN-CALL-SPEC.md` (converged + approved)

## Summary of the change

`CodexCliIntelligenceProvider.evaluate()` ran `codex exec --cd <agent project dir>` for
every internal LLM "judgment" call (message classification, terminal-output analysis,
arc extraction, usher, coherence, etc.). Running in the project dir made Codex load the
full ~26 KB `AGENTS.md` identity AND fire the project's `.codex/hooks.json`
(session_start / user_prompt_submit / stop) on **every** call — ~1,550 such calls/day,
causing notification spam (session_start firing constantly) and spawn-storm delivery
failures (12 heavyweight spawns/minute saturating the machine).

The fix runs these calls in an empty, owner-only scratch dir instead — the Codex analog
of `ClaudeCliIntelligenceProvider`'s `--setting-sources user`. No identity, no project
hooks.

**Files changed (source):**
- `src/core/CodexCliIntelligenceProvider.ts` — `evaluate()` now uses an `mkdtempSync`
  scratch dir for `--cd` (not the project dir) + `-c project_doc_max_bytes=0`; added the
  `resolveIntelligenceScratchDir()` helper; removed the now-dead `workingDirectory` field
  (kept on the options type for API compat).

**Files changed (tests):**
- `tests/unit/CodexCliIntelligenceProvider.test.ts` — updated the `--cd` assertion (it
  previously asserted the buggy project-dir behavior) + added 7 cases covering the
  scratch-dir contract, 0700 perms, unguessable name, and tmp-reaper recovery (12 total).

**Files changed (spec / report / release notes):**
- `docs/specs/CODEX-INTELLIGENCE-PROVIDER-CLEAN-CALL-SPEC.md` (+ `.eli16.md`)
- `docs/specs/reports/codex-intelligence-provider-clean-call-convergence.md`
- `upgrades/NEXT.md`

## Decision-point inventory

- **Scratch dir, not the project dir** — the core fix. Judgment calls are cwd-independent
  (per the existing code comment), so an empty cwd is correct.
- **`mkdtempSync` (random suffix, 0700), not a fixed name** — convergence security finding:
  a fixed `/tmp` name on Linux is plantable (`.codex/hooks.json` squatting; not gated by
  `project_doc_max_bytes`). The unguessable, owner-only dir closes that vector.
- **Re-verify-before-use** — recreate the dir if a tmp-reaper deleted it during a
  long-lived process.
- **`-c project_doc_max_bytes=0`** — belt-and-suspenders for an `AGENTS.md` on the cwd
  walk-up; real key, already used in `contextScopeControl.ts`.
- **Drop `workingDirectory` as exec cwd** — verified only `route.ts` passes it, and only
  for its own PreferenceStore DB path, never the codex cwd.

## Over-block / under-block analysis

- **Over-block:** none. The provider gates nothing; it only changes the cwd of a spawn.
  Judgment calls that worked before continue to work (the fake-codex unit tests confirm
  the full arg contract).
- **Under-block:** the *intended* behavioral subtraction is "stop loading identity + firing
  hooks for judgment calls." There is no path where a judgment call legitimately needed the
  identity or hooks — they are stateless classifications/extractions. If a future caller
  did need project context, it must pass it in the prompt (as all current callers do), not
  rely on cwd.

## Level-of-abstraction fit

The fix lives in the single provider that owns the `codex exec` invocation — the same layer
where the Claude sibling already solves the identical problem with `--setting-sources user`.
No higher-level orchestration or config knob is introduced; the concern is local to the
spawn, so the fix is local to the spawn. Correct altitude.

## Signal-vs-authority compliance

N/A in the gate sense — this change neither detects nor blocks anything. It is a pure
invocation-hygiene fix. It does not touch any sentinel/gate authority boundary.

## Interactions

- **Claude provider:** untouched; asymmetry (flag vs scratch-cwd) is intentional and
  documented — Codex has no single equivalent flag.
- **Callers (`reflect.ts`, `route.ts`, `server.ts`):** none depend on the codex cwd
  content; verified during integration review. No behavior change for them beyond the
  intended one.
- **Concurrency:** `mkdtempSync` once + cached + `existsSync` re-check; no race under the
  high call volume (idempotent, read-only dir).
- **Monitoring layer:** positive interaction — the session_start hook no longer fires on
  judgment spawns, so PresenceProxy/standby stops mistaking them for real sessions
  (the notification-spam root cause).

## Rollback cost

Trivial and isolated. Revert the single source file (and its test). No persisted state, no
schema, no config/hook/template/migration to unwind — the only on-disk footprint is an
empty 0700 tmp dir that the OS reaps on its own. Reverting restores the prior (buggy but
functional) behavior with zero data implications.

## Migration parity

Code-only change inside the compiled provider. No agent-installed file
(settings/hooks/config/templates/skills) references the old behavior, so **no
`PostUpdateMigrator` entry is required** — existing Codex agents receive the fix via the
normal package update path. Verified by grep during integration review.

## Testing evidence

- Unit: 12 tests in `CodexCliIntelligenceProvider.test.ts` pass; sibling env-allowlist (4)
  + factory (10) tests unaffected; clean `tsc` build.
- Live / bug-fix evidence bar: the before/after rollout reproduction on a real Codex agent
  (identity-loaded before, bare after) is run as the post-merge test-as-self gate and
  recorded before the fix is declared shipped.
