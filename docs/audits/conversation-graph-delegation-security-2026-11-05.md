# Conversations delegation security checkpoint

> Historical checkpoint from 2026-11-05. It does not describe the current state; see `upgrades/next/conversation-graph-core-increment-a.md` and the side-effects notes under `upgrades/side-effects/conversation-graph-*` for that.

Spec: `docs/specs/conversation-effort-hierarchy-v3.md` §7.2 and §8.1. This checkpoint implements source verification and tests. It does not certify Increment A, expose Increment B, or claim an installed fleet spawn hook.

## Authority and canonical core

`ConversationGraphDelegation.ts` captures actual persisted local running parent/worker sessions only after independent bootstrap capabilities, live adapter conversation bindings, registry descriptors, active machine identity and original signed FencedLease verification. A generic HTTP bearer is never parent ownership. The immutable source holds no prompt, title, bootstrap HMAC secret or token.

`ConversationGraphDelegationRemote.ts` separates requester, successful worker and admitted writer. The requester proves its actual local running parent, binding and active session ownership, and signs an expiring narrow request. The actual original recipient-bound `MeshEnvelope` carries that request at `deliverMessage.payload.graphDelegationRequest`; the signed mesh `messageId` equals sourceId. Target capture verifies original mesh signature, recipient, epoch, payload, durable worker binding and current ownership epoch before signing its own attestation. The admitted writer checks owner-signed membership, both original signatures, source lease, current WriteAdmission and FencedLease bridge, session ownership and project scope before independently signing its accepting dispatch receipt.

Both paths emit only exact `set-primary-placement` / `delegates-to` / authority `delegation` cores, containing typed NodeRefs and no titles. `canonicalHash` from GraphWitnessTypes is the sole core hash. Core receipt kind/id bind to the verified accepting receipt. Existing owner heads or import/inference heads produce a suggestion; delegation cannot override them. Proposed state is never represented as committed or Saved.

Historical proof verification pins original source signing keys through the owner-signed membership. New admission separately requires the current epoch. Source replay reuses immutable fsynced capture/proposal; a corrupted cached accepting signature is refused. Target `readCaptured(sourceId,membership)` recovers the original signed completed source after session completion without inventing a fresh attestation.

## Root production wiring obligations

Local capture runs after successful spawn **and** persisted actual topic/adapter binding. Derive sourceId from the real durable spawn/dispatch record. Parent identity comes from the verified bootstrap token, never a claimed session header. Root may mint a worker token internally from the actual successful child bootstrap binding; never return it to the caller.

Remote requester `createRequest` precedes signed actual transport. Retain the original `MeshEnvelope` and invoke target `attestSuccessfulSpawn` after successful child spawn and binding. Forward the signed source unchanged to the currently admitted writer, which invokes `ConversationGraphRemoteDelegationIngress.prepare`. The target never exports a portable HMAC secret, and the writer never signs as the source machine. Root must supply real session ownership projection/CAS state and trusted adapter binding lookups, not an always-true verifier.

Feed the resulting exact core, generic authorization proof and encrypted original source to the witness/replication coordinator. Freeze packet/bundle/idempotency; final acknowledgment requires witness commitment and final certificate receipts from every installed member. This checkpoint does not install that callback in central server/routes code.

## Source inventory

These opaque records must participate in source repair/retention/erasure inventory:

- `state/conversation-graph-delegation-sources/*.json`
- `state/conversation-graph-delegation-prepared/*.json`
- `state/conversation-graph-remote-delegation/<hash>.request.json`
- `state/conversation-graph-remote-delegation/<hash>.completed.json`
- `state/conversation-graph-remote-delegation/<hash>.prepared.json`

The replication source bundle preserves `{source: originalSignedSource}`. The generic authorization proof includes dispatchSource so replication can independently reject a missing/forged dispatch source. No opaque source is a substitute for an erasable display header.

## Evidence (Node24, 2026-11-05 ~02:20 PST)

- TypeScript noEmit: pass.
- Local source unit suite: 14/14 pass.
- Remote source security suite: 5/5 pass. Uses three real machine identities, persisted sessions, actual registry/bootstrap binding, ownership records and signed mesh transport. Covers bearer-only refusal, wrong worker binding, recipient/payload mutations, ownership epoch change, source forgery, owner protection, extra plaintext core refusal, immutable recovery and corrupted persisted receipt refusal.
- Local + remote integration: 2/2 pass. Each traverses actual encrypted source bundle, real member stores and production witness HTTP routes; absent members prevent commitment, absent final certificate receipts prevent acknowledgment, restart decrypts the exact original source, missing dispatch source is refused.
- Store-retention, state-registry and destructive-operation lints: pass.
- Independent root UI/chat review rerun: model10 + DOM5 + neutral chat3 + authenticated real adapter ingress5 pass. Prior shared Slack command and More navigation regressions fixed. Private Telegram fixture uses actual DM addressing. Root's authorized source-history forwarding rechecks proof/readiness/source after the read.

The witness integration uses loopback test fixtures. It does not prove an external failure domain, real fleet RPC/spawn callback, actual CLI hook, live browser/device behavior, or complete Increment A. Keep Increment B unexposed until all approved A proofs pass.

## Independent review corrections (~02:28 PST)

The independent reviewer found four concrete defects in the earlier checkpoint. They were real: local provenance did not check authoritative pool ownership; remote parent ownership lacked a signed epoch/sessionKey snapshot; local receive verification accepted additional placement-core fields; and a cached remote proposal rejected a valid same-epoch lease renewal. The earlier passing tests did not cover those cases.

The local base dependency now **requires** `ownershipForConversation(ref): SessionOwnershipRecord|null` for capture and intake. Capture signs exact active parentOwnership and workerOwnership snapshots (`sessionKey,ownerMachineId,ownershipEpoch,status,updatedAt`), verifies both belong to its actual machine, and intake compares both current authoritative snapshots. Stale running session files and old valid bootstrap tokens alone no longer authorize capture or intake.

The remote signed request now includes parentOwnership. Intake compares the full current signed parent and worker snapshots. A same-machine epoch or sessionKey change is refused. Source/lease/ownership nested objects have content-free allowlists, and local placement verification and accepting receipt verification reject any additional core field. `released` can only be absent or false, never arbitrary signed plaintext.

Cached remote proposal validation now checks the retained original signed membership/lease bridge and accepting receipt historically. Current admission is checked separately. A same-epoch lease renewal returns the exact frozen core/proof rather than regenerating or rejecting it.

Regression evidence: local16 + remote6 unit tests passed, as did both local/remote integration tests. The exact independent repro now reports remote parent mutation refused and local ownership on another machine refused; its plaintext branch no longer executes because local capture is correctly refused. The dedicated regression tests separately exercise valid local capture then extra plaintext rejection and a successfully prepared remote proof followed by lease renewal with exact equality. Final nested schema assertions were added afterward; final rerun awaits a concurrent replication compilation correction and is not yet claimed here.

Production callbacks remain unwired. Whole-source provenance erasure/repair remains a root integration obligation; deleting encrypted replication bundles alone does not erase the separate local provenance inventory listed above.

Final correction verification (~02:30 PST): all 22 source unit cases pass after the final nested allowlists and bounded ISO timestamp hardening; both real witness/replication integration cases passed after ownership and cached-proof corrections. Default globalSetup compiled the shared source successfully. Destructive-operation lint passed again. No checks were disabled. Root's source-history gateway added after the prior UI proof still requires its own new tests/review; the earlier DOM/chat concurrence does not certify that later gateway or a browser deployment.
