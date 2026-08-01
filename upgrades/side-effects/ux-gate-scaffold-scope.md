# Side-Effects Review — UX-impact gate: recognise `src/scaffold/templates.ts` as a user-facing path

**Version / slug:** `ux-gate-scaffold-scope`
**Date:** `2026-08-01`
**Author:** `Echo (instar-dev)`
**Second-pass reviewer:** `REQUIRED — this change modifies a gate` (see §Second pass)

## Summary of the change

`scripts/ux-impact-lint.mjs` decides whether a PR is "user-facing" by matching changed
files against a hard-coded allowlist (`:25`). That allowlist omitted
`src/scaffold/templates.ts` — the file the Agent Awareness Standard names as THE
user-awareness surface ("An agent that doesn't know about a capability effectively
doesn't have it"). A PR touching only that file therefore hit `allowlisted.length === 0`
(`:27`) and exited 0, requiring no UX declaration for the change that alters what every
agent tells its users. Three edits, one defect: the path joins the allowlist (`:25`), it
also disqualifies the refactor-only exemption (`:30`), and the quote-check failure message
(`:41`) now names the concept and lists the paths actually searched. Adds
`tests/unit/ux-impact-lint-scaffold-scope.test.ts`.

## Decision-point inventory

- `ux-impact-lint.mjs:25` — **modify** — allowlist membership; adds one exact-match path.
- `ux-impact-lint.mjs:27` — **pass-through** — the in-scope/out-of-scope exit. Unchanged
  logic; a strictly smaller set of PRs now reaches the `exit(0)` skip.
- `ux-impact-lint.mjs:30` — **modify** — refactor-only exemption eligibility.
- `ux-impact-lint.mjs:41` — **modify** — failure MESSAGE only. The predicate at `:40` is
  untouched.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

A PR that touches `src/scaffold/templates.ts` for a genuinely non-user-visible reason —
e.g. renaming a local variable inside `generateClaudeMd()`, or reflowing a comment — now
requires a UX Impact section where previously it required none. That is a real new cost
imposed on a legitimate input.

Two mitigations, both pre-existing: the `refactor-only` exemption still applies when the
change adds no quoted strings (`:31`), and the author can satisfy the gate by quoting any
concrete added string. It is a friction increase, not a wall. Concretely: a
whitespace-only change to that file will now demand a declaration, which is mildly
annoying and is the price of the file being in scope at all.

## 2. Under-block

**What failure modes does this still miss?**

Substantially more than it catches, and this must not be oversold:

- The allowlist remains a **proxy** for "user-facing" and still omits every other path
  that can reach a user — `src/core/PostUpdateMigrator.ts` (which writes agent-visible
  guidance on upgrade), skill `SKILL.md` bodies, `src/data/http-hook-templates.ts`, and
  any future file that renders text a human reads.
- The gate only fires on **PR paths**, so a user-visible change delivered by a config
  default or a runtime string has no coverage here at all.
- A PR touching `src/scaffold/templates.ts` **and** an already-allowlisted file was
  already in scope, so for that (common) shape this change alters nothing.
- The quote check is satisfied by ANY quoted substring present in the allowlisted diff.
  An author can still quote something trivially true and unrelated to the actual user
  impact. This change does not make declarations honest; it makes them required.

## 3. Level-of-abstraction fit

The fix operates at the same level as the defect: a path missing from a path list is
repaired by adding the path. No new abstraction, no new config surface, no new file.
The alternative — deriving "user-facing" from something semantic rather than a path list
— would be a genuinely better design and is deliberately NOT attempted here; it is a
redesign, not a fix, and would ship as its own spec.

## 4. Signal vs authority compliance

The gate is an **authority** (it exits non-zero and blocks a PR), and it stays exactly as
authoritative as it was — the change alters WHICH files it considers, never WHETHER it
may block. No new authority is created. The message change at `:41` is pure signal
improvement and carries no gating weight.

Notably this change does not grant the gate any new power over anything outside the repo,
and it cannot affect a running agent: `scripts/` is CI-only and ships in no runtime path.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is added. Every predicate is deterministic string matching; there is no
LLM call, no heuristic, and no scoring. The one judgment exercised was authorial and is
recorded here: **exact-match `src/scaffold/templates.ts` rather than
`startsWith('src/scaffold/')`**, because the standard names one file and widening a gate
beyond what a standard names is a policy change no one approved.

## 5. Interactions

- **`.github/workflows/ux-impact-pr-gate.yml`** — unchanged. Its `paths:` trigger already
  includes `scripts/ux-impact-lint.mjs`, so the workflow's own trigger set needs no edit.
- **Agent Awareness Standard (CLAUDE.md)** — this change makes the gate agree with the
  standard rather than contradict it. Nothing else consumes the allowlist.
- **`report.allowlistedPaths`** (`:26`) — the emitted JSON report may now contain one more
  path. Any downstream consumer reading that array sees a longer list; no consumer in this
  repo branches on its contents.
- **No interaction with the release pipeline, migrations, or PostUpdateMigrator.**

## 6. External surfaces

None. `scripts/ux-impact-lint.mjs` runs only in CI, is not bundled into `dist/`, is not
served by any route, and is never executed by a deployed agent. No API, no dashboard, no
Telegram surface, no config key. The only humans who observe a behaviour change are
contributors opening PRs against this repo.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The operator-visible surface is the CI failure message, and this change exists partly to
improve it. Before: `UX Impact must quote a concrete string from the diff` — which is
misleading, because the script searches only the allowlisted subset of the diff, so an
author quoting a genuine added line from an unlisted file is told something false about
why they failed. After: the message names the concept ("the USER-FACING paths this PR
touches"), enumerates those paths, and states plainly that quotes from other changed files
are not checked. An author can now self-diagnose in one read.

## 7. Multi-machine posture (Cross-Machine Coherence)

Not applicable. CI-only script with no state, no lease interaction, no replication, and no
per-machine behaviour. It executes once per workflow run on a GitHub runner.

---

## Risks accepted

1. **Friction on incidental edits** to `src/scaffold/templates.ts` (§1). Accepted: the
   file's whole purpose is agent-visible text, so incidental edits are rare and a
   declaration is cheap.
2. **The proxy remains a proxy** (§2). Accepted for this change and explicitly NOT claimed
   as fixed. The allowlist still has no owner and no review trigger; that is a real
   residual and is stated in the ELI16 rather than hidden.

## Evidence

Verified against real commit `e29259c49` (touches `src/scaffold/templates.ts`, zero
allowlisted paths — both confirmed by control counts):

| lint | result |
|---|---|
| shipping (`origin/main`) | `UX lint: out of scope`, **exit 0** — gate skipped |
| patched | engages, **exit 1** on `UX-Impact: none` |
| patched, replaying PR #1813 | **exit 0** — no regression on a real passing PR |

Tests trip-tested in both directions: **3/3 pass** with the fix; **2 fail** without it;
the internal-path control passes either way (as a control must).

## Second pass

This change modifies a **gate**, which mandates second-pass review. Requested from Codey
on the PR. Not self-certified: the reviewer's response will be appended here.
