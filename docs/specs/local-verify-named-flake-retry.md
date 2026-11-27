---
title: Local Verify named failure retries
slug: local-verify-named-flake-retry
status: approved
approved: true
approved-by: Echo Chief of Staff, same-file proof approval 2026-11-26
parent-principle: Testing Integrity
eli16-overview: local-verify-named-flake-retry.eli16.md
review-convergence: "2026-11-26T19:32:28.781Z"
review-iterations: 5
review-completed-at: "2026-11-26T19:32:28.781Z"
review-report: "docs/specs/reports/local-verify-named-flake-retry-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
---

# Local Verify named failure retries

The existing verifier can rerun three whole files. Add a default-off named retry to the same isolation path. Admit at most three uniquely named failed assertions across one attempt. Identity combines the file path with the full test name. Duplicate names within the same file are ineligible, and the same name in two files consumes two slots. Quarantine has the same identity. Require a readable complete lane report, a reconciled list of failures attached to named test results, no duplicate full names, no file-level errors, and zero unhandled errors. Vitest reports a failure in a per-test hook against that test name. The retry exercises those same hooks, so this is an eligible named result. An error reported against the file or suite is ineligible. Keep the existing restrictions on files related to the change. The separate policy for import-related failures already corroborated on green main retains its stronger whole-file proof.

Run the exact names in the original file and composed checkout using an anchored literal Vitest name filter, isolated report paths, and the existing lane and total budgets. Every selected name must pass once, with no extra passing names, no failures or unhandled errors, and a clean exit. For a singleton, the filtered report must also expose exactly the original singleton inventory. An incomplete filtered inventory fails closed. For any file with at least two original test results, including skipped and todo results, also rerun the whole file on the same checkout. Require a clean result with the complete original assertion identities in the same order. Each failed assertion must become a pass, and every other assertion must keep its original outcome. If either proof fails, keep the original red verdict. For each proven failure, decrement failed and increment passed by one. Preserve the original test total, skip and todo counts, and unrelated pass counts. The existing verdict authority evaluates that report. Keep the original failure names and messages in the existing flake record and same-machine audit. No helper’s assertion or verdict grants local quarantine authority.

Reuse the existing confirmed-flake repeat window and deduplication. Three successful confirmations of the same named failure within seven days trigger quarantine. The first three attempts retain their independently proved verdicts. The third confirmation supplies the quarantine audit, and the exclusion applies to any later attempt that reads the active entry. Scaling the Test Line owns triage. In named mode, quarantine keeps the result red before either the ordinary or import-related recovery path can run. There is no fallback to legacy retry when named recovery is refused. The quarantine expires after seven days and never skips tests. A durable audit carries the file, name, reason, owner and evidence. Keep that disposition diagnosable and removable after repair. Scope the first activation to Echo, and measure the count of recovered attempts, confirmation file invocations, and repeat quarantine before broader activation.

## Decision points touched

| Decision | Type | Basis | Evidence |
| --- | --- | --- | --- |
| One attempt can retry up to three distinct failed assertions | invariant | basis: enumerable-domain | evidence: common attempt budget and signed record validation |
| The whole-file proof retains every original assertion identity and count | invariant | basis: enumerable-domain | evidence: ordered per-assertion identity and outcome digests, with a passing and skipped sibling swap red control |
| Unreadable quarantine prevents automatic recovery | invariant | basis: enumerable-domain | evidence: fail-closed retry input |

## Open questions

None.

## Maturation plan

- **ladder:** local-verify-named-flake-retry
- **test-agent-live:** Exercise the changed-inventory and swapped-sibling red controls, a clean recovery, live switch wiring and unreadable history.
- **dev-agent-live:** Enable on Echo after shared verification. Report recoveries and quarantines after 24 hours, with recovery share over all attempts with initial failures. Count whole-file confirmation invocations separately.
- **fleet:** Keep the fleet default off until the dev soak and review are complete.
- **graduation criterion:** Review the recovered share and quarantines. On a bounded comparable set, compare time cost and verdict disagreements with the existing whole-file retry. Require zero confirmed incorrect clearances and measured time cost acceptable to the test-line owners.
- **dark-window:** From merge until the Echo release is installed and the live switch is enabled.
