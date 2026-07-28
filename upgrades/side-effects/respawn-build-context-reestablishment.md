# Side-Effects Review — Respawn build-context re-establishment

**Version / slug:** `respawn-build-context-reestablishment`
**Date:** `2026-06-04`
**Author:** `instar-codey`
**Second-pass reviewer:** `instar-codey second-pass checklist`

## Summary of the change

This change hardens the interactive SessionManager respawn path for developer build sessions. A new sidecar store records each running session's live tmux pane working directory, using the generic state layer's temp-file-plus-rename atomic write. When a resumed interactive session has a fresh saved cwd under an agent worktree, SessionManager prepends a `[BUILD-CONTEXT RESTORE]` continuation note to the resumed message. Normal home-only sessions, stale records, missing worktrees, and non-enabled agents receive no note.

The feature is dark by default for normal agents. Server boot resolves the session-level feature flag as an explicit override if present, otherwise the standard development-agent gate.

## Decision-point inventory

- `SessionBuildContextStore` — add — owns sidecar state validation, crash-safe persistence through StateManager, cwd eligibility, staleness, missing-path checks, branch enrichment, and restore-note formatting.
- `SessionManager.monitorTick` — modified — records pane cwd after liveness is confirmed, without changing session lifecycle decisions.
- `SessionManager.spawnInteractiveSession` — modified — prepends a restore note only for resume spawns with an eligible saved worktree context.
- `server` startup wiring — modified — resolves the feature dark by default and live for development agents unless explicitly overridden.
- Session-management e2e — modified — proves a real tmux pane under a fixture worktree gets the restore note while a home-only control stays unchanged.

## 1. Over-block

The restore can skip a legitimate build context if the tmux cwd is not under a `.worktrees` path. That is intentional. The spec's blast-radius guard is more important than restoring every possible hand-navigated directory. Agents can still recover manually from conversation context; the automated note is limited to the known build-worktree convention.

The restore can also skip when the sidecar is stale or the worktree directory was removed. That prevents a respawn from sending the agent back into a deleted or long-finished checkout.

## 2. Under-block

The sidecar records cwd for running sessions when the feature is enabled, including home-only sessions. Home-only records are not eligible for restore, so this is additional local state but not additional behavior. The record contains local paths and an optional branch name; it does not include prompt content or credentials.

The branch name is best-effort enrichment. If Git cannot read the branch, the restore note still works with the worktree path alone. Failure to read branch never blocks monitoring or respawn.

## 3. Level-of-abstraction fit

SessionManager owns tmux lifecycle, liveness checks, interactive respawn, and initial-message injection, so it is the correct place to sample pane cwd and prepend the resume note. The sidecar store keeps persistence and eligibility logic out of the large SessionManager class and makes the boundary unit-testable.

The change does not force tmux to spawn inside the worktree. That matches the design spec: the session home remains stable, and the resumed agent receives deterministic instruction to return to the build checkout only when appropriate.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Not applicable to conversational/product judgment — this is structural session lifecycle restoration.

The cwd sample is a mechanical tmux fact. The restore decision is a deterministic filesystem/scope guard: fresh, existing, different from spawn cwd, and under a worktree path. It does not judge user intent or message meaning.

## 5. Interactions

- **Shadowing:** The restore note is prepended before the normal initial-message injection. Existing InputGuard and injection mechanics still handle the resulting message through the same path.
- **Double-fire:** The note is computed once per resumed spawn. Reusing an already-live tmux session does not inject a restore note.
- **Races:** A worktree can be removed between sidecar read and agent acting on the note. The respawn path checks existence immediately before injecting; after that, the note is advisory and the agent can report if the path disappears.
- **Feedback loops:** Monitoring persists only when cwd changes, avoiding a write every tick for steady sessions.

## 6. External surfaces

The visible behavior is a new continuation preamble for eligible resumed developer sessions. The preamble is intentionally plain text and starts with `[BUILD-CONTEXT RESTORE]` so the agent can act on it deterministically. Normal topic sessions that remain in agent home see no new text.

The persistent surface is a local sidecar state record keyed by tmux session name. It stores spawn cwd, current cwd, optional branch, and update time.

## 7. Rollback cost

Rollback is a code revert of the sidecar store, SessionManager wiring, server gate wiring, tests, and artifacts. The sidecar state file can remain harmlessly on disk; without the code path it is ignored. No migration or state repair is required.

## Conclusion

The change addresses the respawn amnesia failure without changing normal spawn cwd, without broadening behavior for home-only sessions, and without relying on conversation memory to rediscover the checkout. The test set covers pure eligibility/staleness behavior, mocked tracker-to-respawn wiring, and a real tmux e2e with both worktree and home-only controls.

## Second-pass review

**Reviewer:** `instar-codey separate pass`
**Independent read of the artifact:** concur

The risky surface is SessionManager. The implementation keeps the new behavior behind a feature gate, samples only after liveness is confirmed, writes through crash-safe state persistence, and injects only a continuation note for eligible resumed spawns. The scope guard is the core safety property and is covered in all three test tiers.

## Evidence pointers

- `npm test -- --run tests/unit/session-build-context-store.test.ts tests/integration/session-build-context-respawn.test.ts` passed.
- `npm test -- --run tests/e2e/session-management-e2e.test.ts -t "restores a worktree build context"` passed.
- `npm test -- --run tests/unit/no-silent-fallbacks.test.ts tests/unit/session-build-context-store.test.ts` passed after marking best-effort branch enrichment as an intentional fail-open.
- `npm run lint` passed.
