# Upgrade Guide — Live credential re-pointing (Increment A, Step 5b)

<!-- bump: patch -->

## What Changed

Step 5b — the `CredentialSwapExecutor`, the piece that actually MOVES a credential between two config-home slots, shipping **dark**. Nothing calls it until the feature gate is enabled, so there is zero runtime behavior change.

`swap(slotA, slotB)` exchanges (never copies) the two slots' Claude credentials under the single-mover mutex + both per-slot funnel locks, journaling every destructive step so a crash mid-swap is recoverable:
- staging escrow (a COPY of the source blob to a disjoint namespace, so a crash before the first exchange write is a no-op);
- a source-slot re-read immediately before the write that adopts a newer client-rotated blob rather than overwriting it with a stale one;
- verification on ACCOUNT IDENTITY via the read-only oracle (never on token bytes), where an UNREACHABLE oracle quarantines the slot and stops — it never triggers a destructive repair (the single most dangerous ambiguity, handled fail-closed);
- a confirmed identity mismatch repairs once from the known-good blob, then quarantines if still wrong;
- staging retained until a delayed (~90s) re-verify confirms both slots, which catches an in-flight client refresh that lands just after the move.

Boot-recovery of an interrupted swap is the next step (5c).

## What to Tell Your User

Nothing changes for you right now — this is the core of the upcoming restartless subscription rebalancing, still shipping switched off. This is the machinery that will let me move an account's login from one slot to another without a restart and without ever risking the login: it keeps a safety copy until the move is verified, it checks the move landed on the right account before trusting it, and if it can't be sure, it quarantines that slot and tells you rather than guessing. You won't see anything until the feature is explicitly turned on, and even then the worst-case failure is a single "please re-log-in" with the right account named — never a silent breakage.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Staged, crash-safe credential swap | Automatic (internal) — not callable until the feature gate is enabled |
| Identity-verified move (quarantine if unsure) | Automatic (internal) — an unverifiable slot is excluded, never trusted blind |
| Adopt-on-newer source re-read | Automatic (internal) — never overwrites a freshly-rotated login with a stale one |

## Evidence

- 8 new unit tests (`credential-swap-executor.test.ts`): happy-path exchange + ledger update + staging freed on clean re-verify; precondition rejects (same/unknown/quarantined); the §2.3.4 oracle-unavailable→quarantine-NOT-repair invariant; confirmed-mismatch repair-once-then-quarantine and repair-succeeds paths; staging-is-a-copy (slot untouched on a failed exchange write); §2.3.1a adopt-on-newer; single-mover serialization.
- `npx tsc --noEmit` clean; full `npm run lint` clean; 231 credential/oauth/quota/account-switcher tests green.
- Independent second-pass review (the highest-risk file in the increment) — verdict recorded in the side-effects artifact.
