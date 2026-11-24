---
title: "Check related work before spec review"
slug: spec-related-work-preflight
author: Echo
status: draft
---

# Check related work before spec review

The Chief of Staff drafted a redesign before checking the existing canonical project and discovery work. Justin asked “this seems to overlap with the one source of truth project. Is this true? Did you check?” The originating message was verified in the authorized Chief of Staff conversation. Internal evidence locator `evidence:spec-overlap-operator-message` resolves to that message. The Chief of Staff confirmed that the earlier search had been missed. The redesign now extends that project. Specs need a recorded overlap decision early enough to change scope before reviews begin. This extends the existing work-discovery design’s earlier-work requirement at the spec review entry point. It serves Structure Beats Willpower by making the prerequisite executable.

## Related work

```related-work-json
{
  "observedAt": "2026-11-24T21:10:00Z",
  "paths": [
    "skills/spec-converge",
    "src/server/specReviewRoutes.ts",
    "src/core/PostUpdateMigrator.ts",
    "src/server/geminiPaygRoutes.ts",
    "scripts/instar-dev-precommit.js"
  ],
  "keywords": [
    "convergence",
    "overlap",
    "work discovery",
    "prior work"
  ],
  "mergedLookbackHours": 48,
  "sources": {
    "open-projects": {
      "coverage": "partial",
      "evidence": "Both native project reads returned records. Chief handoff identified the redesign as the next phase.",
      "matchCount": 1,
      "matches": [
        {
          "ref": "evidence:147616-native-project-read/jobs-and-projects",
          "decision": "extend",
          "reason": "Apply its earlier-work requirement at review entry."
        }
      ],
      "limit": "Reviewed the current project and related Chief effort. No complete status crosswalk across native catalog rows.",
      "locator": "evidence:147616-native-project-read"
    },
    "open-specs": {
      "coverage": "partial",
      "evidence": "Claim check and repository search for the problem and entry paths, plus active designs named in the handoff.",
      "matchCount": 3,
      "matches": [
        {
          "ref": "evidence:147616-spec-claim-check/chief-redesign-v3",
          "decision": "extend",
          "reason": "Apply the new entrance to this design."
        },
        {
          "ref": "evidence:147616-spec-claim-check/project-oversight",
          "decision": "extend",
          "reason": "Verify the real active-review case."
        },
        {
          "ref": "docs/specs/audit-convergence-enforcement.md",
          "decision": "reuse",
          "reason": "Use its artifact gate precedent."
        }
      ],
      "limit": "Keyword and header search has limited semantic recall and no reliable untracked-draft census.",
      "locator": "evidence:147616-spec-claim-check"
    },
    "open-prs": {
      "coverage": "partial",
      "evidence": "Path-based dev:claim-check run on declared files.",
      "matchCount": 5,
      "matches": [
        {
          "ref": "#3718",
          "decision": "extend",
          "reason": "Preserve reviewer framework routing."
        },
        {
          "ref": "#3784",
          "decision": "set-aside",
          "reason": "Only shared migration wiring overlaps."
        },
        {
          "ref": "#3783",
          "decision": "set-aside",
          "reason": "Only shared migration wiring overlaps."
        },
        {
          "ref": "#3707",
          "decision": "set-aside",
          "reason": "Only shared migration wiring overlaps."
        },
        {
          "ref": "#3700",
          "decision": "set-aside",
          "reason": "Only shared migration wiring overlaps."
        }
      ],
      "limit": "Bounded PR list and file fields. Supplemental claim-check for the direct Gemini entrance and staged guard showed no path match.",
      "locator": "evidence:147616-pr-claim-check"
    },
    "recently-merged-prs": {
      "coverage": "partial",
      "evidence": "Two-day claim check and the prior authority foundation record.",
      "matchCount": 3,
      "matches": [
        {
          "ref": "#3744",
          "decision": "reuse",
          "reason": "Preserve the distinction between a failed search and a verified empty result."
        },
        {
          "ref": "#3742",
          "decision": "set-aside",
          "reason": "Preserve literal search behavior and its migration."
        },
        {
          "ref": "#3632",
          "decision": "set-aside",
          "reason": "Preserve unrelated hook reporting migration."
        }
      ],
      "limit": "Bounded PR list and file fields. Supplemental claim-check for the direct Gemini entrance and staged guard showed no path match.",
      "locator": "evidence:147616-pr-claim-check"
    },
    "project-registry": {
      "coverage": "checked",
      "evidence": "Read the canonical local registry JSON directly. Its one agent row did not match.",
      "matchCount": 0,
      "matches": [],
      "locator": "repo:.instar/project-registry.json"
    }
  }
}
```

