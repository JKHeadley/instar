# Evidence floor — convergence report

## Same-family independent reviews; cross-family review unavailable

Native reviewer /root/review_history and the installed Codex CLI reviewer gpt-6-astra are both GPT-family. The CLI returned successful reviews through existing installed authentication, with no prompt truncation. Its framework-relative crossFamily:true flag is not diversity from this native GPT author. No independent Claude/Gemini-family review or operator approval is claimed. Gemini was not installed. The configured CLI was detected after correcting the process PATH; an earlier missing-path probe was not a standing absence.

## ELI10 Overview

Features should not move up just because they run often or their latest numbers pass a threshold. Before a managed move, the system should find a real starting point and recent comparable results for that exact feature. If it cannot, the move waits and explains the gap. Existing running services stay available.

This proposal adds that requirement to the current feature-move operation, rather than inventing another approval service. The recurring reviewer still judges whether a move is wise. The numerical checks establish whether the promised evidence exists; they do not prove that the feature caused an improvement. Every first start pays the same floor because the current registry cannot guarantee that a start is side-effect-free.

## Original vs Converged

Review established that observations matching a supplied contract do not prove that the supplied contract is the feature's actual owner. The final design resolves the current owner independently and rejects collisions first. This found a real defect in the pending runtime collector: malformed generic metadata could be overwritten by a ladder definition. Three failing-then-passing collector cases and a real server-route test now cover the repair in runtime PR2847, commitc1732e435.

The final design keeps existing threshold/soak states readable and adds separate promotion eligibility. Old peers without that field remain unknown. Starts get no evidence exemption. Whole-view reads have a bounded shared budget and omitted candidates cannot inflate eligible counts. Source/ref/descriptor proof is distinguished from free-text method semantics. Existing parser rejection of duplicate subjects was inspected and tested; no duplicate registry is added.

## Iteration Summary

| Round | Review work | DESIGN | PRECISION | Result |
|---|---|---:|---:|---|
| 1 | Native independent six-lens review | 3 | 3 | Ownership, start policy and compatible eligibility DTO settled |
| 2 | Native six lenses and real installed CLI review | 1 | 1 | Native quiet; CLI identified malformed-owner collision and requested exact method-proof scope |
| 3 | Installed CLI with corrected collector/parser context, native six-lens final check | 0 | 3 | Converged; remaining items recorded below |

Standards-Conformance Gate: round1 ran,95standards,0flags,nondegraded,Observability parent fit. Round2 ran with the same95/0/nondegraded/fit result after design repairs. Round3 reused that same design report and inspected the parser/collector evidence; no conformance claim for unavailable or skipped output is invented. Reports and raw CLI output are retained in topic139374's evidence records.

## Proportion

Tier2 managed-move refusal; three design rounds against cap6. Four frontloaded decisions, no cheap-to-change exemptions. No enforcement implementation, user approval or deployment yet. The collector correction is a separate narrow Tier1 runtime repair; it does not activate the proposed floor.

## Left behind

These declared PRECISION items constrain implementation and acceptance; none is presented as an already-proven guarantee:

1. Define promotionEligibility as eligibility under all existing managed-move floors, with non-ready and terminal/composed rows not-applicable. Evidence-only qualification cannot inflate the headline. The detailed state mapping belongs with implementation tests.
2. Synchronous proof/write narrows this process's event-loop race only. It does not prove cross-process configuration serialization. Preserve the current expected-old-config checks and describe the existing writer boundary honestly; this proposal does not promise a new transactional configuration engine.
3. Add explicit integration assertions for missing/mismatched immutable archives and unavailable owner-census sources, in addition to successful-move proof. An observation projection alone is not an archive check.

These are implementation acceptance details of this spec, not separate untracked work. The original full-run obligations remain CMT-001.

## Full Findings Catalog

- Round1 SECURITY DESIGN: supplied-contract projection does not establish canonical ownership. Resolved with independent current owner/hash, conflict refusal and no parent/peer borrowing.
- Round1 DECISION-COMPLETENESS DESIGN: starts can enable live effects. Resolved by applying the floor to every managed start; no new safe-start exemption.
- Round1 INTEGRATION DESIGN: changing threshold-state semantics breaks existing consumers. Resolved with separate eligibility, conservative old-peer handling, headline/reviewer consumer updates.
- Round1 SCALABILITY PRECISION: whole-view bounded reads/memoization. Addressed in passing with64observation budget and explicit unknown omissions.
- Round1 ADVERSARIAL PRECISION: exercise real collisions and changed contracts. Added to acceptance; runtime collector cases reproduced and repaired.
- Round1 LESSONS PRECISION: keep services available and avoid universal enforcement claims. Explicit scope retained.
- Round2 CLI DESIGN: malformed generic owner omitted from valid-binding list; duplicate ladder-subject concern. Actual malformed-owner defect fixed on2847. Existing parseLadderRegistry subject-collides check and its parser regression test establish the duplicate guarantee.
- Round2 CLI PRECISION: method label is not raw-observation method provenance. Wording narrowed; current immutable hash and source/ref/descriptor identity are required, method meaning remains review.
- Round3 CLI PRECISION: eligibility mapping, cross-process serialization limit, archive/census integration assertions. Recorded above; no further design round needed.
- Round3 native six lenses:0newDESIGN/0additionalPRECISION beyond the same3items. Four decisions frontloaded;1invariant and2judgment-candidates classified, no open user design question.

## Convergence verdict

Converged after round3 with zero DESIGN blockers and three recorded precision limits. The proposal is ready for user review of the new managed-move evidence requirement. No approval has been applied. The existing24-hour run's remaining verification and deployment work continues separately.
