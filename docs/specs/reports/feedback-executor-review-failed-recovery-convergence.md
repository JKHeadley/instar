# Convergence Report — Feedback executor: a fix that failed independent review frees its slot and is reworked once

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI in all three rounds (each returned
SERIOUS ISSUES that were then resolved in the spec).

## ELI10 Overview

Instar's feedback builder writes fixes for reported problems and opens a pull request for each. An
independent AI reviewer checks every fix before it can merge. When the reviewer finds serious
problems, the builder used to just wait — and since it only allows four open pull requests, four
rejected fixes were enough to stop it completely. That is what happened on 30 October.

This change makes a rejected fix close itself after a day of grace (anyone can still push a fix,
approve it, or merge it by hand in that day), then gives the item one more try that starts from the
reviewer's findings, and parks the item if that also fails. Closing a pull request can be undone and
nothing is deleted.

## Original vs Converged

- The first draft closed the PR and then recorded why. Review showed a crash in between would park
  the item instead of retrying it, so the converged design records a close intent first, re-checks
  every condition before any retry, and finishes atomically, with a repair step that never overrides
  an operator's later decision.
- The first draft fed the reviewer's findings straight into the next build session's instructions.
  Those findings come from a model that read reporter-influenced text, so they are now scrubbed,
  written as a read-only data file, and excluded from anything the builder publishes.
- The first draft would have closed any PR it was pointed at; it now closes only a PR provably its
  own, and only for refusals about the change (an unreadable reviewer reply is asked again first).
- The off switch (grace 0) would have closed PRs after one hour because of a clamp; the range is now
  0–168 with 0 meaning "never close".
- Retry counting is tied to the item's current `work` decision, so a release or a return from hold
  starts a fresh episode, including for an attempt that was already open.
- The multi-machine section wrongly called the executor machine-local; it now follows the parent's
  owner-epoch model and states honestly that a close already sent to GitHub during an ownership move
  is reconciled by the new owner, not recalled.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | codex (3), internal (5 design + 8 precision) | 8 | 0 | crash-safe close order, scrub + data file, ownership check, which refusals close, episode reset, grace 0–168, pre-existing PRs, comment wording, multi-machine correction |
| 2 | codex (3), internal (2 design + 5 precision) | 5 | 0 | re-check before retry, atomic finalize + repair, publication exclusion, unparseable retry, episode from latest work decision, review-failed-twice counts as an episode |
| 3 | codex (2 design + 1 precision) | 2 | 1 | episode bound by decision id at close time; repair conditional on the same decision; honest ownership-move wording |

Standards-Conformance Gate: ran (0 flags) on the parent queue-pace review this session; not re-run for
this spec — unavailable for this spec's rounds, honestly recorded.

## Proportion

Tier 1 (small, reversible: one executor loop branch, a port method, store columns). 3 rounds used of
the Tier-1 cap of 3.

## Left behind

- A row whose reviewers were unavailable (`retry`) after a new push also holds its slot until a
  reviewer returns; the existing daily reviewer retry and degradation report already bound it.
  Accepted: not a safety, security or data-loss issue, and out of this change's scope.

## Full Findings Catalog

Round 1 (codex): close-before-record crash parks the item; multi-machine posture factually wrong;
retry lifecycle after resumption undefined; grace range contradicts rollback. Round 1 (internal):
grace 0 clamped to 1; findings unscrubbed; close/record ordering; no ownership check; which fail
reasons close; comment wording; episode reset; findings for pre-existing PRs; check position;
hold-reason wiring; `retry` rows. Round 2 (codex): stale intents ignore new pushes/approvals;
finalize not atomic; new data file not excluded from publication; comment dedup overstated. Round 2
(internal): non-serious fails still hold slots; episode field never reset by triage returns;
mergeRetryAt position; intent before CLOSED branch; grace-from column; meaning of "operator hold";
grace-0 wording. Round 3 (codex): attempt open across a release miscounted; repair could override an
operator's ignore; GitHub side effects not fenced by the database epoch. All design findings were
resolved in the spec; see the iteration table.

## Convergence verdict

Converged at round 3 (the Tier-1 cap). Every design finding raised was resolved in the spec; one
out-of-scope item is left behind with its reason. Spec is ready for approval.