The private handoff and project evidence remain available to the authorized internal reviewer. The example records the actionable related work at a public-safe level.

## Proposed design

Require a top-level Related work section before any supported spec-convergence invocation dispatches reviewers. Use one deterministic preflight and validator shared by the cross-model runner, direct metered Gemini spec review ingress before spend or provider calls, and the convergence tag writer before tags. Read the file once per launch. Use the canonical reviewer body derived from that read for both review content and intake hash. Keep diagnostic hash and provider detection callable. The skill invokes preflight before the constitutional check and any manually orchestrated internal reviewer calls. Inventory all other in-repo convergence launcher paths and route each supported convergence launcher through the validator. Leave standalone advisory constitution checks available. Internal convergence reviews are currently launched manually. The supported workflow runs executable preflight before launch and passes its digest and scope to the internal reviewer. The internal reviewer prompt must return an intake refusal without substantive review if the preflight result is absent or does not identify the spec being reviewed. This is prompt enforcement for manual internal launches. Direct executable entrances refuse the launch itself. Arbitrary ad hoc reviews remain possible. At the repo build guard, validate changed or new convergence stamps against the staged spec so manually typing new tags does not bypass intake. Compare the spec and its linked current report from the Git index against the base blobs. The current report is the repository-relative path in the staged spec’s `review-report` field. A report-only staged edit must validate against every current stamp pointing to that report. A historical report is one with no current stamp pointing to it and remains editable as history. Evaluate the previous stamp class in the shared validator so index transport does not decide policy. A legacy stamp is historical only if the base had no intake digest and the staged convergence claims remain unchanged. Deleting a digest from a previously bound stamp cannot restore legacy status. It requires fresh review or removal of the convergence status claims. A digest-bearing stamp validates on any staged edit of its spec or report, even when the stamp lines themselves are unchanged. Remove current convergence claims when saving an unreviewed edit. Keep the old report as history. Refuse it as current until the changed body is reviewed.

Require structured source coverage for open projects, open specs, open PRs, recently merged PRs, and project registry. The author records a timestamp, positive merged time window and actual scope. Paths and literal terms describe the scope when applicable, and the problem description covers semantic searches. A source row states checked or partial and gives a nonempty coverage reason. Missing, unsearched, unavailable, and placeholder sources refuse review until retried or replaced with an equivalent authorized source. Partial results describe known limits and require substantive reviewer challenge. Require each of the five coverage rows exactly once, distinguish match count from coverage, and verify that the count agrees with the supplied match rows. A source may explicitly have zero observed matches after a successful search. Reject a zero count accompanied by a match. Every source row names the actual query or source receipt and a resolvable evidence reference. An audience-safe locator can point to restricted evidence. Human reviewers verify the evidence they rely on. The format gate cannot attest to the truth of hand-authored evidence. Partial coverage also gives the gap and its cause. A keyword-only result without a match must disclose that it found no literal match. Reviewers must check the problem and adjacent names semantically. The existing spec scan can silently skip unreadable files or miss draft status. The PR lists are capped and incomplete file data can hide matches. A registry fallback empty array is not proof of an empty registry. Require live coverage evidence or disclose these limitations. Require a stable reference, one of reuse, extend, or set-aside, and a nonempty reason for each observed plausible match. Reviewer prompts challenge missing plausible neighbors, scope, stale or capped results, and unsupported decisions. Before convergence, one internal reviewer independently checks a material match when present and searches for a plausible missed neighbor by meaning, and the report records the disposition and visibility limits. The validator establishes shape and disclosed coverage. Reviews establish whether the search and dispositions were adequate.

