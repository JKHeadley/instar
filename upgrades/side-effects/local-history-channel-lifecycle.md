# Side-Effects Review — Local History Channel Lifetime

**Version / slug:** local-history-channel-lifecycle
**Date:** 2026-11-23
**Author:** echo
**Second-pass reviewer:** channel_side_effects (independent subagent)

## Summary of the change

Tier 2: a new internal security-sensitive lifecycle class, currently unconstructed in production. One runtime file adds 191 lines; the checkpoint also adds focused tests and component documentation. It wraps existing target handshake/record crypto with native-owner and issuer freshness, channel capacity, automatic expiry, replacement and buffer disposal. It does not mount an endpoint or enable local import. Three independent code reviewers covered security, correctness and test integrity; concrete findings were corrected and covered by 50 focused checks across registry, handshake and record suites. Full suite clearance is not claimed. The first commit attempt passed all 55 lint steps and was correctly refused for this missing artifact/trace; no hook was bypassed.

## Build location and driving spec

This continues the approved local-history stack in the existing isolated `.worktrees/local-history-preview-143810` checkout, parent `4f0db6b791bc48a5aeaa445bba2cc45b9f75e659`, package version 1.3.1984. Both origin and JKHeadley remotes point to `https://github.com/JKHeadley/instar.git`. It is not the agent-home checkout. Reusing the existing dependency stack rather than a fresh current-main tree is an explicit continuation choice; integration/full verification must use its exact published revision through the coordinator. The separate uncommitted disk-ledger work is not included in this checkpoint.

Driving spec: `docs/specs/local-history-native-contract.md`, approved and converged on 2026-11-23, with its existing ELI16 companion. The registry implements the channel-lifetime portion; the parent topic 143810 retains the operation service, real ingress, consent and installed native acceptance. No source-cleanup safety denial is cleared or routed around by this change.

## Decision-point inventory

- New deterministic native-owner/issuer checks before private decryption and response sealing; stable profile, enrolled device/key, agent, machine, boot and server signing-key identity must match.
- New capacity reservation before crypto, one current device channel, per-channel single flight and reentrant-issuance refusal.
- New absolute expiry, revoke, supersession and stop transitions; retained in-flight buffers/keys continue consuming admission until actual close.
- Existing native signature, pre-buffer importer exchange admission, upload/copy authority and durable owner claims are passed through as mandatory independent layers; this class supplies none of them.

## 1. Over-block

A legitimate refresh at full capacity is refused while the old exchange is still retained. It preserves that valid exchange and can retry after drainage. Idle replacement is allowed at capacity. A malformed or expired channel requires a fresh target handshake. Clock rollback observed during issuance refuses rather than extending the grant. These are explicit protocol/resource policies, not judgments about the person's intent. No broader legitimate-input rejection identified in the reviewed component; actual route compatibility remains integration proof.

## 2. Under-block

This class cannot establish that a caller passed full native signature verification or acquired body/response admission. It must not be used as a standalone authenticator. Its caller must dispose transport before closing an exchange; an incorrectly early close would undercount external buffers. These wiring obligations keep the full feature unavailable. Timer scheduling is cooperative; independent timestamp checks deny stale requests/responses even if a timer callback is late. It adds no hard memory or forensic key-erasure claim.

## 3. Level-of-abstraction fit

Lifecycle ownership belongs above the existing cryptographic primitives and below authenticated HTTP operation dispatch. It reuses `LocalHistoryHandshake` and `LocalHistoryChannel`, rather than adding another signature or bearer path. Current-owner resolution and the authoritative machine signer remain injected real dependencies for later server construction. Private input is not sent to an LLM.

## 4. Signal vs authority compliance

Required reference: `docs/signal-vs-authority.md`. The checks are hard-invariant validation and transport/idempotency mechanics under that document's explicit exceptions: cryptographic scope, current authenticated identity, exact nonce/route/sequence, byte ownership and resource admission. They do not classify message meaning or infer user permission from text. No brittle semantic detector receives judgment authority. The registry cannot authorize copying or create an owner profile.

## 4b. Judgment-point check

No new static heuristic at a competing-signals judgment point. Exact identity/cryptographic bindings are invariants. Channel lifetime and bounded capacity are explicit resource policies under the driving spec's decision inventory; they do not override consent or durable claims.

## 5. Interactions

- Shadowing: the class must run after real device authentication and inside the shared importer exchange lease, and never replaces either.
- Double-fire: expiry/revoke/stop/close are idempotent; a single current-device mapping prevents an older close from removing a replacement.
- Races: synchronous issuance fences abort/signing reentry; callback stop or scope change prevents publication. Scope and the latest observed clock watermark are rechecked after callbacks.
- Feedback loops: no autonomous retry, notification or work dispatch is introduced. An expired held exchange stays charged rather than being reclaimed on time alone.

## 6. External surfaces

No user endpoint, agent capability, persistent state, file mutation, external message or network request is added. The public TypeScript class is an internal building block. No existing route or app action constructs it in this checkpoint. Future integration must supply the actual enrolled-owner registry, signing-key hash, transport admission and lifecycle hooks. No operator-facing actions.

## 6b. Operator-surface quality

No operator surface — not applicable. Import UI remains disabled.

## 7. Multi-machine posture

Machine-local BY DESIGN: ephemeral channel keys and sequence state belong to the exact signing machine and boot. They must not replicate, resume on standby or survive process loss. Routing to another computer requires a fresh independently pinned handshake. There are no durable channel records, topic-transfer state, user-facing notices or generated URLs. No status/health/capability route changes; the internal resource-count method reports this instance only.

## 8. Rollback cost

Revert the new class, its test and component documentation. No data migration or agent-state repair is required. Since it is not production-constructed, the checkpoint has no user-visible behavior to roll back. Once integrated, stop the owning registry and drain/dispose outstanding exchanges before replacement; do not move keys or counters to another machine.

## Conclusion

The reviewed component is ready for an ordinary source checkpoint and coordinator verification, not a full import release. Tests exercise real handshake/record crypto, exact and timer-delayed expiry, signing-time clock movement, same-device wrong-key refusal, live owner/device/server-key/boot changes, retained capacity, safe refresh, reentrant replacement, stop and buffer disposal. Remaining parent-contract integration is actively owned in topic 143810; no null/no-op dependency is claimed wired.

## Second-pass review

**Independent read of the artifact: concur.** I read this artifact, the signal-vs-authority principle, the actual registry and its focused tests/documentation. The blocking checks implement explicit cryptographic identity, transport and resource invariants rather than interpreting message meaning. The artifact accurately preserves the mandatory signature/exchange-admission dependencies, retained in-flight ownership, machine-local key posture and rollback scope. Source search confirms there is no production construction or endpoint in this checkpoint; full HTTP/native acceptance remains unproven. No further concrete side-effects concern identified. This was source review only; I ran no tests or builds.

## Evidence pointers

- `tests/unit/local-history-channel-registry.test.ts`: 21 checks.
- Existing channel and handshake suites: 12 and 17 checks.
- Normal targeted run builds actual TypeScript through global setup: 50 passed, zero failed.
- Initial pre-commit run: all 55 lint steps passed; the missing review trace correctly refused commit.
- `docs/local-history/server-channel-lifecycle.md` and parent topic state `.instar/plans/easy-setup-143810-current.json`.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. This adds request-owned cryptographic resource lifetime, not an agent restart, work-spawn, retry or notification controller. The behavioral boundary tests listed above enforce the new protocol mechanics.
