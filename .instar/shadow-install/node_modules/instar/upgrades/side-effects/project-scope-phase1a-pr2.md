# Side-Effects Review — project-scope Phase 1a PR 2 (Stage validator + /projects API)

**Version / slug:** `project-scope-phase1a-pr2`
**Date:** `2026-05-11`
**Author:** `echo`
**Second-pass reviewer:** `required (new decision points + new external surface)`

## Summary of the change

Second of three PRs scaffolding the project-scope feature. PR 1 added
the type-level surface; this PR adds the persistence-layer artifact
validators and the HTTP routes that expose project records.

Spec source: `docs/specs/PROJECT-SCOPE-SPEC.md` §§ Phase 1.2, 1.3, 1.6,
1.10, 1.12.

New files (persistence/validator layer):
- `src/core/SafeYaml.ts` (234 lines) — minimal, safe YAML-frontmatter
  extractor. Hand-rolled subset (scalars + flow arrays + line lists),
  bounded depth/length to neutralise YAML-bomb classes of input.
- `src/core/PlanDocParser.ts` (370 lines) — parses a plan-doc markdown
  file into `{project, children, errors}`. Validates required fields,
  slug shape, source/effort/scope tags, child uniqueness, round
  membership.
- `src/core/StageTransitionValidator.ts` (397 lines) — deterministic
  validator for `pipelineStage` edges (outline → approved → building
  → merged, plus skipped/regressed). Every check is an artifact
  assertion (frontmatter equals literal, `gh pr view` reports
  `MERGED`, `git merge-base --is-ancestor` succeeds, file exists,
  realpath jailed under `targetRepoPath`).

Modified files:
- `src/core/InitiativeTracker.ts` (+11/-4) — `list()` accepts an
  optional `kind` filter (records without explicit `kind` are treated
  as `'task'` for back-compat).
- `src/server/routes.ts` (+332) — new `/projects/*` route group plus
  two helpers (`hashAuthHeader`, `checkAndIncrementProjectsRate`) and
  a small create-orchestrator (`createProjectAndChildren`).

HTTP endpoints (the only ones in PR 2; the rest of the spec's Phase
1.3 endpoint set lands in Phase 1b):

- `GET /projects` — list projects (joins via `kind: 'project'`).
- `GET /projects/:id` — fetch a project plus its children (via
  `parentProjectId`). Supports `?fields=<csv>` projection (Phase
  1.10).
- `GET /projects/:id/next` — returns 501 with a placeholder body;
  full implementation is Phase 1b's `ProjectRoundRunner`.
- `POST /projects` — create from a plan doc. Rate-limited 5/hour per
  auth-token hash; persists counter at
  `.instar/local/projects-rate.json` (gitignored, per-machine).
- `POST /projects/validate` — dry-run plan-doc parse; no side effects.
- `DELETE /projects/:id` — archive (status → `'archived'`). Requires
  `If-Match: <version>`; refuses while any round is `in-progress`.

Tests (49 new, all passing):
- `tests/unit/PlanDocParser.test.ts` — 9
- `tests/unit/StageTransitionValidator.test.ts` — 26
- `tests/integration/projects-api.test.ts` — 14

## Decision-point inventory

- **Stage transition gate** (`StageTransitionValidator`) — **add** —
  rejects requested edges that fail their artifact preconditions
  (e.g. `building → merged` without a `gh pr view → MERGED`).
  Reconciler-only edges (`*-> regressed`) require explicit
  `bypassMode: 'reconciler'`.
- **Plan-doc parse gate** (`PlanDocParser`) — **add** — rejects plan
  docs missing required frontmatter or with malformed child shapes;
  fed by `POST /projects` and `POST /projects/validate`.
- **`POST /projects` rate-limit** — **add** — 5 creates/hour per
  hashed auth token. Best-effort: fails open on disk error.
- **`DELETE /projects/:id` archive guard** — **add** — refuses
  archive while any `round.status === 'in-progress'`; requires
  `If-Match`.
- **`GET/DELETE /projects/:id` kind guard** — **add** — returns 404
  if the named id resolves to a non-project initiative.