Reuse dev:claim-check with paths and keywords. It uses paths for PR coverage and keywords for specs, so a keywords-only invocation cannot supply PR coverage. Use authorized native open project and project registry reads. Use a paginated authorized lookup when a bounded claim-check list cannot cover the material search. Keep private IDs or project details in authorized evidence and reference them at a disclosure level suitable for the spec audience. The gate never fetches or uploads registry contents. Public or hosted-review inputs carry only audience-approved scope, coverage and references. An authorized internal reviewer inspects restricted evidence in its existing source. Restricted identifiers, titles, queries, counts and raw output stay out of public or hosted-review inputs. When required source evidence is sensitive, use an audience-safe problem and search description and a neutral opaque evidence locator resolvable by the authorized internal reviewer. Count only audience-safe match summaries. Record every restricted match and its individual disposition in the existing authorized evidence. A public match summary may use `restrictedDispositionRef` in place of `ref`, `decision` and `reason`. It points to an immutable authorized evidence revision without exposing its count or decisions. Changing a private disposition requires a fresh opaque revision reference in the spec and an internal review of that revision. A source containing such a reference is partial for the external review. Test mixed dispositions within one restricted group. Test that hosted input validates without raw private strings.

The section is one real level-two Markdown heading, with a single fenced `related-work-json` payload immediately below it. The JSON object includes `observedAt` (ISO UTC), `paths` and `keywords` (string arrays, at least one declared path or term unless a nonblank `semanticScope` is given), `mergedLookbackHours` (finite positive duration, permitting fractions), and `sources` (five keys: `open-projects`, `open-specs`, `open-prs`, `recently-merged-prs`, `project-registry`). Each value has `coverage` (`checked` or `partial`), `evidence` (nonblank), `locator` (a repository-relative `repo:` path, a public HTTPS reference, or a private `evidence:` key resolvable by the authorized reviewer), `matchCount`, and `matches`. A match has either `ref`, `decision` and `reason`, or a sole `restrictedDispositionRef`, never both shapes. An opaque group counts as one audience-safe match. A partial source also needs a nonblank `limit`. The report can show the same data in prose. The scanner treats examples, quotes and HTML comments as non-evidence. Emit a source-specific error and point to a copyable example. The standalone preflight can return the reviewable body digest and checklist for both internal and external reviewers. Have every required reviewer result carry the digest from its launch. The overlap reviewer result also carries a completed check with the evidence scope and disposition. First-party runner responses are the review result source. Manual internal reviewers provide the native subagent result as report evidence with its invocation reference. The tag writer requires a completed report with each required result bound to the final digest and a recorded overlap disposition. The shipped convergence skill policy supplies the required internal roles and existing eligible external-family skip rules, never the report being checked. Materialize that policy in a checked-in role table shared by the writer and staged guard. The staged guard checks the committed report and the same digest and rejects mixed versions or a report with only a digest. This checks the declared evidence and does not authenticate author-supplied report text against deliberate forgery. It does not claim independent proof of reviewer identity from a Markdown report. Use one byte transformation for every reviewer: decode UTF-8, normalize CRLF to LF, and remove a valid initial YAML frontmatter block and its delimiter line. Preserve all other bytes, including indentation, trailing whitespace and Markdown blank lines. Hash the exact UTF-8 body the reviewer sees. An indentation change that turns prose into a code block changes the digest. Exclude leading frontmatter from both substantive reviewer input and intake digest so stamping preserves it. Transport paths and the Gemini request’s existing full-file binding are independent of the intake digest. Strip only at the final reviewer boundary after verifying the input file and transport binding. Test that a frontmatter-only change either affects no review input or is refused when it invalidates the transport binding. Reject a subsequent valid-looking edit until reviewed. Derive prompt and request digest from a single validated read.

