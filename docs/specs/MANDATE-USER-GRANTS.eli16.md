# ELI16 — Coordination Mandate user→agent grants

## What this is, in one breath

The agent already has a tamper-proof "permission slip" system (the Coordination Mandate — a signed, audited document the operator issues). This change lets one of those slips also say "this specific Slack person is allowed to do this specific high-risk action" — signed in, so nobody can fake it.

## What already existed

A Coordination Mandate is a document the operator mints (behind their dashboard PIN) that says "these two agents may do these things until this date." It's HMAC-signed, so it can't be forged or widened by an agent, and every decision against it is written to a tamper-evident audit log. Separately, the Slack permission gate already had a slot — "is there an active grant letting this user do this floor action?" — but no real, signed thing filling that slot.

## What's new

1. **Grants live inside the signed mandate.** A grant says: *this Slack user* may do *this floor action* (e.g. a production deploy), until *this date*, authorized by *this operator*. Because the grant is folded into the bytes the mandate's signature covers, you can't bolt a grant onto a mandate without re-signing it — and only the PIN-gated path can re-sign. A faked grant fails verification.
2. **The gate reads those signed grants.** When the (dark) Slack gate sees a non-owner ask for a floor action, it now checks for a valid, signed, unexpired grant for that exact person and action. No grant → refused, exactly as before.

## The safeguards, in plain terms

- **Backward-compatible by construction.** A mandate with no grants is signed exactly as it was before this change, so every permission slip already out there (including the ones the agent shares with Dawn) keeps verifying. This was the #1 risk and it's covered by a test that signs a no-grant mandate the *old* way and confirms it still verifies.
- **Can't be forged.** A grant added without re-signing fails verification — proven by a "bolt on a grant without re-signing → must be rejected" test.
- **Can't outlive its slip.** A grant's expiry is clamped so it can never last longer than the mandate that carries it; expired or revoked mandates yield no grants.
- **Deny-by-default + audited.** No grant exists until the operator mints one on the PIN-gated route, and every grant decision (allow and deny) is written to the tamper-evident audit log.

## What you actually need to decide

Whether to merge the mechanism that lets your verified operator delegate a specific floor authority to a specific Slack user, signed so it can't be faked. It changes nothing until a grant is actually minted (PIN-gated), and the Slack gate that consumes it is still dark. It ships with an independent adversarial security review because it's signing/authority crypto.
