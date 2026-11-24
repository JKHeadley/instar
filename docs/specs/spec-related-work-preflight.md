---
title: "Check related work before spec review"
slug: spec-related-work-preflight
author: Echo
status: draft
---

# Check related work before spec review

The Chief of Staff drafted a redesign before checking the existing canonical project and discovery work. Justin asked “this seems to overlap with the one source of truth project. Is this true? Did you check?” The Chief of Staff relayed that request in the 13:07 Pacific handoff `39188fc1-1f7d-4fd2-b49b-e4ef95b24a52` and confirmed that the earlier search had been missed. The redesign now extends that project. Specs need a recorded overlap decision early enough to change scope before reviews begin. This extends the existing work-discovery design’s earlier-work requirement at the spec review entry point. It serves Structure Beats Willpower by making the prerequisite executable.

## Related work

```related-work-json
{
  "observedAt": "2026-11-24T21:10:00Z",
  "paths": [
    "skills/spec-converge",
    "src/server/specReviewRoutes.ts",
    "src/core/PostUpdateMigrator.ts"
  ],
  "keywords": [
    "convergence",
    "overlap",
    "work discovery",
    "prior work"
  ],
  "mergedDays": 2,
  "sources": {
    "open-projects": {
      "coverage": "partial",
      "evidence": "Both native project reads returned records. Chief handoff identified the redesign as the next phase.",
      "matchCount": 1,
      "matches": [
        {
          "ref": "Jobs and Projects",
          "decision": "extend",
          "reason": "Apply its earlier-work requirement at review entry."
        }
      ],
      "limit": "Reviewed the current project and related Chief effort. No complete status crosswalk across native catalog rows."
    },
    "open-specs": {
      "coverage": "partial",
      "evidence": "Claim check and repository search for the problem and entry paths, plus active designs named in the handoff.",
      "matchCount": 3,
      "matches": [
        {
          "ref": "Chief of Staff redesign",
          "decision": "extend",
          "reason": "Apply the new entrance to this design."
        },
        {
          "ref": "Project oversight draft",
          "decision": "extend",
          "reason": "Verify the real active-review case."
        },
        {
          "ref": "docs/specs/audit-convergence-enforcement.md",
          "decision": "reuse",
          "reason": "Use its artifact gate precedent."
        }
      ],
      "limit": "Keyword and header search has limited semantic recall and no reliable untracked-draft census."
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
      "limit": "Bounded PR list and file fields."
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
      "limit": "Bounded PR list and file fields."
    },
    "project-registry": {
      "coverage": "checked",
      "evidence": "Read the canonical local registry JSON directly. Its one agent row did not match.",
      "matchCount": 0,
      "matches": []
    }
  }
}
```

The private handoff and project evidence remain available to the authorized internal reviewer. The example records the actionable related work at a public-safe level.

## Proposed design

Require a top-level Related work section before any supported spec-convergence invocation dispatches reviewers. Use one deterministic preflight and validator shared by the cross-model runner, direct metered Gemini spec review ingress before spend or provider calls, and the convergence tag writer before tags. The same validated raw bytes must supply the review content and review hash. Keep diagnostic hash and provider detection callable. The skill invokes preflight before the constitutional check and any manually orchestrated internal reviewer calls. Inventory all other in-repo convergence launcher paths and route each supported convergence launcher through the validator. Leave standalone advisory constitution checks available. Internal convergence reviews are currently launched manually. The supported workflow runs executable preflight before launch and passes its digest and scope to the internal reviewer. The internal reviewer prompt must return an intake refusal without substantive review if the preflight result is absent or does not identify the spec being reviewed. This is prompt enforcement for manual internal launches. Direct executable entrances refuse the launch itself. Arbitrary ad hoc reviews remain possible. At the repo build guard, validate changed or new convergence stamps against the staged spec so manually typing new tags does not bypass intake. Existing untouched stamps remain usable.

Require structured source coverage for open projects, open specs, open PRs, recently merged PRs, and project registry. The author records a timestamp, positive merged time window and actual scope. Paths and literal terms describe the scope when applicable, and the problem description covers semantic searches. A source row states checked or partial and gives a nonempty coverage reason. Missing, unsearched, unavailable, and placeholder sources refuse review until retried or replaced with an equivalent authorized source. Partial results describe known limits and require substantive reviewer challenge. Require each of the five coverage rows exactly once, distinguish match count from coverage, and verify that the count agrees with the supplied match rows. A source may explicitly have zero observed matches after a successful search. Reject a zero count accompanied by a match. Every source row names the actual query or source receipt and a resolvable evidence reference. An audience-safe locator can point to restricted evidence. Human reviewers verify the evidence they rely on. The format gate cannot attest to the truth of hand-authored evidence. Partial coverage also gives the gap and its cause. A keyword-only result without a match must disclose that it found no literal match. Reviewers must check the problem and adjacent names semantically. The existing spec scan can silently skip unreadable files or miss draft status. The PR lists are capped and incomplete file data can hide matches. A registry fallback empty array is not proof of an empty registry. Require live coverage evidence or disclose these limitations. Require a stable reference, one of reuse, extend, or set-aside, and a nonempty reason for each observed plausible match. Reviewer prompts challenge missing plausible neighbors, scope, stale or capped results, and unsupported decisions. Before convergence, one internal reviewer independently checks a material match when present and searches for a plausible missed neighbor by meaning, and the report records the disposition and visibility limits. The validator establishes shape and disclosed coverage. Reviews establish whether the search and dispositions were adequate.