Validate the same bytes passed to a review runner. Revalidate edited rounds and before any new stamp. A stamp records the related-work evidence as observed at its recorded time. Require a new search on a new review invocation or known material change in related work. Before stamping the current invocation, review the search time and refresh a source if delay, known new activity or an updated scope makes the prior read unreliable. Refreshes edit the evidence and require reviews of the resulting body. A PR opened after a valid stamp does not invalidate that historical attestation. Existing stamps remain historical evidence. A new round on an existing spec requires the same section. The launch orchestrator passes the validator digest to each reviewer and discards results for superseded digests. Advisory checks remain available while a required source is unavailable. Retry the source or use an authorized equivalent for convergence. Sync the skill, reviewer templates and runtime scripts through the existing update migration so installed agents receive the enforcement through their ordinary skill entry. Update shipped copies in .claude, .instar and .agents, write the helper before its callers, and verify real parent containment. Preserve custom and redirected files. Use the package’s existing skills file inclusion or explicitly package the shared runtime module.

## Decision points touched

- Refuse review when the five source decisions are missing — invariant; basis: enumerable-domain; evidence: the requested workflow names five required evidence classes and a no-match result is meaningful only for a checked class.
- Adequacy of a covered search — judgment-candidate. Floor: a usable source record for each class and honest limitations. Default: broaden narrow or stale searches. Arbiter: independent overlap reviewer. Fallback: retain the evidence gap and amend the search before requesting convergence.
- Accept convergence as current — invariant; basis: irreversible-consequence; evidence: the stamp enables behavior changes through the repository development gate and must not certify a different spec body or missing reviewer role.

## Maturation plan

- **test-agent-live:** Use an isolated checkout and injected reviewer and spend fakes. Launch the real scripts and direct route. Verify refusals precede provider work and a complete evidence fixture can enter review. Verify staged digest removal, body-only edits, report-only edits, and migration in disposable installed agent homes.
- **dev-agent-live:** Run the ordinary review workflow on the Chief redesign and one unrelated spec with an authorized reviewer. Confirm refusal diagnostics lead to a usable evidence record, source coverage is honest, the reviewer checks the related-work decisions, and staged reports bind the reviewed version.
- **fleet:** Ship only after the development-agent proof and update migration tests. Review cases where reviewers find overlaps after intake or a required source regularly prevents review.
- **graduation criterion:** In the two development cases, every supported executable route refuses malformed intake before provider work and every valid review carries an independently checked decision. Installed skills load the same validator. Manual reviewer actions that have no intake evidence cannot count as convergence.
- **dark-window:** Exercise disposable and development entry points before release. No live migration during this draft review.
- **ladder:** Existing development workflow qualification. No user runtime or persistent feature enrollment.

## Acceptance

Run the real review entrance with a missing section, skipped or failed source, empty placeholder, invalid disposition and fenced imitation, and verify that executable entrances start no reviewer or provider request. Verify an intake refusal with no substantive findings if an internal reviewer receives an invalid manual invocation. Run it with real search coverage and no matches, and with real overlap and decisions. Verify that edits invalidate prior assumptions, diagnostic utilities remain available, the tag writer rechecks, and existing installed skills receive the same gate. Check a spec with partial coverage cannot present it as complete and reviewers receive a prompt to challenge it. Exercise the redesign and one unrelated spec on the development workflow before rollout. Review recurring records of material matches independently found after intake, denied starts by source, and overlap found too late to change a design.

## Open questions

None.
