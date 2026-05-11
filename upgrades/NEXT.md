# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

### Stuck Telegram messages — auto-resend Enter after paste

On Claude Code v2.1.105 and newer, the Enter keypress after a bracketed-paste
sequence is occasionally eaten by a race with the paste-end handler. The
injected message — including Telegram and Slack relays — would land in the
prompt and sit there forever, never submitted, until someone pressed Enter
in the dashboard or tmux session manually.

Two-layer fix:

- **`SessionManager.verifyInjection`** (proactive). After every `rawInject`,
  schedule a 1.5-second check that compares the first 40 chars of the message
  against the pane at the `❯` prompt. If it's still there, send one extra
  Enter. Single-shot per injection, no-op when the text submitted normally,
  reports recovery via `DegradationReporter`.
- **`StallTriageNurse` fast-path** (recovery-time backstop). Before paying for
  an LLM diagnosis call, the triage nurse checks for ≥20 chars of text at the
  `❯` prompt without any processing glyphs (`⎿ ✶ ⏺` / "Coalescing" /
  "thinking" / "esc to interrupt"). If detected, nudge with a single Enter and
  skip the LLM round-trip. Conservative heuristic — false positives at worst
  send a harmless Enter.

Tests: `tests/unit/session-injection-verify.test.ts` (7 tests),
`tests/unit/stall-triage-typed-not-submitted.test.ts` (5 tests).

Side-effects review:
`upgrades/side-effects/verify-injection-stuck-input.md`.

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

Two things landed in this release.

First — a fix for the stuck-Telegram-message bug. Sometimes your message would
land in my input box but never actually submit, and you'd have to press Enter
in the dashboard to unstick me. That race is now caught automatically: after
every injection I do a quick re-check, and if your message is still sitting
there waiting, I press Enter for it. There's also a backstop in the stall
recovery path. You shouldn't have to nudge me again.

Second — your agent now has a real HTTP surface for projects. You (or your
agent) can register a multi-spec project from a plan-doc markdown file and
have the agent track it as a top-level project-kind initiative with children
rolled up underneath.

Right now the projects piece is plumbing. It lets a caller do six things:
list projects, fetch one, dry-run a plan doc, create from a plan doc, ask
"what's next?" (currently returns a placeholder — the round-runner lands in
the next phase), and archive a project. The endpoints are auth-gated and
creation is rate-limited to five per hour so a buggy caller cannot
accidentally spawn a flood of projects. The advance, halt, and acknowledge
endpoints — the ones that actually drive a project forward — land in the
next phase along with the round-runner that powers them.

Nothing existing changes shape. The initiatives routes still return what
they always did. If you do not use the new endpoints, you will not notice
anything.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Auto-recover stuck Telegram/Slack injections | automatic — `SessionManager.verifyInjection` resends Enter when needed |
| Register a project from a plan doc | `POST /projects` with `{"planDocPath": "<abs-path>"}` |
| Dry-run validate a plan doc | `POST /projects/validate` with `{"planDocPath": "<abs-path>"}` |
| List all projects | `GET /projects` |
| Fetch project + children | `GET /projects/:id` (optionally `?fields=id,title,pipelineStage`) |
| Archive a project | `DELETE /projects/:id` with `If-Match: <version>` |
| Stage-transition validator (library) | `import { validateStageTransition } from './core/StageTransitionValidator.js'` |

## Evidence

**Stuck-input fix (PR #151).** Reproduction: Justin observed Telegram messages
landing in Claude Code's input buffer at the `❯` prompt without being submitted
on Claude Code v2.1.139, confirmed by a 2026-05-11 dashboard screenshot showing
the message text visible at the prompt with no processing glyphs. The race
matches the original failure mode that the verifyInjection design (April 13,
commit a81699d4) was written for. Observed-before: message sat in input
indefinitely until a manual Enter from the dashboard. Verified-after: with
verifyInjection in `rawInject`, a 1.5s post-injection check fires and
auto-resends Enter when the marker text is still at the prompt; recovery
reported via DegradationReporter. Coverage:
- `tests/unit/session-injection-verify.test.ts` — 7 tests covering marker
  extraction, captureOutput, Enter resend, and the no-op when the text
  submitted normally.
- `tests/unit/stall-triage-typed-not-submitted.test.ts` — 5 tests covering the
  StallTriage fast-path: detection thresholds, glyph-presence refusal, the
  LLM-bypass nudge.
- Side-effects review: `upgrades/side-effects/verify-injection-stuck-input.md`.

**Project-scope Phase 1a PR 2.** Spec:
`docs/specs/PROJECT-SCOPE-SPEC.md` §§ 1.2, 1.3, 1.6, 1.10, 1.12.

- `tests/unit/PlanDocParser.test.ts` — 9 new tests covering frontmatter
  parsing, slug validation, source/effort/scope tags, child uniqueness.
- `tests/unit/StageTransitionValidator.test.ts` — 26 new tests covering
  every named edge, reconciler bypass, jail check, PR state mapping.
- `tests/integration/projects-api.test.ts` — 14 new tests covering all
  six endpoints end-to-end through the live express router.
- Side-effects review: `upgrades/side-effects/project-scope-phase1a-pr2.md`.
