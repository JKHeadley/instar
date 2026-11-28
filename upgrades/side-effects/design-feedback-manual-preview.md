# Optional Manual Feedback Preview: Side Effects

## Summary

Adds an explicit --feedback option to the manual design inspection command under the approved design-standard-enforcement spec. Default output remains unchanged. Reads complete committed feedback corpora on pinned BASE and HEAD and composes the reviewed entry and history checks.

## 1. Over-block

Only an explicit manual invocation is affected. Feedback structural errors become namespaced findings with exit 1. Invalid policy remains invalid; operational refusals return unavailable and exit 2. No automatic gate or application approval is changed.

## 2. Under-block

Source authentication, publication privacy, owner presence, semantic reductions, gate-miss evidence and real feedback-card binding remain unevaluated. The command does not activate complete feedback lint or provide merge authority.

## 3. Level-of-abstraction fit

Reuses the existing bounded immutable Git reader and reviewed feedback composer. No separate parsing policy, source-message verifier or card authority is introduced.

## 4. Signal vs authority compliance

mergeAuthority, sourceVerification and publicationPrivacyReview remain false. Observations affect only this manual command's findings and exit code.

## 4b. Judgment-point check

No competing-signals heuristic is added. Structural findings are deterministic; semantic review and permissions remain outside this command.

## 5. Interactions

Both trees are pinned before reads. Recursive listings must be complete, bounded to 2,000 records per tree and 4 MiB. Existing 30 second deadline, 2 MiB blob and 16 MiB aggregate output bounds apply. Nonregular entries and unsafe paths are unavailable; unexpected ordinary filenames produce path findings without content reads. Existing audited executor writes may occur. No target code executes.

## 6. External surfaces

New optional CLI flag and generated awareness text; no route, message, network request, stored approval or configuration. Feedback output includes filenames and identifiers without echoing source-message header prose, owner quotations or image bytes. The overall command still retains changed rule wording for review. This is not a privacy clearance claim.

## 7. Multi-machine posture

Reads explicit committed objects through existing executor isolation. Unsupported Git or missing policy yields unavailable. No machine-local proof is transferred as authority.

## 8. Rollback cost

Revert the flag, reader composition, awareness and tests. No migration of stored state is needed. Awareness uses the existing generation and update path.

## Verification

Four new real Git cases failed before implementation, then all 19 integration tests passed. All six actual packaged CLI lifecycle cases passed and were independently replayed. TypeScript emission passed. Three independent reviewers gave qualified concurrence. Full verification remains owned by the normal throughput queue; no full-suite, merge or release result is claimed.

## Class-Closure Declaration

Defect class unbounded-self-action, closure n/a: explicit manual invocation owns finite Git children under an existing deadline; no timer, self-trigger or retry controller is introduced.

Artifact second-pass: boundary reviewer confirmed scope and limits; wording was narrowed to distinguish feedback header prose from the overall command's intentional rule-wording evidence. No material finding.

## Update 2026-11-27 (after merging the updated inspector and main)

The command change now lives in `src/commands/designInspect.ts`, the name the inspector gave its command file so it matches the command people type; git carried it there in the merge. The git fixture (`tests/fixtures/designPolicyGitRepo.ts`) commits only DF-0001, so it now commits the live standard and rule-id lock trimmed to DF-0001's rules (`tests/fixtures/designStandardForEntries.ts`); before that, main's newer entries made the feedback cases fail with `earned-entry-missing`. Checked directly on the merged tree: the fixture's plain inspection stays structurally valid with no findings, and the feedback path returns no errors. On the real repository, `--feedback` reports DF-0002, DF-0003 and DF-0004 until they are migrated to the canonical entry format; the Chief of Staff chose that interim on 2026-11-27 (each now has a tracked commitment for its card) rather than exempting them. The verification counts above are from before the merge and are re-run with the stack's test turn.
