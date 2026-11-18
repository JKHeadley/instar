---
title: Constitutional review throughout the bug-fix pipeline
slug: bug-fix-constitutional-review
author: Echo
approved: true
approval-kind: agent-engineering-authority
approval-source: "Justin standing constitution-only approval rule; topic 10000000001 message 2797 authorizes this implementation"
parent-principle: "Side-Effects Review Gate"
review-convergence: "2026-11-18T04:41:35.527Z"
review-iterations: 4
review-completed-at: "2026-11-18T04:41:35.527Z"
review-report: "docs/specs/reports/bug-fix-constitutional-review-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Constitutional review throughout the bug-fix pipeline

## Problem statement

Justin's report in Echo Bugs, topic 10000000001, message 2797 (2026-11-18T04:24:17Z),
authorizes extending constitutional review to small fixes as an advisory and keeping bug reports
focused on the observed problem. The preceding report proposed matching review-request phrases;
that unreviewed prescription could anchor the builder before independent design review.

The actual execution paths have two gaps. `instar-dev-precommit.js` takes its Tier-1 branch before
any constitutional review; `write-trace.mjs` does not run the existing conformance reviewer. The
feedback executor's independent review reads the diff and safety rules but no constitution.
The existing `/spec/conformance-check` grades the retained 1.x registry alone, although its opening
explicitly names the 2.0 purpose and rule book as the governing pair. A clean old-registry report
does not establish alignment with that pair. Echo's live bugs-overseer job lives on Mac Studio;
its fixer brief currently says to use instar-dev but does not require reviewing constitutional
findings or distinguish reporters' proposed remedies from evidence.

## Intended outcome and simplestRobustRoute

Use the existing conformance endpoint and the existing independent reviewers. Every development
trace runs an advisory constitutional review over its change, independent of tier. Every automated
feedback fix's existing safety reviewer receives the governing constitution and judges alignment.
No new approval authority, semantic phrase blocker, recurring monitor or operator approval is added.
This is the simplest robust route: instructions alone leave the demonstrated Tier-1 bypass, while
a new merge gate would duplicate an authority and contradict the requested warning-only behavior.

## Proposed design

### Governing context, shared by existing consumers

Vendor verbatim copies of `JKHeadley/instar-2`'s `docs/00-the-purpose.md` and
`docs/01-the-rules.md` at a recorded commit, with their source paths and SHA-256 hashes. They are
copies of governing text, not amendments. Their authority comes from protected main’s registry
designation of the master pair; preserve their status headers, including the purpose’s draft header,
without inventing an approval claim. Extend the existing build asset generator to package
them beside the registry. A shared loader validates the bundled source metadata and returns
either the complete pair or an explicit unavailable reason. Builds need no network. Updating the
copies is an explicit source change with a recorded upstream commit. A refresh/verify command
compares both copies with exact upstream bytes at a commit verified reachable from protected main; matching co-written hashes is only
package self-consistency. Independent landing review runs that verification for snapshot changes.
Extend the existing constitution-pairing script with a source-freshness read comparing the
vendored blobs with upstream; unrelated commits are not drift. Pool job inspection found no
currently enabled pairing-daily schedule. Therefore the existing live bugs-overseer job owns this
source-freshness read on its existing cadence and deduplicates refresh work in its existing ledger.
It refreshes through an ordinary source PR. No new recurring job. The existing job watchdog detects the overseer not running; its ledger
records last actual source-read time/outcome, with a missing or failed read remaining unknown.
This is deliberately a development-agent operational responsibility, not a fleet peer dependency.
A submodule would still pin stale bytes and add another runtime checkout dependency; no additional
CI network gate is needed for this advisory, since independent snapshot landing review verifies
current protected-main source and the running reviewer reports its exact version. Report source identity and
hashes; never describe a pinned bundle as a live fetch of the latest upstream constitution.

The existing conformance reviewer receives the complete purpose then rule book as trusted context.
It treats retained 1.x rules as subordinate. Missing or corrupt governing context produces a degraded
report, never an old-registry-only clean result. Existing standalone tests can inject trusted context.
Report findings may name master rules even if those rules have no old-registry article; preserve
them instead of silently dropping them as unknown old-registry names. Resolve cited master rule
identities against the bundled table/purpose declarations; preserve unresolvable citations as
explicit unresolved-citation signals, never as established obligations. Preserve whether a
purpose declaration is a Rule or a Value; a citation’s existence does not make a Value enforceable. Check content is data only;
source documents are trusted code-shipped inputs, never request-supplied constitutional authority.

### Every development tier, report-first

