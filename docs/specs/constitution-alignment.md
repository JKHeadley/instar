---
title: "The 1.x registry and the 2.0 rule book stay aligned on every update"
slug: "constitution-alignment"
author: "echo"
parent-principle: "Occam's Razor — Simplest Robust Route"
eli16-overview: "constitution-alignment.eli16.md"
review-convergence: "2026-11-04T03:31:12.812Z"
review-iterations: 5
review-completed-at: "2026-11-04T03:31:12.812Z"
review-report: "docs/specs/reports/constitution-alignment-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# The 1.x registry and the 2.0 rule book stay aligned on every update

## Problem statement

Justin's directive of 2026-11-03 19:07 PST, topic 137053: "we should have a FUNDAMENTAL REQUIREMENT that 1.x and 2.0 constitution/rule book always stay aligned for ALL updates".

PR #2323 (2026-10-23) made the 2.0 purpose and rule book the master for both versions, with `docs/STANDARDS-REGISTRY.md` beneath them. It created one authority and nothing that keeps the texts together. Since then the 1.x registry changed three times (#2194, #2380, #2682) and the master once (#182), and only the single-provider floor reached both books. #2687's spec said the next gap out loud: "Master rule 72 in the 2.0 rule book is not edited here."

Each drift was invisible because nothing reads both books. A rule held only by an author remembering the other repository is the failure *Structure beats Willpower* names.

## Proposed change

### The rule

One new rule in both books, same obligation. Master: **Rule 119, One Constitution, Two Books Aligned**, in "Checkable now". 1.x: a new article of the same name in *The Fractal*, a root.

Master row, meaning column:

> The 1.x registry and the 2.0 purpose and rule book are one constitution, and they stay aligned on every update. Every change to either book names its counterpart change in the other, or says why it has none (it concerns only that version, or it changes no obligation). Where the two differ, the alignment map says so by name, and the master governs. No difference is silent.

Master row, check column:

> A script reads each pull request touching either book and flags one with no declared counterpart; the 1.x merge tool refuses it. A daily check reads both repositories' history and raises any merged change whose pair never landed. Whether two wordings carry the same obligation, and whether a stated "none" is honest, is held by the independent review of the change.

1.x carries the same sentences as its `**Rule.**`, with `**Fails.**`, `**In practice.**`, `**Applied through.**`, `**Earned from.**` and `**Tree placement.**` per registry form.

### What counts as a change

Everything. A commit touching `docs/STANDARDS-REGISTRY.md` in instar, or `docs/00-the-purpose.md`, `docs/01-the-rules.md`, or `docs/rules/**` in instar-2. No clause classification and no parsing: the file path is the whole scope, so nothing can be smuggled into an uncounted clause and nothing needs maintaining when the books change form. An implementation-reference edit declares `none` in one line and asks nothing more of anyone.

### The declaration

A line in the body of every such pull request:

```
Constitution counterpart: JKHeadley/instar-2#190
Constitution counterpart: none: <why>
```

Editing a PR body does not dismiss an approval, so two PRs can name each other after both exist without a push. instar reads the line at merge time. instar-2's `document-checks` gains the `edited` trigger so the edit re-runs its check; `/.github/` is code-owned there, so that lands in the same tap.

### The checks

`scripts/check-constitution-pairing.mjs` in each repo. No model; no third-party dependency.

**On a pull request touching a book.** Passes only if the line exists and is well formed, and either `none:` has a non-empty reason or the named PR is in the *other* repository, targets `main`, is open or merged, and its changed files include a book. It reads the other repo through the API with `github.token`, which works because both are public. If that read fails it says *unknown*, never pass.

Where it binds:

