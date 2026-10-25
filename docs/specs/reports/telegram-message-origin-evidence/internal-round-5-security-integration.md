# Round 5 — Security and integration/deployment review

These two perspectives were performed by the same reviewer who also wrote the round-5 adversarial/lessons artifact, covering for the reviewer performing the bounded browser feasibility investigation. They are separate perspective checks, not claims of four independent reviewers.

Inputs: current agent-home `docs/specs/telegram-message-origin.md`, prior round-3/4 security-integration reports, `conformance-round-5.json`, and fresh-main source grounding at `77df8be42a24a09d991b044027161c95eb9322a5`. Rechecked machine key rotation/revocation in `src/core/MachineIdentity.ts` and `src/core/IdentityStore.ts` in addition to the earlier browser, queue, ASP and gate inspection. No source/runtime edits.

## SECURITY perspective

**DESIGN: 0. PRECISION: 0.**

Session preparation credentials are scoped to a host/session incarnation and cannot edit preferences, enumerate audit history or authorize arbitrary destinations. Machine attestation binds the hidden tuple and complete operation; ASP remains the separate same-message authorship proof. Operator-only audit scope applies to IDs, filters, counts, pagination and peer requests. Rotation/revocation epochs have actual source authorities to reuse; historical verification keys/intervals remain an explicit retention obligation, not an assumption that the current registry already retains every proposed artifact.

The notice is a previously recorded fixed operation, preclaimed by one named process. Authenticated IPC cannot grant a second claim; uncertain notification acceptance cannot trigger resend. Current permission/ownership checks remain in force during the outage. Its exact body cannot become a vehicle for arbitrary unrecorded content. Independent reserve bounds avoid consuming all ordinary delivery slots.

The prior unsigned-content interval remains closed: unsupported operator-account forms are refused before content submission. Browser confinement remains a new, activation-tested capability within the declared trusted-runtime boundary; existing generic writable profile access must be removed or replaced before the transport can qualify as compliant.

## INTEGRATION/DEPLOYMENT perspective

**DESIGN: 0. PRECISION: 0.**

The prepared-evidence/sole-outbox distinction is consistent throughout the revised failure summary. New derived child materializations use bounded authorized inputs, durable sealing, existing child identity and fenced claims. Outbox redrive cannot collapse prepared chunks through stampede handling, erase a second origin through content-only dedup, mutate signed content or turn HTTP success/suppression into a platform receipt. Retained audit history is separate from queue cleanup.

The notification path explicitly bypasses only ordinary runtime claim acquisition because its special claim was durably acquired while healthy; it does not bypass recording or create another execution authority. The single-process IPC rule, no reclaim, no restart reuse and no retrying adapter calls name the relevant implementation seams. Process/network loss limits are disclosed.

Fresh browser evidence remains compatible with the draft: registry activation and MCP hooks do not already implement the broker, and current browser storage is not proof of an enrolled MTProto session. The new upstream-client feasibility spike, server-ID correlation, delayed/duplicate/concurrent-send controls and activation canary prevent a DOM-only implementation from claiming completion. An explicitly enrolled alternate transport is available if that spike disproves the Web path; silent transport conversion is forbidden.

Existing-agent migrations cover scripts, profile/config schemas, relay protocols, browser enrollment and awareness. Enabled incompatible writers refuse complete activation. Tests must still be run against real initialized dependencies and the claimed sender denominator before rollout; no such runtime result is asserted by this review.

## Result

Total: **0 DESIGN, 0 PRECISION**. Together with the preserved round-4 security/integration report, these are two consecutive design-quiet rounds for these perspectives. Overall convergence remains the parent review process's determination.