Add a small reusable script module with a preparation command before independent review. The
trace writer also calls it, reusing an unchanged report rather than re-running the model. One shared
subject builder assembles the complete substantive staged diff plus the spec when provided, otherwise
the ELI16. Omit and name generated trace files and the current side-effects review artifact (only
a Markdown path under upgrades/side-effects/): they are review outputs, not reviewed source, and
can never feed themselves back into review. Every other staged path remains included. Binary changes, submodules and non-UTF-8 inputs
produce explicit unavailable/unsupported-content with affected paths, never a false complete review. Use index
bytes for staged paths. No shell interpolation or execution
of content. Send these to the existing authenticated local conformance endpoint using the agent
home's config and the injected auth token (legacy string fallback only). Before sending, apply
the existing durable secret detector to the complete input. A secret match or unavailable detector
means explicit unavailable/sensitive-input and NO HTTP request. Screen retained/printed responses
too; never expose matched values. Do not redact incomplete input and claim complete review. The endpoint remains local;
an untrusted repository cannot select an external destination or credential source.

Do not silently truncate. If the complete input exceeds the complete prompt’s existing 256-KiB cross-model transport allowance (including the governing
pair and trusted instructions, replacing the conformance reviewer’s arbitrary 24,000-character slice), record
`unavailable: input-too-large`, surface the reason, and tell the existing reviewer to review the
whole change in its normal review. Make one request under the existing HTTP route’s 180-second
transport deadline, without an automatic retry loop; the agent may invoke again after repair.
Format the input without leading spec frontmatter, so this requests conformance only and never
the separate parent-fit model call. Missing server, authentication, context, timeout or invalid
response records explicit unavailability, prints a warning, and still writes the trace.

Cache the report by substantive input SHA, governing-source identity and checker contract identity
(prompt/parser implementation version and running package version) in existing worktree
build evidence. Store it in the existing trace and print every safe finding for the builder. Record outcome classes, including local failures, in the existing commit
decision audit; the existing bugs-overseer review reads every case when checking completion
and arranges independent assessment rather than treating absence as a pass.
For Tier 1, the normal SMALL build reviewer reads the report; where a narrow fix does not use
build, the existing bug-overseer completion reviewer reads EVERY trace and records its independent
assessment before calling the bug complete, not just unavailable cases. Tier 2+ retains its
independent spec and second-pass reviewers. Every such reviewer receives
the complete pinned pair, source/status identity and report. That reviewer assesses the actual change, records
its own conclusion and reasons, and explicitly cover any unavailable pass. A finding does not
become a veto, and an empty or absent report is never an alignment approval. The pre-commit path
surfaces absent/stale review evidence before its tier branch as a warning, without new blocking
authority. Review-output changes do not invalidate substantive input. A substantive source change
invalidates the cache and requires targeted review of the changed source and report. Unchanged
inputs never trigger another model call merely to record review evidence. Unavailable outcomes
are not reused as completed checks: a fresh invocation retries the same input after recovery.
Include the provider/model identity when available in report provenance and cache interpretation.

### Automated executor and problem-first intake

Extend the feedback executor's existing independent review prompt, for both fix and design heads,
with the same complete trusted governing context from the executor’s installed package, never
from the candidate PR. Its existing reviewers judge constitutional
alignment by meaning alongside safety. Source unavailability is disclosed in the prompt and audit,
and the reviewers may conduct their existing review; it cannot be represented as a completed
constitutional pass. Budget the ENTIRE assembled prompt against the existing cross-model
transport allowance: a 192-KiB diff plus the 94-KiB pair cannot be marked complete if it exceeds
that allowance. Oversize constitutional context is unavailable, with no truncation and no clean constitutional verdict;
on oversize, retain the original complete safety-only prompt and record constitutional context
unavailable instead of dropping existing safety coverage. If that original prompt itself exceeds
transport, the pre-existing incomplete-input refusal applies. No partial constitution is supplied. No new provider dependency or purchased service.

The reporter skill and executor brief distinguish observation, expected behavior, reproduction,
source and uncertainty from hypotheses. Reports do not prescribe an implementation. Preserve
proposals the user actually requested, clearly attributed as requests; a builder evaluates any
reporter hypothesis independently rather than treating it as an instruction or established cause.
Update instar-dev's Tier-1 instructions to require engaging the advisory findings and independent
constitutional judgment. Existing agents receive these built-in skill changes through an
idempotent allowlisted migration that preserves unrelated customizations. Add awareness via the
existing scaffold mechanism. Update Echo's live overseer brief with the same problem-first and
all-tier review instructions, preserving unrelated job settings and verifying read-back.

## Decision points touched

