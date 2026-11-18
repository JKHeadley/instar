<!-- bump: patch -->
## What Changed

Stage 3 of the frontier design and review standard (`docs/specs/frontier-design-review-standard.md`).

- New outbound rule `B26_DESIGN_APPROVAL_UNREVIEWED` (blocking, exempt from the advisory migration), beside B25: on a development agent, a message asking the operator to approve a spec or design is held unless it carries the review record line for the design as it stands. Code finds each record reference in the text and checks, from the review ledger, that the record exists, covers the file as it is now, and that its current line is in the text; the gate's judge decides whether the text is an approval request and for which design.
- The Work Board card judge applies B25 and B26 in one call; a B26 hold returns 422 `design-approval-unreviewed`.
- B25 and B26 share one definition of an approval request (`src/core/approvalRequestDefinition.ts`); B25's text is unchanged.
- `publish-spec-review.mjs` now puts the review line ("Review record for the full design, <title>: ...") and the constitution check result into the message and the rendered overview.

## What to Tell Your User

When your agent asks you to approve a plan or design, the request now always ends with one line saying which models wrote and reviewed it and what each found, written from the agent's own records. If the line is missing or the plan changed since it was reviewed, the agent is stopped and has to review it first. This is on for the development agent only for now.

## Summary of New Capabilities

- Rule B26 at the approval point (development agents), and both rules on Work Board cards.

## Evidence

- Unit: `tests/unit/designApprovalEvidence.test.ts`, `tests/unit/spec-approval-constitution-check.test.ts`.
- Live through a real Telegram test group on a throwaway agent: see the PR.