Reuse dev:claim-check with paths and keywords. It uses paths for PR coverage and keywords for specs, so a keywords-only invocation cannot supply PR coverage. Use authorized native open project and project registry reads. Use a paginated authorized lookup when a bounded claim-check list cannot cover the material search. Keep private IDs or project details in authorized evidence and reference them at a disclosure level suitable for the spec audience. The gate never fetches or uploads registry contents. Public or hosted-review inputs carry only audience-approved scope, coverage and references. An authorized internal reviewer inspects restricted evidence in its existing source. Restricted identifiers, titles, queries, counts and raw output stay out of public or hosted-review inputs. When required source evidence is sensitive, use an audience-safe problem and search description and a neutral opaque evidence locator resolvable by the authorized internal reviewer. Count only audience-safe match summaries. Record every restricted match and its individual disposition in the existing authorized evidence. A public match summary may use `restrictedDispositionRef` in place of `ref`, `decision` and `reason`. It points to the authorized record without exposing its count or decisions. A source containing such a reference is partial for the external review. Test mixed dispositions within one restricted group. Test that hosted input validates without raw private strings.

The section is one real level-two Markdown heading, with a single fenced `related-work-json` payload immediately below it. The JSON object includes `observedAt` (ISO UTC), `paths` and `keywords` (string arrays, at least one declared path or term unless a nonblank `semanticScope` is given), `mergedDays` (positive integer), and `sources` (five keys: `open-projects`, `open-specs`, `open-prs`, `recently-merged-prs`, `project-registry`). Each value has `coverage` (`checked` or `partial`), `evidence` (nonblank), `matchCount`, and `matches` (objects with `ref`, `decision` and `reason`). A partial source also needs a nonblank `limit`. The report can show the same data in prose. The scanner treats examples, quotes and HTML comments as non-evidence. Emit a source-specific error and point to a copyable example. The standalone preflight can return the reviewable body digest and checklist for both internal and external reviewers. Have every required reviewer result carry the digest from its launch. The overlap reviewer result also carries a completed check with the evidence scope and disposition. First-party runner responses are the review result source. Manual internal reviewers provide the native subagent result as report evidence with its invocation reference. The tag writer requires a completed report with each required result bound to the final digest and a recorded overlap disposition. The staged guard checks the committed report and the same digest and rejects mixed versions or a report with only a digest. This checks the declared evidence and does not authenticate author-supplied report text against deliberate forgery. It does not claim independent proof of reviewer identity from a Markdown report. Compute SHA-256 over the existing normalized reviewable body, excluding leading frontmatter so adding the stamp itself preserves the digest. Reject a subsequent valid-looking edit until reviewed. Derive prompt and request digest from a single validated read.

Validate the same bytes passed to a review runner. Revalidate edited rounds and before any new stamp. Existing stamps remain historical evidence. A new round on an existing spec requires the same section. The launch orchestrator passes the validator digest to each reviewer and discards results for superseded digests. Advisory checks remain available while a required source is unavailable. Retry the source or use an authorized equivalent for convergence. Sync the skill, reviewer templates and runtime scripts through the existing update migration so installed agents receive the enforcement through their ordinary skill entry. Update shipped copies in .claude, .instar and .agents, write the helper before its callers, and verify real parent containment. Preserve custom and redirected files. Use the package’s existing skills file inclusion or explicitly package the shared runtime module.

## Decision points touched

Refuse a new convergence invocation when required structure or attempted coverage is absent. Keep overlap and coverage adequacy a reviewer judgment. Passing the preflight creates no authorization to duplicate another project or change its records.

## Acceptance

Run the real review entrance with a missing section, skipped or failed source, empty placeholder, invalid disposition and fenced imitation, and verify the reviewer process never starts. Run it with real search coverage and no matches, and with real overlap and decisions. Verify that edits invalidate prior assumptions, diagnostic utilities remain available, the tag writer rechecks, and existing installed skills receive the same gate. Check a spec with partial coverage cannot present it as complete and reviewers receive a prompt to challenge it. Exercise the redesign and one unrelated spec on the development workflow before rollout.

## Open questions

None.
