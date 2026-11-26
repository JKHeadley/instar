# Work Board owner lane projection

Tier 1 dark projection checkpoint. This diff introduces a typed input on the Work Board renderer and tests it. No production route supplies the input. The exact decision verifier and activation work require separate review before any live use.

1. Over-block. An unavailable verifier must not be represented as verified absence. Production wiring must preserve the known design and Instar App decisions.
2. Under-block. Without the new input, callers retain the existing lane and My Board behavior. A checked absent decision clears an approval-derived owner wait and an agent-owned mirror.
3. Placement. Derive lane and turn in the shared Work Board projection. The stored fold and execution path remain independent.
4. Signal and authority. The projection accepts a checked result from its caller. It cannot approve, decline, release, or pick up work.
5. Interactions. Preserve active owner questions, completion confirmations, terminal lanes, approval requirements, material hashes and pickup state.
6. External surfaces. This checkpoint adds no route or control. Future production wiring must check owner lists, detail, and My Board together.
7. Multiple machines. The upcoming binding verifier must fail on incomplete predecessor history. This checkpoint makes no peer completeness claim.
8. Rollback. Removing the dark parameter leaves the existing rendering path. No data migration or journal rewrite is involved.

## Account diagnosis in checked Needs You

The checked projection now rejects the account-status producer's explicit no-owner-action declaration before asking any approval provider. An approval-mode repair episode identifies a repair workflow. It supplies no owner assignment or verified in-place decision. This preserves agent/account diagnostics and the legacy Needs You path while blocking these diagnostics from qualifying as approvals under the checked contract.

## 6b. Operator-surface quality

The checked list continues to lead with its genuine in-place actions. Account nicknames, machine details and diagnostics stay on the existing Accounts surface. This change adds no destructive action or new wording at phone width. The existing first-screen suite passed.
