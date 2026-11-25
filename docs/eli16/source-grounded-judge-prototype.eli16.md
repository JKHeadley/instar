# How the offline benchmark combines two judge results

The benchmark uses two independent judge slots to assess whether an answer meets its written criteria. This offline prototype checks the frozen plan, rubric and source material. It then checks that each result belongs to the expected slot and attempt, so two valid-looking results cannot be swapped. A permitted timeout retry can fill the original slot and cannot add another vote.

The prototype records disagreement and keeps a critical failure visible when the second result is missing. Evidence that the judges finished before either saw the other's findings is reported separately. All of this is exercised with invented cases.

This branch is a checkpoint for review. It has no connection to live agents, model calls or rollout decisions. The prototype now checks receipts against the trial, comparison arm, repeat and slots scheduled in the frozen plan. Before the benchmark can rely on the outputs, an integrating host still needs to prove where its records came from and provide an independently held plan digest. The composed check verifies that the judge schedule comes from the same plan whose bytes were checked. The focused test suite checks the mechanics. Complete repository verification remains pending.

## Read-only check with the real validator

A synthetic cross-worktree check combined this prototype at `65ef00f5` with the separate offline validator candidate at `e32c94417`. It exercised the frozen plan, scheduled judge receipts, a timeout retry, exact output binding, actual structural validation, consensus and disclosure timing. The intact case kept the disputed critical result visible. Withholding a cited source was rejected by both the plan check and the real validator. Wrong-slot output was rejected while the intact judge's critical finding remained visible. Early disclosure was recorded separately as an independence breach.

This check ran against two clean worktrees with an invented fixture. The branch's composed automated test still uses a validator stub. A durable integration test can use the real validator once both candidates share an integration base. Live receipt authority and model delivery require their own evidence.

An adjudication result is recorded beside the original critical finding. A missing, conflicting or invalid resolution leaves the finding unresolved. A recognized resolution still requires a separate host decision before the evaluation can qualify.

When a reference is defective, the prototype checks that its replacement has a new version and covers every run in the host’s frozen affected list. Rerunning only one arm leaves coverage incomplete. Coverage and approval of the corrected reference are separate decisions.

To repeat the check, run `node scripts/evaluation/source_grounded_real_validator.check.mjs PATH_TO_VALIDATOR_WORKTREE` from the judge branch. Use the trusted local validator checkout at `e32c94417` with its locked dependencies installed. The command imports the validator code and its authored fixture from that explicit path. It uses Node with TypeScript type stripping available. This is a focused cross-worktree check.

A missing judge receipt leaves its original slot empty. The other judge’s critical finding remains visible even though the pair is incomplete.

Each critical finding needs its own host-issued identity before an adjudication can be recorded. This prevents one receipt from resolving two findings that share a criterion.

The offline composition selects each retry once and uses that same selection to bind the output and check disclosure timing. An earlier attempt cannot stand in for a missing selected output.

Each judge slot’s retry limit now comes from the verified plan. A more permissive limit supplied with attempt records has no effect. The repeatable check also calls the composed flow with the real validator.

A rerun also has to match the original case, submission, comparison arm and repeat. Reusing an affected run ID does not make an unrelated benchmark result count.

The report distinguishes an empty scheduled slot from a selected attempt whose output is missing. A rejected or missing output does not erase the other judge’s critical finding.

Schedule checks begin with the verified plan bytes. Callers cannot pass a separately parsed plan in place of those bytes.

Matching output bytes are insufficient when the captured output belongs to a different comparison arm or repeat. The binder checks both fields before accepting a judge result.

The offline flow now assigns each critical finding an identity tied to its exact bound judge attempt. Two judges who fail the same criterion still produce separate findings.

The finding identity also includes the verified plan. A resolution from an earlier rubric cannot clear a finding recorded under a new plan.

The judge flow checks the plan fingerprint on each terminal attempt record and on disclosure evidence. A receipt from a different plan cannot supply a vote.
