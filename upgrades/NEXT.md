# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

PR 7 of the tunnel-failure-resilience chain. This is the security cleanup that makes the backup-tunnel feature safe to use: whenever a backup relay episode ends, the agent now rotates your dashboard PIN and access token.

**Why it matters.** While a backup relay is active, your dashboard traffic — including the PIN and any private view links — briefly passes through a third-party operator's machines. PIN rotation alone is not enough: the private view links are signed with your access token, so a copied link would keep working forever unless the token itself changes. This release rotates both. The moment the backup ends, the old PIN stops working and every previously-shared private view link becomes invalid.

**Where it triggers.** Every terminal exit from a backup relay episode rotates: an operator stop/shutdown while the relay was up, and — most importantly — boot-recovery. If the agent died mid-relay-episode, a flag persisted to disk causes rotation to run on the next boot **before the server accepts any API traffic**, so a relay operator who saw the old credentials can't use them against the freshly-started server.

**How it takes effect immediately.** The auth layer now reads the token live on every request instead of capturing it once at startup. So rotation invalidates the old token and old signed URLs instantly, with no restart. Existing behavior is unchanged when no rotation happens.

## What to Tell Your User

- If a backup tunnel was ever used, you'll get a private message with a fresh dashboard PIN once it's no longer needed. Any open dashboard tab will ask you to sign in again with the new PIN.
- Any private view link you shared while the backup was active will stop working — that's deliberate, so the backup operator can't reuse it.
- If nothing ever falls back to a backup, you'll never see any of this; normal operation is unchanged.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Credential rotation on relay-episode end | Automatic — fires on stop/shutdown and boot-recovery whenever a backup relay was in use; new PIN arrives in the owner DM |
| Live auth-token resolution | Automatic — the server now honors a rotated token immediately, no restart |

## Evidence

- Spec: `specs/dev-infrastructure/tunnel-failure-resilience.md` Part 6. Side-effects: `upgrades/side-effects/tunnel-credential-rotation.md`.
- Tests: `tests/unit/auth-middleware-live-token.test.ts` (5) asserts both sides of the rotation boundary — the old bearer token AND an old HMAC-signed view URL are rejected the instant the live token changes, and a URL signed with the new token works. `tests/unit/tunnel-credential-rotation.test.ts` (6) asserts the lifecycle: relay-active→idle rotates, a non-relay stop does not, a thrown rotator leaves the pending flag set for retry, and a fresh manager restores the flag and rotates on boot-recovery.
- No regression: 75 auth + tunnel tests pass, including the existing string-form auth-middleware suites (the refactor is backward compatible).

## Rollback

The middleware change is backward compatible (it still accepts a plain string). Revert = restore the string argument at the AgentServer auth callsite, drop the manager rotation methods and the `stop()` trigger, and remove the server.ts rotator closure + boot-recovery call. No config schema or persistent-state migration — a rotated PIN/token is just a new value.
