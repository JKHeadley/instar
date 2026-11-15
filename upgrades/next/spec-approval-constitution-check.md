<!-- bump: patch -->
## What Changed

A request asking the operator to approve a spec or design is now held until it carries its constitution check result. On Nov 15 a design spec reached the operator for approval before anyone had run the built-in constitution check on it: the spec was brainstormed and reviewed by hand, and the check only ran inside /spec-converge (Echo Bugs topic 10000002750).

- Every run of the built-in constitution check (`POST /spec/conformance-check`) is now recorded, latest result per spec, on the machine that ran it.
- Outbound message gate: a new rule, B25_SPEC_APPROVAL_UNCHECKED, judged by meaning on every reply and automated message (never health alerts), with no phrase pre-filter. It reads the recorded checks. A message asking the operator to approve a spec or design is held when it does not say what the check found, or claims a check that has no record. It is a hold, not a nudge: an acknowledgement cannot push it through. The way through is the agent's own: run the check, then send again with one line giving the result. Saying honestly that the check could not run, and why, counts as a result. Changes to the constitution itself are out of its scope.
- Work Board: an agent-written card or question asking the owner to approve a spec or design is judged by the same rule and refused with 422 and the way through. A person's own card is never judged. If the judge cannot answer, the card goes through and the miss is logged.
- Agent awareness: a new feature note tells agents to run the check before asking.

## What to Tell Your User

When I ask you to approve a spec or a design, the request now always says what the constitution check found. If I try to ask without it, my message is held until I run the check.

## Summary of New Capabilities

- Message gate rule B25 and a Work Board hold for spec and design approval requests without a constitution check result.
- The constitution check now keeps a record of each run.

## Evidence

- Unit: `tests/unit/spec-approval-constitution-check.test.ts` (ledger records latest per spec, names an unnamed design from its heading, bounded and recency-filtered, corrupt reads as empty; rule text both sides of the boundary; rendered on every non-health-alert review with the records exactly once, told when records are unavailable; B25 verdict is a hold and stays blocking under the advisory migration; Work Board judge holds, passes and fails open).
- Integration: `tests/integration/telegram-reply-spec-approval-check.test.ts` (real reply route: the founding ask reaches the gate with the rule and the ledger records and is held; an acknowledgement does not push it through; a request carrying its result is delivered). `tests/integration/work-board-routes.test.ts` (agent card and question held with 422; card with its result passes; a person's card is never judged; unavailable judge lets it through). `tests/integration/standards-conformance-gate.test.ts` (a check run writes the ledger).
