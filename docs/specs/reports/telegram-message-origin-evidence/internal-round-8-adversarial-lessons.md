# Round 8 — Adversarial and lessons-aware review

Reopened the current spec and checked the changed canonicalization, transport sealing, notice-variant and browser activation/alternate-transport contracts against the prior full-spec and source review. Verified body SHA-256 after removing frontmatter: `c56608dbb5d510c46283856de1b59624e13bb0f06691cb8b9af4a17903d836ec`. `conformance-round-8.json` reports 90 standards checked, zero findings, not degraded, and a passing registry canary.

## ADVERSARIAL perspective

**DESIGN: 0. PRECISION: 0.**

The new notice variants preserve the original single-use boundary: all permitted display combinations are already durably sealed under one child and one preclaim. Current effective bits select existing bytes; they cannot re-render content, change destination/origin labels, mint another claim or revive a consumed permit. Disabled display shares the no-footer variant. The combined byte cap covers all variants, so multiplicity cannot bypass reserve accounting. Destination policy, mute/archive/deletion and opt-out still determine whether a notice may fire; changing only cosmetic display no longer silently withholds it. Other processes remain IPC requesters, never alternate owners.

The JCS profile fixes primitive serialization and invalid-input handling while preserving the existing exact text/entity and string-ID rules. The prior transport-boundary precision finding is resolved: Bot API HTTP seals its body bytes; Web K seals RPC method/arguments before provider encoding/encryption, with semantic mutation prohibited. Golden-byte/digest fixtures remain required.

The alternate MTProto activation path preserves operation/random IDs and outcome-unknown holds, so a failed browser canary does not authorize a fresh uncertain send under another transport. Authenticated enrollment and real receipt correlation remain prerequisites. No new design defect was identified.

## LESSONS-AWARE perspective

**DESIGN: 0. PRECISION: 0.**

The fixed notice no longer promises automatic delivery after an outage whose duration might exceed the original operation deadline. Its text describes current paused delivery, and the existing bounded payload/deadline contract remains unchanged. Selecting among finite pre-recorded variants restores notification behavior under cosmetic preference changes without creating an unrecorded exception.

The explicit activation criteria and defined MTProto alternate engage the external-state drift and self-recovery lessons while distinguishing a named feasible seam from proof of an authenticated live send. No profile login or completed delivery is assumed. The prior distinctions between same-host spool redundancy and peer fallback, clock assumptions and observed synchronization, diagnostic supervision and delivery authority remain intact. No optional expansion or new operator policy decision is required by this review.

## Result

Total: **0 DESIGN, 0 PRECISION**. This is a design-quiet round for these two perspectives; aggregate convergence is determined by the parent process and the other review results. No source/runtime changes or external messages.
