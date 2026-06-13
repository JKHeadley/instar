# Upgrade Guide — Live credential re-pointing (Increment A, Step 5a)

<!-- bump: patch -->

## What Changed

Step 5a of the live-credential-repointing build, shipping **dark** — the two crash-safety primitives the swap executor (Step 5b) builds on. Nothing calls them yet, so there is zero runtime behavior change.

- `CredentialKeychainIO` — async, 10s-bounded `security` keychain read/write/delete (the swap must not use the synchronous credential store, which can wedge the event loop on a locked keychain). The credential blob is written via the `security -i` stdin form so it never appears in the process list. Defines the swap staging namespace `instar-credential-swap-staging-<swapId>`, provably disjoint from every real Claude credential service so a staged escrow copy can never be read by a client.
- `CredentialSwapJournal` — the durable in-flight swap record carrying the `swapId`, both slots, both pre-swap account ids, and the staging reference, so a crash mid-swap is fully decidable. A non-terminal phase keeps the staging escrow alive (it is the recovery heal source); only a completed re-verify marks the swap done and frees staging.

## What to Tell Your User

Nothing changes for you right now — this is more internal groundwork for the upcoming restartless subscription rebalancing, shipping switched off. This step adds the crash-safety machinery that will let a credential move survive a process restart or a power loss mid-move without ever stranding a login: an escrow copy is held until the move is confirmed good, and a durable record makes every interruption point recoverable. You won't see any difference until the feature is explicitly turned on.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Async bounded keychain I/O for the swap | Automatic (internal) — never blocks the event loop on a stuck keychain |
| Disjoint staging namespace | Automatic (internal) — escrow copies can never be read as a real login |
| Durable in-flight swap journal | Automatic (internal) — a crash mid-move is recoverable |

## Evidence

- 15 new unit tests (`credential-swap-journal.test.ts` 8, `credential-keychain-io.test.ts` 7): the journal's in-flight/terminal phase semantics + disk-reload recovery + idempotent restart; the staging-namespace disjoint invariant across many config homes; the async read null-on-error contract (cross-platform, no keychain write).
- `npx tsc --noEmit` clean; the credential-write lint clean (with `CredentialKeychainIO.ts` allowlisted as a primitive owner); closed-allowlist self-test updated.
