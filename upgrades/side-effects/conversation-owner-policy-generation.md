# Side-Effects Review — durable owner PIN policy generation

**Date:** 2026-11-05
**Author:** review_storage_checkpoint_final (implementation owner for this change)
**Second-pass reviewer:** required; pending independent assignment

## Summary of the change

Security-sensitive Tier 2 checkpoint, driven by the owner-authority boundary in `docs/specs/conversations-owned-custody-redesign.md` and the explicitly assigned fresh-process restoration defect. No commit or release acceptance is asserted. Actual LiveConfig PIN writes first durably publish an independent fixed-cardinality HEAD, then atomically persist a server-generated UUID generation with the raw PIN field, fsync the file and parent, and throw on failure. A new disk-read policy helper supplies the current credential/generation pair. Supported vault PIN persistence reserves that durable generation before modifying the vault, then flushes the actual vault. The narrowly assigned PostUpdateMigrator PIN callback uses this same writer and preserves the generation through its later migration save. Config types/loading retain the metadata. Root owns the consuming grant/session authority, and the witness owner owns SecretStore durability.

Build location remains the parent-authorized isolated `feat/conversations-ui-1105` worktree, remote `https://github.com/JKHeadley/instar.git`, package 1.3.1668. This checkpoint has no commit/gate attempts. Focused fault and fresh-process tests are authored here; independent reread remains required.

## Decision-point inventory

- LiveConfig PIN write: modified; refuse caller-supplied generation and nested PIN edits, confirm durable complete pair before acknowledgement.
- Owner policy initialization: added; only explicit authenticated first-use caller invokes real LiveConfig initialization, preserving actual raw vault reference. A concurrent newer generation wins.
- Vault PIN writer: modified; configuration reservation failure prevents any vault mutation; flush failure takes existing plaintext fallback through the same durable writer.
- Grant/session acceptance: consumed by root-owned code; no authority is minted by reading configuration.

## 1. Over-block

Invalid generation, malformed PIN reference, missing secret, corrupt configuration, unsupported direct generation edits, and unconfirmed durable writes are refused. Legacy configured PIN with neither generation nor HEAD remains usable for actual PIN authentication but yields no grant policy until explicit first-use initialization. This intentionally prevents silently treating unknown policy as disabled. Unrelated LiveConfig keys retain their existing error behavior.

## 2. Under-block

This governs actual LiveConfig and supported persistDashboardPin writers, including the assigned migration callback. Raw whole-config replay cannot revive a retired generation because it cannot change HEAD. It does not claim arbitrary raw SecretStore.set callers or coordinated historical config/vault/HEAD/ledger rollback cannot occur. Same-process synchronous writers cannot interleave inside the atomic operation; independent OS processes modifying configuration without a shared lock remain a general configuration-writer constraint. A post-rename fsync failure can leave a new complete disk pair despite throwing; callers must treat the outcome as uncertain, never as an acknowledged rotation.

## 3. Level-of-abstraction fit

The durable generation belongs in the actual configuration PIN writer, where every supported secret-placeholder rotation can advance authority before secret mutation. The disk helper reads actual configuration rather than inventing a process counter. Root's grant evaluator remains the grant authority.

## 4. Signal vs authority compliance

Reference: `docs/signal-vs-authority.md`. These are hard structural credential/durability invariants, not semantic message detectors. UUID shape, exact raw PIN shape, atomic pair publication, and current generation correspondence are enumerable. No brittle content heuristic acquires conversational blocking authority.

## 4b. Judgment-point check

No static heuristic at a competing-signals judgment point. A credential policy must name one actual durable generation; generation is random metadata, never derived from the PIN.

## 5. Interactions

LiveConfig rereads disk before PIN writes to avoid stale cached fields, and restores cache on failure. Initialization does not overwrite a newer writer's generation; its caller must recompare the submitted PIN against the resulting current policy. Root owns that authentication hook. Vault reservation occurs before open/set/flush; a vault failure can require a second generation for plaintext fallback. PostUpdateMigrator copies the generation to its local object before its existing final save. No retry loop, notice, or feedback controller is added.

## 6. External surfaces

Persistent config gains dashboardPinGeneration. PIN writes can now fail explicitly instead of logging apparent success. No PIN is added to logs; watched PIN changes are redacted. No token/PIN/body hash is exposed as policy metadata. Existing dashboard PIN login remains the phone-completable action; this helper adds no independent operator route, URL, paid service, or dashboard form.

## 6b. Operator-surface quality