- **instar:** `scripts/safe-merge.mjs` refuses a PR touching the registry unless the check passes, placed right after the non-`main` base refusal, which every merge path already runs. New result `refused:constitution-counterpart`. The green-PR watcher treats it as waiting on a body edit, re-reading the body rather than the head. Any other repository no-ops. `safe-merge.mjs` is a protected path, so this step takes a second-pass review.
- **instar-2:** a job in `document-checks`, red on the PR at the moment he reviews it. instar-2's ruleset requires no status checks and the agent cannot change rulesets. So it does not physically prevent a merge. The daily check is the backstop. Stated plainly rather than implied.

The check is an existence check, like the Maturation Path plan gate: it refuses on a missing declaration, never on whether the declaration is any good.

**Daily, on Echo, a scheduled job.** The script lists commits touching a book on each repository's `main` after a baseline SHA recorded per repository: the head of each `main` immediately before the landing below, so the two amendments in this very landing are themselves audited. It paginates to the end; a list it could not finish is `unknown`. Several commits from one PR give one row. Each PR goes through the same validator as the PR check, and is classified:

- `paired`: the validator passes and the counterpart is merged.
- `declared-none`: stated reason.
- `waiting`: the counterpart is open, and the first merge is under 48 hours old. Age comes from the merge timestamps GitHub already holds, so the script keeps no state.
- `overdue`: the counterpart is open, past 48 hours. No repair session. One attention item, saying whether it waits on his approval or on me.
- `drift`: no line, a line that fails the validator, or the counterpart closed unmerged.
- `no-pr`: a commit with no pull request. Rare: only the release path bypasses the PR rule on instar, and it does not edit the books. If it happens it goes straight to one attention item keyed by the sha, since there is no PR body to repair.
- `unknown`: the read failed. Never reported as clean.

It is a `script` job, not a gate: a job gate treats any non-zero exit, a crash or its 10-second timeout as "skip", so a broken check would read as clean. The script job prints one result line with every class's count, so a healthy run is visibly a run that looked at something, and the scheduler records it. `unknown` reports failed, which its existing job-failure tracking handles. The script keeps no state.

The job runs the checker from `origin/main` of the agent's instar checkout, so it never depends on what branch that checkout is on: after a fetch, `git show` writes the file to a temp `.mjs` and only then runs it. Piping would not do: a missing file through a pipe exits 0 with no output, and the scheduler would record success. The job's shell wrapper exits non-zero when the checker prints no result line, because the scheduler reads only the exit code of a script job. Script jobs do not inherit the session's GitHub token, so the job resolves it itself from the same store the sessions' token comes from, and a run with no token is `unknown`, which reports failed.

On `drift`, the job spawns a session, one per PR, named by that PR, and skips the spawn if a session of that name is already running. That session repairs first. It searches the other repository for an open PR whose line already names the source and reuses it; otherwise it opens the counterpart, with the wording drafted and independently reviewed and the source named in its line from the first write. Then it edits the merged source PR's line to name the counterpart, which moves the row to `waiting` or `overdue`, neither of which spawns a session. So GitHub holds the record at every step, and a crash between those writes is recovered by the search. A duplicate run in the narrow gap before the first write would show as two visible PRs, one to close. Accepted. If the session concludes no counterpart is needed, it writes `none: <why>` only after an independent review agrees. There is no notice on first detection. The operator hears once repair has reached its end, either because his approval is the remaining step or because it is stuck, as one attention item keyed by the PR, through the existing attention queue and its dedupe.

This job lives on Echo because only the instar-developing agent changes the constitution. It is not a fleet feature.

The workflow-level red alone would not do: `/ci` shows the latest five runs across all workflows, and instar ran 40 in 35 minutes today, so a daily red scrolls off in minutes.

### Rule 72

Master rule 72 meaning column, approved direction from #2687 in rule-book form:

> Every feature graduates test agent → development agent → fleet, with a declared graduation test and deadline, and with default-on for the fleet as the last rung unless a recorded user-preference decision keeps it off. Every rung has machine-checkable thresholds against the feature's own logged behaviour. A threshold met raises the feature to the recurring review, whose model decides; it never flips anything by itself. A fleet default stays a reviewed code change.