All decision points are structural — they accept/reject on type,
reference integrity, and artifact presence, not on conversational
context.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The validators are artifact-bound: each rejection corresponds to a
missing or contradictory artifact (frontmatter field absent, PR not
merged, file outside `targetRepoPath`, plan-doc child id not unique).
The structure of every check is "does the named artifact exist /
equal the expected literal?" — none of them inspect free-form text or
make a judgement call.

- `StageTransitionValidator` only fires on `pipelineStage` transitions
  for child initiatives. Project-kind records and pre-project-scope
  task records (no `pipelineStage`) bypass it entirely.
- `PlanDocParser` errors are returned as structured `errors[]` from
  `POST /projects/validate` rather than turned into HTTP failures, so
  the user can iterate on their plan doc before committing.
- The `POST /projects` rate limiter is 5/hour per auth-token hash —
  generous for the documented usage shape (one project per session)
  and fails open if the counter file can't be written, so a disk
  hiccup doesn't refuse legitimate creates.
- The `DELETE /projects/:id` in-progress guard rejects only while a
  round is *literally* `in-progress`. Pending/complete/halted/paused
  rounds do not block archive.

No legitimate input shape is rejected by these new checks.

---

## 2. Under-block

**What failure modes does this still miss?**

- `StageTransitionValidator` only validates the named edge. A caller
  that issues two transitions in sequence (`outline → approved`,
  `approved → building`) gets each edge validated independently;
  there is no "history" check. This is intentional — the artifacts
  carry the history (frontmatter `approved-at`, TaskFlow record id).
- The reconciler-only edges (`*-> regressed`) are bypassable when the
  caller passes `bypassMode: 'reconciler'`. This is documented in the
  module header (P1, signal-vs-authority section) and the flag is
  only honored when callers pass it explicitly. User-initiated HTTP
  calls in this PR never set it.
- The `POST /projects` rate-limiter counter is per-machine. A user
  with multiple machines under the same auth token could create
  5×N projects/hour. The spec calls this acceptable (per-agent
  semantics) and `.instar/local/` is intentionally gitignored.
- `POST /projects` does not validate that referenced spec files
  actually exist on disk at create time — only the validator does,
  at transition time. This is intentional: child specs are often
  written after the project is registered.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes.

- `StageTransitionValidator` lives at the persistence-layer edge
  alongside `InitiativeTracker`. It is the deterministic *authority*
  for stage transitions (P1: there is exactly one). The drift
  checker (Phase 1.4) and dashboard surfaces will *signal* into it,
  not duplicate it.
- `PlanDocParser` is a pure parser with no I/O beyond a single file
  read; it returns structured data that the route handler decides
  what to do with. Re-usable from the `/project` skill (PR 3) and
  the dashboard's plan-doc preview without HTTP plumbing.
- `SafeYaml` is a deliberately narrow YAML-subset extractor. We
  rejected the `js-yaml` dependency for this surface because (a) it
  brings YAML-bomb / billion-laughs surface area that we don't need
  on a publicly-accessible API, and (b) the plan-doc grammar is
  small enough to handle with a 234-line bespoke parser.
- HTTP routes in `routes.ts` are thin: parse params, look up via
  the tracker, translate domain errors to HTTP codes, return JSON.
  No business logic moves into the route layer.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — these are structural validators, explicitly within the
      doc's "When this principle does NOT apply" carve-out.

The doc names two carve-outs that apply here directly:

1. **"Hard-invariant validation"** — typing and structural validators
   at the boundary of the system. `StageTransitionValidator` checks
   "does the frontmatter `state:` field equal `approved`?", "does
   `gh pr view` report `MERGED`?", "is this realpath under
   `targetRepoPath`?". `PlanDocParser` checks "is the slug a valid
   shape?", "are all referenced child ids unique?". These are
   structural checks against literals, not judgements about
   meaning. None of them inspects conversational content.

2. **"Safety guards on irreversible actions"** — the
   `DELETE /projects/:id` in-progress guard and the `If-Match`
   requirement on archive are precisely the kind of hard-block the
   doc endorses: the cost of a false pass is losing an active round;
   the cost of a false block is "try again after the round
   finishes."

