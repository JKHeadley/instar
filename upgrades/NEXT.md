# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

### Project-scope Phase 1a PR 2 — Stage validator + `/projects` API

Second of three PRs scaffolding the project-scope feature. PR 1 added
the type-level fields; this PR adds the persistence-layer validator and
the HTTP surface your agent uses to register and inspect projects.

Spec source: `docs/specs/PROJECT-SCOPE-SPEC.md` §§ Phase 1.2, 1.3, 1.6,
1.10, 1.12.

**New files (persistence/validator layer):**
- `src/core/SafeYaml.ts` — minimal hand-rolled YAML-frontmatter
  extractor with bounded depth and length, so user-supplied plan docs
  can't smuggle in YAML-bomb input.
- `src/core/PlanDocParser.ts` — parses a plan-doc markdown file into
  `{project, children, errors}`. Validates required frontmatter, slug
  shape, source/effort/scope tags, child uniqueness, round membership.
- `src/core/StageTransitionValidator.ts` — deterministic validator for
  child-initiative `pipelineStage` edges (`outline → approved →
  building → merged`, plus skipped/regressed). Every check is an
  artifact assertion: frontmatter literal equality, `gh pr view`
  reports `MERGED`, file exists, realpath jailed under
  `targetRepoPath`.

**New HTTP endpoints (all require auth):**

| Endpoint | Status | Notes |
|----------|--------|-------|
| `GET /projects` | functional | Lists project-kind initiatives. |
| `GET /projects/:id` | functional | Project + its children. Supports `?fields=<csv>` projection. |
| `GET /projects/:id/next` | placeholder (501) | Round-runner lands in Phase 1b. |
| `POST /projects` | functional | Creates project + children from a plan doc. Rate-limited 5/hour per auth token. |
| `POST /projects/validate` | functional | Dry-run plan-doc parse; no side effects. |
| `DELETE /projects/:id` | functional | Archives; requires `If-Match`; refuses while a round is in-progress. |

The full Phase 1.3 endpoint set (`advance`, `drift-check`, `halt`,
`ack`, `accept-partial`, `claim-ownership`, `resolve-conflict`) lands
in Phase 1b once the round-runner exists.

**Other changes:**
- `InitiativeTracker.list({ kind })` — new optional filter on `list()`.
  Records without explicit `kind` are treated as `'task'` for back-compat.
- Rate-limit counter persisted at `.instar/local/projects-rate.json`
  (gitignored; never syncs across machines — matches per-agent semantics).

## What to Tell Your User

Your agent now has a real HTTP surface for projects. You (or your
agent) can register a multi-spec project from a plan-doc markdown file
and have the agent track it as a top-level project-kind initiative
with children rolled up underneath.

Right now this PR is the plumbing. It lets a caller do six things:
list projects, fetch one, dry-run a plan doc, create from a plan doc,
ask "what's next?" (currently returns a placeholder — PR 3 plus Phase
1b wires the real answer), and archive a project. The endpoints are
auth-gated and creation is rate-limited to 5/hour so a buggy caller
can't accidentally spawn a flood of projects. The advance/halt/ack
endpoints — the ones that actually drive a project forward — land in
Phase 1b along with the round-runner that powers them.

Nothing existing changes shape. The `/initiatives/*` routes still
return what they always did. If you don't use the new endpoints, you
won't notice anything.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Register a project from a plan doc | `POST /projects` with `{"planDocPath": "<abs-path>"}` |
| Dry-run validate a plan doc | `POST /projects/validate` with `{"planDocPath": "<abs-path>"}` |
| List all projects | `GET /projects` |
| Fetch project + children | `GET /projects/:id` (optionally `?fields=id,title,pipelineStage`) |
| Archive a project | `DELETE /projects/:id` with `If-Match: <version>` |
| Stage-transition validator (library) | `import { validateStageTransition } from './core/StageTransitionValidator.js'` |

## Evidence

Spec: `docs/specs/PROJECT-SCOPE-SPEC.md` §§ 1.2, 1.3, 1.6, 1.10, 1.12.

- `tests/unit/PlanDocParser.test.ts` — 9 new tests covering frontmatter
  parsing, slug validation, source/effort/scope tags, child uniqueness.
- `tests/unit/StageTransitionValidator.test.ts` — 26 new tests covering
  every named edge, reconciler bypass, jail check, PR state mapping.
- `tests/integration/projects-api.test.ts` — 14 new tests covering all
  six endpoints end-to-end through the live express router.
- Side-effects review: `upgrades/side-effects/project-scope-phase1a-pr2.md`.
