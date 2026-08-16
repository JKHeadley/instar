# Side-Effects Review — project-scope Phase 1.7 skill surface

**Scope.** Closes the spec § Phase 1.7 user-facing surface. Rewrites
`.claude/skills/instar-project/SKILL.md` to cover all twelve canonical
commands, adds the three small HTTP routes the spec named but hadn't
materialized (`run-round`, `resume`, `abandon`), and realigns
`skillCommandForAction()` to the canonical command names.

## What's IN this PR

1. **`.claude/skills/instar-project/SKILL.md`** — full rewrite. Phase 1a
   placeholder language for `/project next` is removed (the connect-the-dots
   PR shipped the structured payload; the skill now documents that contract).
   Every command from spec § 1.7 has a section header with its backing
   endpoint, body schema, response codes, and a one-line rendering rule.
   Final section pins the conversational-tone rule ("never paste a curl
   command in a user-facing reply") that Echo's CLAUDE.md enforces.
2. **`POST /projects/:id/run-round`** — manual round trigger. On
   `preflight.ok`, writes `autoAdvanceAt = now` to the named round and
   returns 200 + `scheduledAt`. The auto-advance poller (wired in the
   connect-the-dots PR) picks it up on its next tick (≤60s) and dispatches
   `ProjectRoundExecution.runRound()`. No child-process spawn from the
   request handler — keeps one fire path through one lock.
3. **`POST /projects/:id/resume`** — clears `haltedAt`/`haltReason`,
   schedules the round via `autoAdvanceAt = now`, transitions
   `project.status` from `'halted'`/`'abandoned'` back to `'active'`.
   For `status: 'failed'` rounds at the 3-attempt cap, `{force: true}`
   is required AND the `resumeAttempts` counter resets to zero on
   accept. Returns 409 when the round is neither halted nor failed.
4. **`POST /projects/:id/abandon`** — sets `project.status = 'abandoned'`,
   strips `autoAdvanceAt` from every remaining round so the poller
   stops considering them, leaves each child's `pipelineStage`
   untouched. Idempotent (`alreadyAbandoned: true` on repeat).
   Refuses 409 when any round is `in-progress` — halt first.
5. **`skillCommandForAction()` realignment.** The connect-the-dots PR
   returned `/project approve` and `/project drift-check` for the
   `await-user-approval` and `run-drift-check` action verbs. Spec § 1.7
   uses `/project ack` and `/project drift`; the mapping is updated so
   the dashboard hints + the `/projects/:id/next` payload + the skill
   stay in sync.
6. **Tests.** `tests/unit/instar-project-skill.test.ts` (28 assertions)
   pins the SKILL.md contract — frontmatter, every spec § 1.7 command
   has a header, every documented endpoint exists in `routes.ts`.
   `tests/integration/projects-api.test.ts` adds 10 cases for the new
   routes covering happy paths + every documented error case.

## What's explicitly DEFERRED

- **`ProjectRoundRunner.resume` / `.abandon` methods.** The new
  endpoints mutate state via `tracker.update()` directly rather than
  routing through a runner method. The runner's value-add is the
  `preflight()` gate; resume/abandon don't have preflight semantics
  (they're transitions OUT of stuck states, not transitions INTO an
  autonomous run). If a future need surfaces — e.g., resume needs to
  hold the round-runner lock briefly, or abandon needs to release a
  worktree — those can land as runner methods then. Today, the
  shorter path is cleaner.
- **Resume worktree cleanup.** Spec § 1.5 step "Halt switch" says
  "Worktrees retained for inspection (cleanup deferred to user
  `/project resume` or `/project abandon`)." The new resume/abandon
  routes do NOT prune worktrees — the autonomous child the poller
  fires next will recreate them lazily. Worktree GC is a separate
  follow-up (registered as a child of the spec's deferral list).
- **No telemetry on action verbs.** The dashboard hint
  (`skillCommandForAction()`) is read-only suggestion; we don't yet
  count which verbs fire most frequently. A simple counter on the
  `/projects/:id/next` handler would surface "what's the most common
  unblocking step?" — interesting telemetry, but not Phase 1 scope.
- **Skill body translation hooks.** The SKILL.md is a single file; we
  don't (yet) split per-command bodies into separate files the agent
  can lazy-load. At ~10KB the file is well within the context budget
  for a `/project` invocation. If the surface keeps growing past
  Phase 1, splitting per-command is the natural next move.

## Side-effects review

**Over-block.** All three new routes are pure tracker.update() calls
with OCC. No child-process spawn, no git shell-out, no LLM call.
P99 latency in test runs ~20ms (single tracker write + JSON encode).
The skill body grew from ~3.5KB to ~10KB — adds one file read per
`/project` invocation; well below the context-window pressure
threshold.

**Under-block.** `resume` does not re-run drift before scheduling.
The poller's preflight (which fires after the route writes
`autoAdvanceAt`) re-runs drift if the cached verdict is stale (>24h)
per spec § Phase 1.4. So drift is enforced at fire time, not at
resume time — same level as the original `/project run-round`. This
is intentional: resume is a state mutation, not a fire trigger.