No LLM judgment lives anywhere in this PR. There is no detector
emitting signals into a higher authority; the entire PR is
deterministic precondition logic. The drift checker (Phase 1.4 / PR
in Phase 1b) is the *signal* counterpart to this validator's
*authority* — it observes and reports, the validator decides.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing.** The new `/projects/*` routes are a fresh path
  prefix. They do not shadow `/initiatives/*`. Both can resolve to
  the same `Initiative` record through the tracker, but the new
  routes filter on `kind: 'project'` and return 404 for non-project
  hits, so a `task`-kind initiative is never accidentally exposed as
  a project.
- **Auth.** The `AgentServer` mounts `authMiddleware` *before* the
  router, so every `/projects/*` request gets the same bearer-token
  check as the rest of the API. The handlers do not re-implement
  auth.
- **Rate limiter.** The 5/hour counter is a counter file under
  `.instar/local/projects-rate.json`. The `.instar/local/` directory
  is gitignored (Phase 1.12 of the spec), so the counter never syncs
  across machines — matching the per-agent semantics the spec calls
  for. The reset cadence (60-minute sliding window) is implemented
  but not surfaced as a config knob; if a future user requests
  configurability, that is a Phase 1b polish.
- **OCC.** `DELETE /projects/:id` requires `If-Match` and translates
  `OccVersionMismatchError` (from PR 1) into a 409 with body
  `{error: 'version mismatch', currentVersion}`. The mapping is
  symmetric with the spec's wire format.
- **Backfill.** `list({kind: 'project'})` falls back to `kind ?? 'task'`
  for in-memory records that haven't yet been persisted, so an
  in-progress backfill never accidentally surfaces a pre-1a task as
  a project.
- **Routes.ts size.** Routes file grows from ~5400 → ~5750 lines.
  Still a single mountable router; no architectural change to the
  HTTP surface.
- **Races.** The rate-limit counter is read-modify-written within a
  single handler tick (synchronous fs). Two near-simultaneous
  creates from the same token can over-count by 1, but cannot
  under-count, so the limit holds. The plan-doc parse and the
  `tracker.create` calls run in sequence — there is no concurrent
  create path.
- **Feedback loops.** None. The validator is a request/response
  function; it does not emit signals back to anything.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine.** New HTTP endpoints under
  `/projects/*`. No agent currently calls them — they are new
  surface. Existing `/initiatives/*` endpoints are untouched.
- **Other users of the install base.** Same: new endpoints are
  additive; nothing existing is changed in shape. The
  `InitiativeTracker.list()` signature change adds an optional
  field and is fully backward-compatible.
- **External systems.** `StageTransitionValidator` shells out to
  `gh pr view` and `git merge-base --is-ancestor` (via injectable
  helpers). These run only when a caller triggers a stage
  transition; PR 2 does not include any code path that fires them
  yet (advance/halt/ack endpoints land in Phase 1b). The validator
  is exercised by unit tests with mocked helpers.
