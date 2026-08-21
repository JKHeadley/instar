<!-- internal-only -->

## What Changed

The PR-boundary decision-audit gate now verifies that the audit record a pull request carries
actually **covers** the in-scope files that pull request changed, instead of only verifying that
some audit record was present.

Previously `evaluateDecisionAuditPresence()` asked one question — did any decision-audit record
change in this PR? — so an unrelated or stale-scoped record satisfied the gate while covering none
of the changed files. The gate reported "covered" while covering nothing.

The evaluator now accepts caller-supplied decision records, unions their readable `scope.files`, and
requires every in-scope changed path to appear in that union. The pure function still performs no
filesystem I/O; the CLI reads the per-entry JSON records and passes the parsed content in. A record
whose `scope.files` is absent, malformed, or unreadable contributes no coverage — the check fails
closed. Directory strings do not cover their descendants.

Unchanged: the bot-author, release-cut and no-in-scope-changes exemptions, and the legacy
`.instar/instar-dev-decisions.jsonl` transition allowance, which still short-circuits to a pass.

The failure output now names the specific uncovered files and the remedy (re-run the local gate so
the record declares those paths) rather than listing every in-scope file.

This is a CI-only gate script. There is no runtime surface, no route, no message, and no
agent-visible or user-visible behaviour change.

**Verdict is review-grade, not proven.** The five-property signature runner that would let a guard
be called fixed does not exist yet — `scratchpad/phaseB/B0.1-THE-BAR.md` is marked
`DRAFT-FOR-LANES` and its B0.2 implementation was never built — so nothing here is described as
fixing, verifying or proving the guard effective.

## Evidence

- `npx vitest run tests/unit/decision-audit-presence-check.test.ts` — 14/14 passing, covering both
  sides of the boundary: covering scope passes, stale scope fails, malformed scope fails closed,
  directory strings do not cover descendants, multiple records union, and each existing exemption
  still exempts.
- Side-effects review: `upgrades/side-effects/w22-decision-audit-scope-coverage.md`, including an
  independent second-pass review that concurred and separately confirmed the diff introduces no new
  schema, config, protocol surface or plumbing.
- Plain-English overview: `docs/specs/w22-decision-audit-scope-coverage.eli16.md`.
- The gap was identified by the Window-22 guard survey (`.instar/w22/branch-b-guard-ground-truth.md`),
  which located this guard as one of four that prove less than they claim and rated this
  identification the highest-confidence of the four.