**Level-of-abstraction fit.** Each new route sits at the same layer
as the surrounding routes:
- `run-round` belongs alongside `halt` and `ack` (all three are
  user-initiated state changes that thread through the runner).
- `resume` and `abandon` belong alongside `accept-partial` (all
  three close out a specific round-end condition).

The skill is the highest layer — it's the conversational shell over
the HTTP API. SKILL.md is markdown the agent reads on `/project`
invocation, not executable code; the body's instructions ARE the
implementation.

**Signal vs authority.** The new routes are authority paths — they
mutate state. None of them consult an LLM signal. `run-round` does
delegate to `ProjectRoundRunner.preflight()` for the deterministic
gate checks; that's the spec's single-chokepoint pattern, not a
signal/authority mix.

**Interactions.**
- `run-round` + `auto-advance poller`: the route writes `autoAdvanceAt`,
  the poller reads it. The poller's `inFlight: Set<projectId>` guard
  (shipped in connect-the-dots) ensures a manual run-round followed
  by a poller tick doesn't double-fire.
- `resume` + `halt`: idempotent in either direction. `halt` writes
  `haltedAt`; `resume` strips it. Repeat halts on an already-halted
  round are no-ops; repeat resumes on an already-resumed round
  return 409 ("round is not halted or failed").
- `abandon` + `claim-ownership`: abandon sets `project.status =
  'abandoned'`; the auto-advance poller's owner filter already
  excludes abandoned projects. A peer claiming ownership of an
  abandoned project would just re-claim — the poller still skips
  abandoned-status projects regardless of owner.
- `skillCommandForAction()` realignment: existing test
  `expect(typeof res.body.skillCommand).toBe('string')` doesn't
  assert exact strings, so the rename is backwards-compatible at
  the test level. Dashboard consumers render the string verbatim —
  they get `/project ack` instead of `/project approve`, which is
  what spec § 1.7 documented.

**Rollback cost.** Three options:
1. **Skill-only rollback** — restore the prior SKILL.md from
   `git show HEAD~1:.claude/skills/instar-project/SKILL.md`. Agent
   reverts to Phase 1a read-only behavior; new HTTP routes still
   exist but are not surfaced. Zero state risk.
2. **Routes-only rollback** — `git revert` the three new route
   handlers. Skill still references them; agent surfaces 404 from
   `/project run-round`, `/project resume`, `/project abandon`.
   Surface-but-not-functional, but no data corruption — state
   mutations all go through `tracker.update()` with OCC, which is
   already proven safe.
3. **Full revert** — drop the whole commit. No on-disk state from
   this PR persists (the abandon/halt/resume state fields all
   pre-exist in the `Initiative` schema from Phase 1a).

All three are clean. The PR introduces no new persisted state, no
new file paths, no new background work — it adds surface area over
the existing state machine.

## Files touched

- `.claude/skills/instar-project/SKILL.md` (rewritten)
- `src/server/routes.ts` (three new route handlers + one mapping fix)
- `tests/integration/projects-api.test.ts` (10 new cases)
- `tests/unit/instar-project-skill.test.ts` (new file, 28 assertions)
- `upgrades/NEXT.md` (new release notes)

## Spec references

- `docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.7 — canonical
  command list.
- `docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.5 — runner preflight
  contract; halt/resume worktree-retention rule.
- `docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.3 — HTTP layer
  doesn't enforce gates the runner already enforces. `run-round`
  delegates to `preflight()` cleanly.

## Coverage

- Unit: structural coverage of SKILL.md + endpoint existence —
  `tests/unit/instar-project-skill.test.ts`.
- Integration: happy + error paths for all three new routes against
  the real `AgentServer` + `InitiativeTracker` + `ProjectRoundRunner`
  — `tests/integration/projects-api.test.ts`.
- Lint: clean.
- Type-check: clean (new `RoundStatus` import).