- **Persistent state.** New file:
  `.instar/local/projects-rate.json`. Created on first
  `POST /projects`; size is bounded (one entry per active token in
  the last hour, GC'd on every write). Format:
  `{ "<sha256-prefix>": { count: number, windowStart: epochMs } }`.
- **Timing / runtime conditions.** `POST /projects` reads the plan
  doc from disk and parses it. Bounded by plan-doc size; in
  practice <100ms. No background workers.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release.** Revert the commit. The three new files
  (`PlanDocParser.ts`, `SafeYaml.ts`, `StageTransitionValidator.ts`)
  are deleted; the additive hunk in `routes.ts` reverts cleanly;
  the `InitiativeTracker.list()` `kind` filter is backward-compatible
  (omitted filter returns all kinds, matching the prior behavior).
- **Data migration.** None required. The counter file
  `.instar/local/projects-rate.json` is per-machine and can be
  deleted (or left in place — unused files don't hurt). No
  `Initiative` records are written by PR 2 alone outside of normal
  `tracker.create()` writes that already round-trip.
- **Agent state repair.** Not needed. Any project records created
  via `POST /projects` before rollback continue to exist as
  `kind: 'project'` initiatives. Old code that reads them via
  `/initiatives/*` will see `kind: 'project'` and ignore it (it's
  an unknown extra field to pre-PR-1 code, and PR 1 has already
  shipped so that path is closed in practice).
- **User visibility.** Rollback removes the `/projects/*` endpoints.
  Any UI surfaces that started calling them get 404s; the
  dashboard's projects tab will gracefully degrade (the PR 3
  surface is conditional on these endpoints existing).

Rollback is a single `git revert` with no follow-up. Phase 1b code
that depends on the validators would need to be reverted in the
same revert if it had already shipped, but in the current sequence
PR 2 ships first.

---

## Conclusion

PR 2 of 3 for the project-scope Phase 1a build. New decision points
(stage transitions, plan-doc parsing, rate limit, archive guard) are
all structural validators or hard-invariant safety guards — they fit
within the explicit signal-vs-authority carve-outs and the doc's
guidance on what brittle/deterministic checks are allowed to do.
HTTP routes are thin translations; business logic lives in the
persistence layer alongside `InitiativeTracker`. No LLM judgment, no
new authority for a conversational decision point. Tests: 49 new
across 3 suites, all passing. Typecheck clean. Clear to ship pending
second-pass review.

---

## Second-pass review (required)

**Reviewer:** independent audit pass
**Date:** `2026-05-11`

Independently re-read the changes and the three review axes the brief
flagged:

1. **Signal-vs-authority compliance.** Confirmed: `StageTransitionValidator`
   is a deterministic precondition function over artifact assertions —
   literal equality on `review-convergence`, `approved`, `approved-by`,
   `approved-date` frontmatter; `view.state === 'MERGED'` string compare;
   `/^[0-9a-f]{7,64}$/i` sha regex; `gitMergeBaseIsAncestor(oid, 'origin/main')`
   ancestry check via injected helper. No LLM, no judgement,
   no scored similarity. Reconciler-only edges (`*-> regressed`) require
   explicit `bypassMode: 'reconciler'` and are otherwise rejected with
   code `REGRESSED_RECONCILER_ONLY`. The `PlanDocParser` performs
   schema/shape checks (slug regex, required keys, child uniqueness,
   round membership); same category. Both fit cleanly under
   `docs/signal-vs-authority.md` § "Hard-invariant validation" and
   § "Safety guards on irreversible actions".

2. **No smuggled decision points.** Reviewed the +332 diff in
   `routes.ts`. Six handlers, all thin: parse → tracker call → status
   code translation. The `pickFields` helper is a Set-based allowlist
   projection (deterministic). The rate limiter is a per-token counter
   against a flat threshold (5/hour), not a content judgement; it
   fails *open* on disk error so a flaky volume can't accidentally
   become a block. The `DELETE` in-progress guard is hard-invariant
   ("any round.status === 'in-progress'"). No new sentinel, gate, or
   watchdog surface.

3. **Interactions audit.** Auth is enforced upstream by the existing
   `authMiddleware` mount in `AgentServer.ts` — the new handlers do
   not re-implement it. The rate-limit file path
   `.instar/local/projects-rate.json` is under the gitignored
   `.instar/local/` per Phase 1.12 of the spec (verified). The handler
   acquires no lock around its read-modify-write; this is acceptable
   because (a) Node's event loop serialises handlers per process, (b)
   the comment explicitly classes the limiter as best-effort, and (c)
   the worst case under contention is an off-by-one count, never a
   leak past the threshold in the steady state. `list({kind: 'project'})`
   correctly falls back to `kind ?? 'task'` for not-yet-persisted
   in-memory records, matching the backfill semantics from PR 1.
   `OccVersionMismatchError` is caught by name (`err.name`) which is
   the same pattern the rest of the routes file uses, and is correctly
   translated to a 409 with `{currentVersion}`.

**Verdict: Concur with the review.** Clear to ship.

---

## Evidence pointers

- `tests/unit/PlanDocParser.test.ts` — 9 passing
- `tests/unit/StageTransitionValidator.test.ts` — 26 passing
- `tests/integration/projects-api.test.ts` — 14 passing
- `node_modules/typescript/bin/tsc --noEmit` → clean
- Spec: `docs/specs/PROJECT-SCOPE-SPEC.md` §§ 1.2, 1.3, 1.6, 1.10, 1.12
- Signal-vs-authority reference: `docs/signal-vs-authority.md` § "When this principle does NOT apply"