Its check column names the ladder, in 1.x today, and says 2.0's is still to be built.

### The map of existing differences

`docs/constitution-alignment-map.md` in instar: one row per article and rule, status `aligned`, `differs` (and how), `1.x-only`, `2.0-only` or `version-specific` (and why). Seeded from a full read of both books. A change declaring `none:` because it concerns one version updates its row: in the same PR in instar, or in a companion map-only instar PR when the change is in instar-2. The map is not code-owned, so the companion needs no tap. The review of that change checks it did; a `none:` that changes no obligation touches no row. It is a working document, not an authority, and is not a book. Nothing in it is checked by machine, because a status is a judgment; and an honest, editable list beats a hash ledger that certifies text identity and reads as if it certifies meaning.

The first full read (2026-11-03, one reader, to be re-read independently) found 93 1.x articles and 118 master rules plus 19 purpose rules: 49 aligned, 41 differing, 3 1.x-only, 26 master-only rows and 15 master-only purpose rules. Of the 41, 8 are clear conflicts and 10 are conflicts on one reading, for example who may block without the model, and when an audit is done. Until each is resolved the master governs, as the registry already says.

Genuine conflicts, where following one book would break the other, are classified by an independent review of the map, not by me alone. They go to Justin as one wording sheet after this lands, one paired approval for the set; a row he declines stays listed as `differs`. One-sided additions stay listed. Both are carried by one commitment with a re-surfacing cadence, registered at landing, not by the daily job, whose sessions fire only on new drift. <!-- tracked: commitment opened at step 1 of the landing order --> The rule says "no difference is silent", and this is what discharges it for the backlog. It does not claim the backlog is gone.

### Landing order, and what it asks of the operator

Merging is his only action, and an approval is dismissed by a push, so nothing is sent until nothing can push:

1. instar: script, safe-merge wiring, map, the guard document's correction, tests, and on landing the job and the backlog commitment. No registry change, so no tap; merges on green.
2. #2685 (the ladder) merges on green, as planned.
3. #2687 retargets `main`, gains the new article and the area audits for its two families (Shipping and The Fractal), and goes final.
4. instar-2 PR: Rule 119, Rule 72, the check, changelog, regenerated register, updated counts and pinned tests, review record. The rule book is written to be its own plain version, so it has no separate twin. Rule numbers re-checked against instar-2 #185 at this point.
5. Both PRs name each other. **Both links go in one message: two taps.**
6. Master merges first, then 1.x.

The direction guard is not a further prerequisite. `docs/STANDARDS-DIRECTION-GUARD.md` still says no key is installed and describes only the signature, but `scripts/standards-direction-guard.mjs` has a second path, `evaluateOperatorReviewApproval`: the repository owner's approving review on the exact head commit. #2682 landed with that review on 2026-11-04. Step 1 corrects the stale document.

## Decision points touched

| Decision point | Class | Justification |
|---|---|---|
| Refusal at the merge funnel when the declaration is missing or names no real counterpart | invariant | Existence only, against closed inputs: a line, a repository, a file list. Same shape as the Maturation Path plan gate. It judges nothing about meaning, which is why it may refuse. |
| Whether a stated `none`, or a claimed pairing, is honest | judgment-candidate | Floor: a reason is present. Arbiter: the independent review of the change, and the operator's review of the same PR. Default: a counterpart is required. |
| Whether the daily job spawns a session | invariant | Fixed classes over merge records. `unknown` is its own class, never clean. |
| Which map rows are genuine conflicts | judgment-candidate | Floor: every row carries a status. Arbiter: independent review. Default: listed as `differs`. |

## Standards raised by the conformance gate

*Signal vs. Authority:* the refusal rests on existence, not a judgment of content, so the brittle-check concern does not apply. Every question of meaning has only signal here and is left to a mind. The refusal is also cheap to clear: one line in a PR body.

