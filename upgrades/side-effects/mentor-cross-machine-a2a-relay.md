# Side-Effects Review — Cross-machine mentor A2A relay

**Version / slug:** `mentor-cross-machine-a2a-relay`
**Date:** `2026-07-15`
**Author:** `Instar-codey`
**Second-pass reviewer:** independent reviewer — concern resolved, concurred after repair

## Summary of the change

A signed MeshRpc command carries mentor A2A envelopes to a remote mentee's existing inbox hook. The recipient binds the authenticated machine identity to the configured mentor agent, then reuses all existing inbox validation. Telegram mirroring occurs only after acceptance.

## Decision-point inventory

- Machine-envelope acceptance: existing signature, recipient, registered-peer, freshness, and replay authority.
- Mentor principal binding: authenticated sender machine must equal `mentee.knownMentors[agent].machineId`.
- A2A acceptance: existing target-agent, marker, role, and bot-ID allowlist authority.
- Delivery truth: only `agentMessage:true` writes the sent ledger, marks outstanding state, or permits the visible mirror.

## 1. Over-block

Cross-machine delivery is refused until both `mentor.menteeMachineId` and the reciprocal `mentee.knownMentors.<mentor>.machineId` are configured. This fail-closed requirement is intentional; a machine identity cannot be inferred safely from an agent name.

## 2. Under-block

Registered machines share the broader mesh trust domain, but no registered peer can impersonate a mentor unless the mentee explicitly binds that agent name to the peer's authenticated machine identity, the strict marker `from`/`to` principals match the authenticated command principals, and the payload also passes the existing bot-ID/role gate. Compromise of the explicitly bound mentor machine remains equivalent to compromise of that mentor principal.

## 3. Level-of-abstraction fit

MeshRpc owns signed cross-machine reach; the small adapter owns machine-to-agent binding; the existing A2A inbox owns content admission. Reimplementing inbox parsing or polling Telegram history would create parallel authorities and restart/dedupe state.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No heuristic detector gains authority. Cryptographic machine verification and configured identity bindings are deterministic gates. Telegram is explicitly downgraded to an observability signal and cannot authorize delivery truth.

## 4b. Judgment-point check

No LLM or fuzzy judgment is introduced. Every decision is exact signature, nonce, recipient, configured identity, marker, role, or boolean inbox acceptance.

## 5. Interactions

Same-machine `/a2a/inbox` delivery remains first and unchanged. Configured cross-machine delivery runs only when no local peer accepts. A failed configured mesh attempt returns false immediately and cannot fall through to the legacy Telegram sender. Anti-ping-pong outstanding state advances only on true delivery.

## 6. External surfaces

Adds one internal MeshRpc verb and two optional config identity bindings. The Telegram topic gains the same visible mirror as local accepted delivery; no new public unauthenticated route exists.

## 7. Multi-machine posture

Replicated by signed point-to-point MeshRpc: the mentor targets `mentor.menteeMachineId`, resolves that registered peer's live URL, and sends a recipient-bound envelope. The remote handler is machine-local and invokes its existing mentee inbox. Version-skewed peers return a typed no-handler/refusal; they never fall back to counting Telegram.

## 8. Rollback cost

A hot-fix revert restores same-machine inbox plus legacy Telegram fallback. No schema migration or durable data rewrite occurs. Optional config fields are harmless to older versions.

## Conclusion

The change closes the platform-level bot-to-bot gap by extending the already-correct authenticated inbox architecture across machines, while making delivery truth stricter. Clear to ship after the reviewer-raised marker-principal binding concern was repaired and regression-tested.

## Second-pass review

Concur with the review. The reviewer identified that the authenticated `senderAgent` command field was not yet bound to the marker's `from` field. The recipient now strictly parses the marker and requires both `from === senderAgent` and `to === targetAgent` before dispatch; impersonation regression tests cover both mismatches.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable.
