# Mutual SSH phase-1 independent security review

Date: 2026-07-21

Reviewer door: Claude Sonnet clean-door review, read-only against the implementation diff and approved specification.

Verdict: no critical exploitable paths. Two major defense-in-depth findings; both resolved before merge.

## Findings and dispositions

1. **MAJOR — host rotation verification was pre-verified at the caller.** The initial implementation passed an always-true verifier into `SshHostKeyLifecycle` after verifying the enclosing advert. Resolved by adding a distinct canonical host-transition payload and MachineAuth signature, validating it independently inside the lifecycle proposal gate. The enclosing advert also signs the transition signature.
2. **MAJOR — malformed proof timestamps could pass the pre-boot comparison.** `Date.parse()` can yield `NaN`, for which the comparison is false. Resolved by strict proof field/date validation before signature, boot, or freshness evaluation.

## Additional hardening completed during disposition

- Re-pair epoch advancement atomically clears prior admissions, sessions, adverts, host candidates, and both directional proofs.
- Pair health revalidates monotonic deadlines, live boot ids, and current client/host generations.
- Missing complete keypairs advance generations instead of reusing a prior generation.
- Planned host rotation serves the previous valid host key only during a bounded overlap and retires it after every peer proves the new generation or after ten minutes.
- Public `100/8` addresses are refused; only Tailscale CGNAT `100.64/10` is accepted.
- Invalid advert dates and non-array host-key fields fail closed.

The real Mini↔Laptop artifact remains the explicitly deferred phase-3 rollout evidence. It is not represented as completed by this review.
