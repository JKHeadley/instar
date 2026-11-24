# How the offline benchmark combines two judge results

The benchmark uses two independent judge slots to assess whether an answer meets its written criteria. This offline prototype checks the frozen plan, rubric and source material. It then checks that each result belongs to the expected slot and attempt, so two valid-looking results cannot be swapped. A permitted timeout retry can fill the original slot and cannot add another vote.

The prototype records disagreement and keeps a critical failure visible when the second result is missing. Evidence that the judges finished before either saw the other's findings is reported separately. All of this is exercised with invented cases.

This branch is a checkpoint for review. It has no connection to live agents, model calls or rollout decisions. Before the benchmark can rely on the outputs, the host still needs to prove where its records came from and bind the receipts to the verified trial, comparison arm, repeat and scheduled slots. The focused test suite checks the mechanics. Complete repository verification remains pending.
