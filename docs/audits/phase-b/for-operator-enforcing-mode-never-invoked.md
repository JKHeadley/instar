# For the operator's list — four checks whose enforcing mode is invoked nowhere

**Named for Justin's list at cycle four.** Companion to the two trust tests already queued.

## The finding, in one line

**Four lint scripts implement a `--strict` enforcing mode. The string `--strict` appears ZERO times in
any workflow, package script, or shell script in the repository.**

## Evidence

| lint | in CI? | enforcing? |
|---|---|---|
| `lint-degradation-emit-sites.js` | **not wired at all** | — (its own header: *"NEVER blocks"*, *"always exits 0"*) |
| `lint-machine-local-justification.js` | **not wired at all** | report-only by default |
| `lint-self-heal-fields.js` | **not wired at all** | report-only by default |
| `lint-no-unregistered-self-action.js` | wired | **report-only** — absent config yields `{enabled:false, dryRun:true}` |

**Control passed:** 12 workflow files reference **34 distinct lints**, so the search is sound and these
absences are real rather than a missed grep.

**Verified by execution:** all four exit 0 on the clean tree, and a broken input that each is designed
to catch was constructed for each — every one still exits 0 in its default invocation.

## What this is NOT

**Not a bug, and not an accusation of neglect.** Shipping report-only first is a deliberate,
well-documented rollout discipline in this codebase — the scripts' own comments describe the intended
graduation. The design is sound.

## What it IS

**Nothing tracks the flip.** There is no scheduled graduation, no owner, no date, and no invocation of
the enforcing path anywhere. From outside, a staged rollout with no graduation mechanism is
indistinguishable from an abandoned one — and the codebase already has a standard for exactly this
shape: *A Dark Feature Guards Nothing*.

> **An enforcing mode invoked nowhere is a guarantee that exists only in the future tense.**

## The decision this needs — and it is not mine

For each of the four: **graduate it, schedule its graduation, or record it as deliberately advisory.**
All three are legitimate answers. **What is not legitimate is the current state**, in which the answer
is unrecorded and the guarantee is assumed.

*(One of the four — `lint-machine-local-justification` — enforces the multi-machine posture rule that
the spec-converge reviewer already treats as a MATERIAL finding. Its advisory status and that
reviewer's blocking authority disagree about how load-bearing the same rule is.)*
