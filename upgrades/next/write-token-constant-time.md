# The state-submit write token is compared in constant time

<!-- bump: patch -->

## What Changed

SEC-123. `validateWriteToken` (used by `POST /state/submit`, where a secondary machine submits a state change) compared the presented write token with plain string equality, which can leak timing information. It now compares SHA-256 digests with `crypto.timingSafeEqual`, checks every stored token without stopping early, and skips malformed entries instead of throwing. The same tokens are accepted and refused as before.

## What to Tell Your User

- **Machine keys checked more carefully**: "The key my other machines use to send me changes is now checked in a way that does not leak anything through timing."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Constant-time write-token check | Automatic |

## Evidence

- `tests/unit/state-write-authority.test.ts`: the function body uses `timingSafeEqual` and no `.token ===` compare (fails on the old code); a token differing only in its last character is refused; malformed entries and a non-array store are skipped; a revoked copy listed before a live copy still validates. All 45 cases pass.
