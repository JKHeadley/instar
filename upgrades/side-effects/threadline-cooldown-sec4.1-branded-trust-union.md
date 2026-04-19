# Side-Effects Review — Threadline §4.1 commit 1: branded RelayTrustLevel union

**Version / slug:** `threadline-cooldown-sec4.1-branded-trust-union`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (type-additive; no runtime behavior change)

## Summary of the change

First of three commits implementing spec §4.1 (authenticated session affinity). Introduces the `RelayTrustLevel` branded discriminated union (`verified` | `plaintext-tofu` | `unauthenticated`) and adds a required `trust: RelayTrustLevel` field to `RelayMessageContext`. Populates `trust` at every existing construction site with `{ kind: 'plaintext-tofu', senderFingerprint }` — the only authentication state the current relay path actually provides. Existing `senderFingerprint: string` field is retained on `RelayMessageContext` for display/key use; callers that need impersonation-safe identity must read `trust.senderFingerprint` after narrowing on `trust.kind === 'verified'`.

No runtime behavior changes in this commit. Subsequent commits (2 and 3 of §4.1) add the receiver-side `recentThreadByPeer` and client-side `lastThreadByPeer` affinity maps that read the branded union.

Files touched:
- `src/threadline/ThreadlineRouter.ts` — adds `RelayTrustLevel` union; adds `trust` field to `RelayMessageContext`.
- `src/commands/server.ts` — populates `trust` at the single construction site (line 5548).
- `tests/unit/ThreadlineRouter-relay.test.ts` — updates `createRelayContext` factory; adds 3 new tests exercising union narrowing.
- `tests/integration/relay-auto-connect.test.ts` — updates inline `relayCtx` literal.

## Decision-point inventory

1. **Replace vs augment `senderFingerprint`.** Spec wording is "replacing", but all 27 existing usages treat the field as a display/key string, not an identity proof. Augmenting (keep flat `senderFingerprint`, add `trust` as the new discriminator) is smaller, safer, and preserves consumer call sites. Authenticated-only consumers narrow on `trust.kind === 'verified'` and read `trust.senderFingerprint`. Accepted.
2. **Default `kind` at construction.** Current relay path is plaintext token auth, not per-message E2E. Default to `plaintext-tofu`, not `verified`. Upgrading to `verified` requires E2E wiring which doesn't exist yet. Accepted.
3. **Test for the negative case.** Added `@ts-expect-error` test that asserts `unauthenticated` kind does NOT carry a fingerprint — this locks the union shape so future refactors that widen the `unauthenticated` variant fail at compile time.

## Blast radius

Type-only additive change + one populated field literal. Zero runtime behavior change. No I/O. No state.

## Over-block risk

N/A — no gate or decision surface introduced here.

## Under-block risk

N/A — affinity reads that SHOULD gate on `trust.kind === 'verified'` land in commits 2 and 3. This commit only publishes the type machinery.

## Level-of-abstraction fit

Type lives next to `RelayMessageContext` where it belongs. No separate module needed yet; spec does not require one. If the union grows a fourth variant or more properties, extraction is a later refactor.

## Signal-vs-authority compliance

Type is a structural constraint, not a signal or authority boundary. The authority boundary it ENABLES (affinity read gating) is enforced by downstream code in commits 2 and 3.

## Interactions

- `RelayGroundingPreamble.buildRelayGroundingPreamble` reads `ctx.senderFingerprint` for display — unchanged, still works.
- `MessageSecurity.frameIncomingMessage` takes `senderFingerprint: string` directly — unchanged.
- `UnifiedTrustWiring.frameMessage` takes a fingerprint string — unchanged.
- `ThreadlineRouter.handleInboundMessage` accepts `RelayMessageContext` — every call site now populates `trust`.

## Rollback cost

Revert the commit. Type disappears, construction sites degrade back to 3-field literals. Downstream code that narrows on `trust.kind` in later commits must be reverted together; those are separate commits so the revert is clean.

## Tests

- 3 new unit tests in `tests/unit/ThreadlineRouter-relay.test.ts` under `describe('RelayTrustLevel branded union', ...)`:
  1. plaintext-tofu carries fingerprint, does not narrow to verified.
  2. verified narrows correctly and exposes fingerprint.
  3. unauthenticated has no fingerprint on trust (`@ts-expect-error` locks the shape).
- Full `ThreadlineRouter-relay.test.ts` suite: 15 passed (12 prior + 3 new).
- `npx tsc --noEmit`: clean.

## Rollout

Ship on `feat/threadline-cooldown-queue-drain`. Next commits in the same PR: receiver-side affinity (commit 2), client-side affinity (commit 3). PR merges when §4.1 is fully in.