*Self-Hosting:* not shipped to other agents because no other agent has two books. The obligation exists only while instar keeps 1.x and 2.0 side by side, and the job retires with 1.x.

## Symbols and states

| Check | Symbol | State claimed | Corroboration | Unmeasurable |
|---|---|---|---|---|
| PR check | Body line plus a counterpart's file list | A paired change exists | Independent review; his own review of both PRs | `unknown`, refuses at instar's funnel, red at instar-2 |
| Daily | Merge records of both PRs | Both changes landed | Text in both books, as read by a review | `unknown`, a separate class; the run reports failed |

Symbol present, state absent: a paired PR that changes something else in the other book, or a dishonest `none`. The review holds this and the script cannot; the spec does not claim otherwise. A body edited after merge could also mislead the daily read. Accepted: the actor is me, the edit is public, and the cost of defending it is out of proportion.

Positive control: before enabling the job, the script runs against the pre-baseline window, where #2682 and #2194 are real unpaired merges, and must report them as `drift`. That proves only the no-line class, since no older PR has a line. Test fixtures cover the other drift classes (a closed counterpart, a counterpart touching no book, past the window). The first enabled run records its counts in the PR.

## Failure modes

- **The agent removes or breaks the check.** Possible: instar's scripts and instar-2's `scripts/` are not code-owned, and the registry's own CODEOWNERS note says no check the agent writes can restrain the agent. What holds regardless is the code-owner tap on both books. This check is a seatbelt for the honest case, which is the case that has actually been happening: #2194 and #2682 went unpaired, by forgetting.
- **Merge outside safe-merge, or in instar-2.** Caught within a day by the daily job.
- **GitHub API down.** `unknown`, the PR re-runs, and only constitution PRs wait.
- **Echo's server down.** No daily run. The next run still catches everything, since it reads history from the baseline.
- **Unpaired during the window.** Allowed for up to 48 hours, because two repositories can't merge atomically.

## Cost

A paired rule change is two PRs and two taps, because the books sit in two protected repositories. Accepted. A `none` change costs one extra line and no added tap.

## Rollback

Disable the job and revert the safe-merge line. The rule and map are documents; removing the rule is a normal constitution change. No runtime or fleet state is touched.

## Multi-machine posture

Unified: repo-tracked text and GitHub as the only state. The job runs from Echo's job list under the scheduler's existing behaviour; a duplicate run reads the same records and repair reuses an existing counterpart through the search above.

## Migration parity

None needed. No config, hook or template reaches deployed agents. `scripts/` ships to the fleet and the script is inert there: `safe-merge` no-ops outside this repository and no other agent has the job. The new article ships as the registry does today.

## Frontloaded Decisions

1. Scope is by file path, not clause. Rejected a rule-by-rule hash ledger after review: it had unclosed clause gaps on both sides, needed a state machine for the merge window, made every ledger edit a tap, and invited reading text identity as meaning.
2. No request for a ruleset change. Requiring the check at GitHub would need his admin action in two repositories for a seatbelt the daily job already backs up. If the daily job ever catches a real unpaired merge in instar-2, that becomes the evidence to ask.
3. The master merges first, because it governs. Not enforced; the daily job sees the result either way.
4. Conflicts are not fixed inside this landing, so the rule itself doesn't wait on an unknown-size sheet.
5. The check's own text is approved through Rule 119's check column, so later script changes need no tap unless the rule changes.

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** not applicable: repository checks and one job on the instar-developing agent; no agent-class rollout.
- **dev-agent-live:** the job runs on Echo at landing.
- **fleet:** not applicable: not shipped to other agents.
- **graduation criterion:** the operator signs off the wording; the positive control reports #2682 and #2194 as `drift`; a deliberately undeclared PR is refused and a declared one passes, recorded in the PR.
- **dark-window:** none; live on merge.
- **ladder:** not applicable: no flag.
