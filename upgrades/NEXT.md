# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Two fixes ship together here.

**Operation-safety gate action vocabulary and fail-closed hardening.** The external operation-safety gate emits a proceed action for allowed operations, but the generated guard hook and the docs described the allowed action as allow and only branched explicitly on the block, show-plan, and suggest-alternative cases — so proceed was permitted only by falling through, and an unrecognized action would slip through that same silent path. The hook now permits proceed explicitly (keeping allow for backward compatibility) and blocks any unrecognized action instead of letting it pass, and the docs and generated guidance now use the real vocabulary. This is a safety tightening: an unknown gate decision now fails closed.

**Commitments follow-up contract guidance.** The generated Commitments guidance described creating follow-up promises with a type the server actually rejects and omitted a required field. Agents now record follow-up promises as one-time-action commitments that include both the user request and the agent response before marking them delivered, matching the live contract.

## What to Tell Your User

- **The operation-safety gate is stricter now**: when I check whether an outside action is safe, an allowed action is now handled on purpose rather than by accident, and anything the safety check does not recognize is blocked rather than waved through. How existing approvals and blocks work is unchanged.
- **Commitment follow-through is more reliable**: when I register a future follow-up for myself, the built-in guidance now uses the same wording the server actually accepts, so the reminder can be created and closed cleanly.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Operation-gate fail-closed on unknown actions | Automatic. The generated operation-safety hook now blocks any unrecognized gate decision instead of permitting it, and treats the allowed action explicitly. |
| Operation-gate vocabulary alignment | Automatic. Docs and generated guidance now match the action values the gate actually emits. |
| Commitments follow-up contract guidance | Automatic for newly generated or migrated agent guidance. |

## Evidence

- Operation gate: unit (ExternalOperationGate and hook-installation), integration (operation-safety routes), and e2e (action-vocabulary lifecycle) tests cover the explicit-permit, legacy-compat, and block-unknown paths; the docs, templates, and spec were aligned to the real vocabulary.
- Commitments: live lifecycle verification created a test commitment, inspected it, delivered it, and verified it was terminal and closed; focused unit, integration, and e2e tests pin the accepted create payload, delivery transition, active-list closure, generated guidance, and PromiseBeacon stop behavior.
- Note: the operation-gate change merged to main first, but its release notes were dropped during a rebase across a release-cut, so it is released here alongside the commitments guidance fix.
