---
title: "Check related work before spec review"
slug: spec-related-work-preflight
author: Echo
status: draft
parent-principle: "Structure beats Willpower"
approved: true
approved-by: "Echo, binding-scope review and Chief decision, 2026-11-24"
review-convergence: "2026-11-24T21:19:32.549Z"
review-iterations: 6
review-completed-at: "2026-11-24T21:19:32.549Z"
review-report: "docs/specs/reports/spec-related-work-preflight-convergence.md"
related-work-review-sha256: 7d9717e656e9a68ada2ff9dcad794a0eba57be9970e91e8f31678de52868f67c
cross-model-review: "codex-cli:gpt-6.2-astra"
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

The related-work preflight accepts an evidence JSON file and prints a ready-to-paste Markdown section. The author collects evidence using the existing claim check, searches for related projects and open designs, and consults the project registry. The generator performs no network or registry reads. The single validator checks the generated section at the convergence tag writer and checks the same section again in the Git index at the existing implementation commit gate. Internal and external reviewers can start as they did before. Chief explicitly selected enforcement at binding time. Run preflight early to avoid wasted reviews. The reviewer templates ask the independent reviewer to challenge search scope and reuse decisions before the report is approved.

The section has exactly one real level-two heading followed by a fenced `related-work-json` block. The sample above is the accepted format. Each of the five sources appears once. The author records observation time, scope, a positive PR lookback, coverage, evidence and an evidence locator for each source. Incomplete source coverage requires the limitation. An unavailable source without usable evidence cannot supply a completed result. A successful search can explicitly record zero observed matches. Every match has a stable safe reference, a reuse, extend or set-aside decision, and a reason. A restricted group may use one opaque, revision-specific disposition locator. Its individual matches and decisions stay in the existing authorized evidence. Those rows require partial coverage and count as one public-safe match.

Preflight can print the SHA-256 of the normalized spec body alongside its validated evidence. Record that digest as `related-work-review-sha256` in the convergence report from the version sent for review. The stamp writer checks that report digest against the current spec after validating the section, then records it in frontmatter. For commits that already require a converged spec, the implementation gate requires both valid related-work evidence and the matching stamp digest on the staged spec. Normalize CRLF to LF and remove only the leading YAML frontmatter. A body edit requires another stamp after review. Existing history is preserved. Existing specs used for newly gated implementation must add the evidence and be re-stamped. The existing lightweight exemptions remain. The prior approval requirement remains. A valid shape or digest attests to record presence and byte identity. Reviewers assess evidence and decisions. An independent reviewer already authorized for private evidence verifies opaque locators. Hosted reviewers receive only the safe section and disclose their visibility limit. A literal-only miss is labeled no-literal-match and cannot stand in for a semantic check. An authorized equivalent source can cover the same evidence class if the replacement is explicit. No new claim of cryptographic review identity is made.

Reuse the report and independent reviewer prompts already in use. Update the installed built-in skill text, reviewer templates, validator and tag writer through the existing migration path.

## Decision points touched

- Require the five related-work sources — invariant; basis: enumerable-domain; evidence: the agreed five evidence classes are a complete list of the required checks.
- Judge coverage and reuse — judgment-candidate. Floor: usable evidence and disclosed gaps. Default: broaden uncertain searches. Arbiter: the independent reviewer. Fallback: amend the evidence and review again.
- Accept the implementation stamp — invariant; basis: irreversible-consequence; evidence: the development gate uses convergence and approval to admit a code commit, so the staged body must carry the same evidence the writer stamped.

## Maturation plan

- **test-agent-live:** Exercise generator, actual stamp writer and commit gate with complete and missing evidence, a fenced imitation, edited staged spec and opaque restricted dispositions. Check migration in a disposable installed skill.
- **dev-agent-live:** Exercise the Chief redesign and one unrelated spec through normal development review. Confirm the reviewers can resolve the evidence and that the commit gate rejects a changed spec.
- **fleet:** Ship through the usual development tool update after proving installed migration.
- **graduation criterion:** Both enforcement doors reject invalid or absent evidence. The commit gate verifies the stamped body in the index. Reviewers challenge a seeded duplicate.
- **dark-window:** Test in a checkout before update. The migration changes development files only.
- **ladder:** Existing development workflow, with no production runtime enrollment.

## Open questions

None.
