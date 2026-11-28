# Telegram Capacity Attribution Review

Authority: Chief of Staff message 9d7e7289-64ea-4005-b82c-0f3b97406f80 assigns attributable evidence and subsequent evidence-based repair under the existing post-mortem program. This review covers the attribution phase only. No source implementation or test has begun.

## Round 1

Standards-Conformance Gate: ran, 102 standards, 3 possible-violation flags (numeric-policy premise, mixed-version outage, document clarity); parent principle fit confirmed.

Six internal lenses were completed by three Codex reviewers. Security and performance were clean subject to evidence bounds. Adversarial, integration and decision reviewers found the same mixed-version outage; integration additionally found rollback orphan evidence and old-archive diagnostic loss. Decision reviewer required an exact evidence schema; lessons reviewer required installed-path proof. Real external reviewer ran through installed supported Codex CLI, model gpt-6.2-astra: SERIOUS ISSUES, covering mixed-version outage, caller-timeout versus owner-verdict ambiguity, and false expiry inference after cleanup. The author and external reviewer are both Codex-family; no model-family diversity claim is made, regardless of the wrapper's crossFamily field.

Changes: preserve identical legacy requests and optional explained response fields; no duplicate mutation/fallback; accept legacy explicitly unexplained; forward explanations through Runtime; separate caller observation/owner verdict and no-network proof; explicit predicate precedence; fixed field schema with absent stages and signed timing; separate table plus DB-owned delete cleanup and disclosed rollback diagnostic loss; owner-assigned isolated installed positive control and natural attempt observation. Existing capacity numbers remain inherited, unendorsed policy rather than newly justified thresholds.

## Round 2

Running against revised design. No convergence or source authority is claimed yet.

Round 2 completed: all six internal lenses reviewed revised design, then gate returned 3 flags (inherited numeric policy, sampling label, root-item follow-through). Internal integration/lessons engaged those flags. External review found remaining optional-response/evidence ambiguity, missing exact mapping and sample operands. Revised mapping and explicit schema followed.

Rounds 3 and 4 were external-plus-conformance prechecks, NOT full six-lens rounds. They count toward the six-round cap and are disclosed as incomplete internal review rounds. Round3 found known refusal versus lost-verdict and invalid-marker ambiguity. Round4, supplied with actual authority source, found new diagnostic lease reasons could inadvertently change retry scheduling; it also required consistent schema combinations and phase-valid explanations. Gate each ran 102 standards; inherited numeric policy, schema precision and document clarity flags were retained. The spec was rewritten to remove contradictory historical prose: exact existing scheduler reasons/timing remain unchanged, distinct diagnostic causes are separate stored fields. No source implementation proceeded from these partial rounds.

Round5 runs the complete review of the rewritten attribution-only design. The remaining capacity root cause is still unproven and will not be selected by changing inherited policy in this phase.

## Final capped result

Round5: six internal lenses completed. Security/adversarial/integration/performance clean; lessons required dated persistent follow-through, fixed by ACT-442. External found caller-expiry/owner-success ambiguity, null lease freshness compatibility, and optional SQL failure isolation; corrections were prepared before round6. Gate ran 102 standards with inherited-policy, follow-through and attribution flags.

Round6: six internal lenses completed and engaged live gate. Security/adversarial/integration/performance clean. Decision reviewer found one remaining DESIGN observability issue: evidence-only insert failure must be distinguishable from historical absent evidence. External MINOR ISSUES included a DESIGN acceptance-test specificity issue for mixed-version stored scheduler reason and two precision corrections (actual observed symptom, same-sample caller timestamp). Gate ran 102 standards, retained inherited-policy advisory and evidence-loss visibility flag. Prepared corrections add the existing fixed attempt-event unavailable status and archive/readback propagation, explicit mixed-version runtime scheduling assertions and same-sample timestamp. No source code, test, convergence tag or approval has been produced. Two earlier precheck rounds lacked internal lenses and are disclosed; this is not full convergence. A bounded operator closure is requested before any further review or source implementation.

## Operator-Delegated Bounded Closure

Chief b039c9e8 explicitly authorized one external and one internal check ONLY of the prepared final corrections at SHA2564dcaed23c2ee5f308917e971e8c8ca2d4ef1995e628ac0f275fa6c95fb4ce6ab. Both returned CLEAN: actual installed Codex CLI/gpt-6.2-astra and internal /root/n78_security_r1. No safety/data-loss defect remained within that scope. The closure covers unavailable-status/readback/archive, mixed-version stored scheduling assertions, and exact caller timestamp. Full convergence is FALSE. Subsequent frontmatter, ELI16 and maturation-plan additions record this authority and existing test/deployment obligations; they do not broaden the reviewed runtime design. No seventh broad review was run.

## Implementation Validation

Independent implementation review corrected and concurred with IPC phase validation, caller-close attribution, retention folding, additive trigger migration and cumulative metric preservation. The exact allocated 00759653 source/test candidate passed 86 unit, 20 HTTP and 18 lifecycle cases with no failures or skips. The supported startup-only check passed with CLI exit 0 and verified teardown. These checks do not convert this report into full convergence or certify live delivery restoration. Chief 2bcb2a19 authorizes normal PR handoff while a separate installed positive-control proposal remains to be approved.