| Decision | Classification | Floor and arbiter |
|---|---|---|
| Whether a design conflicts with the constitution | judgment-candidate | Existing independent reviewer; advisory findings carry no authority, no keyword veto, no new operator ask |
| Whether a review input is complete and its source hashes match | invariant | basis: enumerable-domain; evidence: exact UTF-8 bytes and two named source files; missing input is explicit unknown |
| Advisory invocation lifetime | invariant | basis: external-constraint; evidence: existing HTTP middleware’s 180-second deadline; no second fit call |
| Existing merge disposition | judgment-candidate | Existing reviewer and safe-merge floors unchanged; this change adds context, never an independent merge authority |

## Multi-machine posture

Unified behavior ships in the package and built-in skill migration on every machine. Development
trace evidence travels with its commit through the existing trace staging path; automated review
evidence uses the executor's existing audit store and ownership. The replaceable worktree cache is not an authority: its report and identity travel in the committed
trace. No new durable state authority, peer dependency, pool monitor or status endpoint. Echo's local custom overseer job is updated on its
actual owning Mac Studio, not a dormant copy on the Mini. One-machine installations work fully.

## Team posture

Developer change content stays with the existing local authenticated reviewer and configured model
provider. No new team route, sharing grant, user data surface or permission widening. Reports stay
inside the existing repository/trace or executor audit audience. Member and guest rights are unchanged.

## Frontloaded Decisions

- This is an implementation of existing obligations, not a constitution amendment; agent approval
  follows independent convergence, with no routine approval request to Justin.
- Retain tiered development: small changes receive the advisory and independent review without a
  mandatory full spec. This change uses a spec because it changes the shared review pipeline.
- Prefer pinned, complete, offline source assets to network reads at build or review time.
- Keep existing authority and report unavailability honestly; do not invent an all-green substitute.

The existing instar-dev Phase-4 artifact still covers all eight side-effects questions and is
independently reviewed before shipping; this spec does not replace that artifact. The transport
allowance’s existing derivation is src/core/crossModelReviewer.ts:107–152 (fallback argv/ARG_MAX
reserve, not model context capacity).

## Tests and acceptance

Unit: canonical byte/hash integrity and missing/corrupt pair; source-aware prompt and finding
parsing; advisory response/error/timeout/oversize and no-credentials; problem-first executor prompt;
idempotent allowlisted migration preserving custom skills and delivering helper files to both
framework renderings. Include a real captured governing fixture. Test sensitive input makes no
request and never enters reports/output; co-edited source/hash fails upstream verification; initial,
repeated and review-output-only trace generations reuse the same input while source edits or
checker contract changes invalidate it. Binary changes remain explicitly incomplete. A matching
snapshot/hash at an unmerged upstream commit fails provenance verification. Test whole-prompt budgets with actual captured governing bytes.
Integration: actual trace script in an isolated git repository calls a local test HTTP endpoint for
Tier 1 and Tier 2, sees findings, preserves failures as unavailable, records exact input hashes,
and still writes traces. Exercise the existing conformance route with the canonical pair.
E2E: build assets are complete in installed layout; a real advisory request through the current
local server and a real independent review demonstrate what each consumer saw. Use the captured
withdrawn phrase-blocking proposal and a paraphrase as live negative cases, and an exact governed-state
comparison as their positive neighbor. Inspect constitutional discrimination and the independent
reviewer’s assessment, not just whether the HTTP call ran.
Run the required full test suite and repository checks. Verify the updated live overseer job by API
read-back. Record merge and deployment evidence separately; no completion claim from file presence.

## Rollback

Revert the code and skill changes, restore the exact saved overseer body, and ship through the
ordinary release path. Existing traces remain historical evidence; no state rewrite or deletion.

## Foundation limits

This does not certify all pre-existing gates. The full-spec parent-article requirement differs
from master Rule 49, and the executor’s mandatory dual-provider gate differs from Rule 118. File
these separately in feedback with their identifiers in the implementation review. Do not silently
expand this change into unrelated gate removals or claim these discrepancies resolved.

## Maturation plan

- **test-agent-live:** Isolated HTTP/lifecycle fixtures and captured-case conformance discrimination.
- **dev-agent-live:** Run the prepared advisory and independent review on Echo’s actual change.
- **fleet:** On by default through the ordinary package update and skill migration.
- **graduation criterion:** Full checks, source verification, real semantic consumer proof, independent concurrence and live overseer read-back.
- **dark-window:** None; existing development review correction, no new rollout switch.
- **ladder:** feedbackFactory.execute

A large source refresh can honestly exceed the whole-prompt allowance: preserve that unavailable
result and obtain the existing independent review using full repository access. Live semantic
cases still exercise the new route itself. Record merge and install evidence separately.

## Open questions

*(none)*
