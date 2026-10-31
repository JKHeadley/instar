# Side-Effects Review — Desktop assertion clock skew

**Version / slug:** `desktop-assertion-clock-skew`  
**Date:** 2026-10-31  
**Author:** Echo  
**Approved spec:** `docs/specs/blocker-handoff-across-machines-and-surfaces.md`  
**Tier:** 2, security-sensitive replay admission repair

## Summary

A live laptop repeat begin returned `desktop-replay-invalid` even though the target's assertion verifier accepts up to two seconds of issuer clock lead. The replay ledger separately rejected any expiry more than 30 seconds from its own clock. The signed assertion has a 30-second intrinsic TTL, so a valid issuer clock lead produces an expiry up to 32 seconds ahead of the target. The code now shares the verifier's constants with the ledger and accepts that bounded case. A regression test reproduced the failure before the fix and passes afterward. No grant, stream, input, Stop, or PIN flow changes.

## Decision-point inventory

- `verifyDesktopOperatorAssertion` still validates the signed target-bound assertion, its intrinsic TTL, the issuer clock lead, browser binding, and JTI uniqueness. Its constants are exported; its decisions are unchanged.
- `DesktopAssertionReplayStore.record` still rejects expired, malformed, reused, and more-than-32-second-ahead entries and still fails closed on storage errors. Its maximum expiry bound now matches the prior verifier's admissible range.
- `AgentServer` still records the JTI before creating the delegated operator session. Any failed record still returns a denial.

## Side-effects questions

1. **Over-block:** Issuer clocks more than two seconds ahead remain refused by the verifier. A valid request within two seconds no longer fails at the ledger. It can still fail for host readiness or other existing policy reasons.
2. **Under-block:** The ledger can store an arbitrary caller-supplied expiry within 32 seconds, but the production caller only passes an assertion after signature, target, browser, and intrinsic TTL validation. A forged expiry cannot bypass that verifier. One-use and capacity checks remain.
3. **Layer:** Clock-skew admission is owned by the assertion verifier; the ledger's bound must align with it. Shared constants prevent a second policy diverging silently.
4. **Signal versus authority:** This is an authority boundary, not a detector. It uses the same already-approved two-second time window and cryptographic verifier rather than adding a new heuristic. It grants nothing on its own.
5. **Interactions:** JTI replay after process restart remains refused. The ledger's file size/capacity limits, atomic rename, and expiry pruning are unchanged. The target's active controller lock remains separate.
6. **External surfaces:** A previously intermittent valid request can now succeed. The browser sees no new prompt, token, error detail, or API shape.
7. **Multi-machine:** The verifier and replay ledger run on each target machine; the Studio front signs the request. The bound is independent of which transport carries it. Each target has its own durable JTI file, and the signed target machine ID prevents cross-target replay.
8. **Rollback:** Revert the bound and exported constants in a patch release. Existing ledger entries expire within seconds, so no state migration is needed. Reverting restores the intermittent refusal but does not expose a new authority.

## Evidence

Live failure: a bounded packet capture of Studio-to-Laptop traffic showed a target HTTP 403 `desktop-replay-invalid` while the target availability probe returned 200. The capture was deleted after extracting that fixed error. Unit regression: verifier accepts issuers 100 ms and exactly 2,000 ms ahead; old ledger rejected them; new ledger records each once, rejects reuse, rejects a 32,001 ms expiry, and verifier rejects an issuer 2,001 ms ahead. Build and focused unit tests pass. HTTP integration, production-boot E2E, CI, and live repeated laptop proof are required before shipping.

## Second-pass review

Astra reviewed the source and this artifact independently on 2026-10-31 and concurred, with no P1/P2 findings. The review confirmed that the 32-second ledger bound matches the verifier's existing 30-second signed TTL plus two-second issuer clock lead; it does not extend signed expiry or weaken replay protection. Astra suggested an exact 2,000 ms acceptance test, which is included. The review was source-based; live repeated-session proof remains a release check.