No renderer, approval form, or operator-surface markup changed in this ownership slice. Root owns the existing dashboard login integration.

## 7. Multi-machine posture

Machine-local BY DESIGN: an owner grant is scoped to the actual serving origin's credential authority and must not become valid merely because another machine has the same PIN. Generation is persisted beside that machine's actual dashboard PIN config, and the existing vault is used for its credential. This adds no pooled readiness verdict, status endpoint, notice, or URL. It is not replicated graph membership authority and does not change topic transfer ownership.

## 8. Rollback cost

A code rollback preserves the additive generation field but would lose the new restoration guarantee; it must not be presented as a safe equivalent. Restoring old grants requires actual reauthentication/new authority rather than resetting generation to a historical value. Failed writes may require retry or configuration repair; no success is returned before durability confirmation. No database migration is introduced.

## Conclusion

Author implementation checkpoint only. The original fresh-process revival motivated durable config coupling rather than an in-memory latch. Focused executable tests cover plaintext/vault A→B→A, policy-ledger failure, real fresh-process grant evaluation, config reservation failure without vault touch, vault flush fallback, initialization races, migration preservation, and unrelated config behavior. Independent security review and the parent release/feature gates remain open.

## Second-pass review

Pending. The author does not concur on their own implementation.

## Evidence pointers

- `tests/unit/conversation-graph-owner-policy.test.ts`
- `tests/unit/dashboard-pin-vault.test.ts`
- `tests/unit/PostUpdateMigrator-dashboardPinGeneration.test.ts`
- `.instar/state/build/owner-policy-final-focused.log`
- Original independent defect history: `.instar/state/build/review-bootstrap-owner-grants.md`

## Class-Closure Declaration

No prompt/hook/skill/standards-text defect and no self-triggered controller is changed; not applicable to that artifact class. Credential restoration regressions are executable runtime tests, not a claim that arbitrary full-state rollback is structurally impossible.

## Independent review correction — stale unrelated writers

The independent reviewer proved an unrelated LiveConfig write could republish cached PIN A/generation A after another actual writer durably installed B/generation B, when refresh metadata I/O failed. The author corrected every set path to merge only freshly parsed actual disk configuration, independent of mtime. Metadata/read/parse failure never publishes cached state. Ordinary writes retain log-and-return failure behavior; PIN writes throw. A previously observed configuration disappearing is refused rather than reconstructed as a blank authority. Genuine never-existing fresh configuration remains supported. Tests include two real LiveConfig instances and real fresh-process grant evaluation. This correction is still subject to independent reread, not author concurrence.


## Independent HEAD correction — whole-config replay

Fresh disk merges do not serialize unrelated raw whole-file writers. The new `DashboardPinGeneration.ts` primitive stores exactly one generation at `conversation-graph-owner-policy-head.json`, with no PIN or PIN hash. Managed PIN writes fsync HEAD and its directory before publishing config. Credential and policy reads require exact generation correspondence, even for the correct retired PIN. Config generation with missing HEAD, or HEAD with missing/mismatched generation, is quarantined and never automatically repaired from a legacy credential. First-use initialization rechecks both facts inside its actual writer. A privileged explicit managed PIN reset may mint a new generation. HEAD file reads reject leaf/inherited symlinks through the canonical state-root primitive and reject hardlinks; publication uses exclusive unique scratch and durable rename.

A failed HEAD barrier never publishes config. A successful HEAD followed by config failure revokes the old config and requires privileged reset/retry rather than accepting the old credential. Cross-process managed writers or raw config writers can cause an unavailable mismatch, but config-only replay cannot make retired grants current. This is fixed-cardinality independent revocation state, not an unbounded generation history and not a claim to survive coordinated full-state rollback. Root owns detecting HEAD presence at login/feature admission and routing quarantine correctly. No author concurrence is asserted.

### HEAD author verification

Normal Node24 setup completed 5 targeted files / 58 tests PASS, start 15:38:51, duration 27.13 seconds; `.instar/state/build/owner-policy-head-focused-final.log`. Includes real child raw full-config replay and separate fresh child credential/grant evaluation, legacy versus missing-HEAD quarantine, HEAD/config fault ordering, initialization race, existing vault/migration and unrelated-writer regressions. Earlier first HEAD run (56 pass / 1 failure) is retained at `owner-policy-head-focused.log`; the fault fixture compared a noncanonical macOS temporary path to the canonical HEAD destination, and was corrected to the actual destination. No guard override or test setup bypass. These are author checks, not independent concurrence.
