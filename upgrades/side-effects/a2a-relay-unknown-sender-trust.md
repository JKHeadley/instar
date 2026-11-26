# Side-Effects Review — A2A relay unknown-sender trust

**Version / slug:** `a2a-relay-unknown-sender-trust`
**Date:** `2026-10-09`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

Spec: docs/specs/a2a-relay-unknown-sender-trust.md (three cross-model rounds, one internal reviewer, conformance gate; approved under the operator's standing approval of 2026-10-08 14:49). Tracking action ACT-066.

## Summary of the change

The relay client raises `unknown-sender` for a message whose sender's keys this agent does not hold. `ThreadlineBootstrap`'s handler skipped `InboundMessageGate`, emitted `gate-passed` at `verified` (reason `relay-authenticated`) and recorded the interaction, which created a fingerprint profile at `verified` / `setup-default`. The handler now calls `handleRelayUnknownSender` (new pure module `src/threadline/relayUnknownSenderTrust.ts`) after the existing payload-size check.

- off (`enabled` omitted on a non-development agent, or `false`): today's handling, byte for byte.
- dry-run (default when on): today's delivery and profile write; the verdict is counted and a would-refuse logged. A profile created by this path is created already marked `relayFirstContact: true`.
- enforcing (`dryRun: false`): a refused message is dropped before `gate-passed`; an allowed one is emitted at the held level (reason `probe` for a profiled sender's ping/health). Interaction recorded only for an existing profile.

Verdict: held level from the trust manager; a marked, still-`setup-default` profile counts as none; `ack` passes at every level; `credential-share` never; an `untrusted` sender passes nothing else (no probes); otherwise the gate's `getAllowedOperationsByFingerprint` table.

`AgentTrustManager`: optional live `newFingerprintProfileLevel` (only lowers to `untrusted`, throw-safe) and `onFingerprintProfileCreated`; `getOrCreateProfileByFingerprint` takes `createOpts.relayFirstContact`; while enforcing, `getTrustLevelByFingerprint` / `getAllowedOperationsByFingerprint` read a marked, still-`setup-default` profile as `untrusted`. `server.ts` supplies the live mode reader. `routes.ts` authed `/health` carries mode + counters + `unmarkedSetupDefaultProfiles`. `ThreadlineConfig.relayUnknownSenderTrust` type; `DEV_GATED_FEATURES` `a2aRelayUnknownSenderTrust`; CLAUDE.md template + `migrateClaudeMd` section (framework-shadowed). The unknown-sender message content no longer carries a `type: undefined` key.

## Decision-point inventory

- Pass or drop an unknown-sender relay message by sender trust — **add** — invariant: the trust manager's level table (with the ack / credential / untrusted-probe differences stated in the spec); enforced only with `dryRun: false`.
- Trust level handed to the `gate-passed` consumer from this path — **modify** — `verified` today; when enforcing, the held level.
- Level of a new fingerprint profile — **modify** — `verified` today; `untrusted` while enforcing.
- Gate's fingerprint trust reads — **modify** — a marked, still-`setup-default` profile reads `untrusted` while enforcing. Unmarked profiles unchanged.
- `InboundMessageGate` logic — **pass-through** — not changed.

---

## 1. Over-block

Only when enforcing (deliberate operator setting):

- A real peer that has no trust profile, or only a watch-only first-contact profile, is dropped until the operator grants it trust. That is the intended change; the rollout reads `wouldRefuse` first and grants real peers (ACT-069).
- An untrusted sender's `ping`/`health` is dropped (the gate would pass it). It is a stranger's probe; nothing answers probes inline today.
- A `verified` sender asking for an operation above its level (e.g. `task-request`) is dropped, as the gate drops it.
- A plaintext `credential-share` is dropped at every level.
- A throwing lookup while enforcing drops the message (fail closed).
- A new fingerprint profile created by any path while enforcing (including the gate's credential dry-run branch) starts `untrusted`; an operator grant still lands.

Off and dry-run drop nothing.

## 2. Under-block

- Unmarked `setup-default` profiles keep `verified`: those written before this change, while the check was off, or (in dry-run) by other creators such as the gate's own interaction record and the pairing paths. All are counted in `unmarkedSetupDefaultProfiles` on `/health` for the operator to decide.
- Rate limits and replay protection of the gate are not applied on this path (as today).
- A mode read failure is treated as off.
- The MCP stdio process's trust manager can overwrite server-side state (pre-existing, ACT-052).
- The end-to-end path still routes an untrusted sender's probe to a session (pre-existing, ACT-056 filed 2026-10-09).

## 3. Level-of-abstraction fit

The authority stays `AgentTrustManager`; the module only reads its level and table. The drop happens at the one point where the unknown-sender path hands messages onward (`gate-passed`), mirroring the gate. The profile default lives in the manager because it is the only creator of profiles.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is not brittle pattern-matching: a deterministic lookup in the trust manager's enumerable level-to-operation table, the same invariant the relay gate already holds.
- [ ] ⚠️ Yes, with brittle logic.

No content is judged. In its default (dry-run) form it blocks nothing and only produces a log line and counters.

## 4b. Judgment-point check

No new heuristic at a competing-signals point. The one judgment — when to leave dry-run — is the operator's (`## Decision points touched`, ACT-069).

## 5. Interactions

- **Ack stage:** acks pass at every level and are consumed by `runRelayAckStage` before routing; our own auto-ack is sent only to non-`untrusted` senders, so a dropped or untrusted sender gets none.
- **Inbound-id ledger:** reason `relay-authenticated` keeps the `relay-unknown-sender` ingress; `probe` skips the ledger, as for the gate.
- **Local-route trust (sibling):** a same-machine sender refused on the local route falls back to the relay; while this check enforces, a no-profile sender is now dropped there too, closing the gap the sibling spec recorded.
- **Gate:** while enforcing, its fingerprint reads honour the first-contact mark, so the two relay paths agree.
- **Double-fire / races:** none. Synchronous, single-threaded; one log line per verdict.

## 6. External surfaces

- Other agents: when enforcing, strangers' relay messages go unanswered (no ack), as gate blocks already do.
- Install base: none by default (dark on the fleet).
- Persistent state: an optional `relayFirstContact` field on trust profiles (older versions ignore it).
- Authed `/health`: new `threadline.relayUnknownSenderTrust` block; not on the unauthenticated `/health` (tested).

## 6b. Operator-surface quality

No new operator surface; granting trust uses the existing `threadline_trust` / dashboard paths.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN** (`physical-credential-locality`): unknown-sender messages arrive only on the machine holding the relay connection (one per agent identity), and are judged against that machine's trust manager. The first-contact mark lives on the profile it qualifies and can only remove a grant, so losing it on a move cannot add one. Counters per machine. No notices, no URLs.

## 8. Rollback cost

- Live: `threadline.relayUnknownSenderTrust.enabled: false` (read per message) restores today; `dryRun: true` stops dropping.
- Profiles created `untrusted` while enforcing stay so; grant with `threadline_trust`. Marked profiles revert to ordinary `verified` reads once the check is off.
- Code revert: pure patch, no data migration.

## Conclusion

Review changed the design in five ways (probes dropped; durable first-contact mark replacing an in-memory set; mark written atomically with the profile; credential-share refused; unmarked-profile count on `/health`). Clear to ship dev-gated in dry-run. Enforcement on the development agent is decided from the evidence on ACT-069.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (read-only; given the code and this artifact)
**Independent read of the artifact: concur**

Concur. Off and dry-run delivery are unchanged (the profile hook returns `verified` unless enforcing; `isUngrantedFirstContact` applies only while enforcing; the dropped `type: undefined` key was already omitted by `JSON.stringify` and every reader uses `content.type`). Enforcing leaks nothing: an unprofiled or marked sender resolves `untrusted`, everything but `ack` is dropped before `gate-passed`, the ack is consumed by the ack stage before auto-ack, inbox and routing, our auto-ack requires a non-`untrusted` level, and the gate's fingerprint reads apply the same mark. Signal-vs-authority holds (deterministic table lookup, no content judged, dry-run default).

One imprecision raised and fixed: section 2 now says unmarked `setup-default` profiles can also be written in dry-run by other creators (the gate's interaction record, the pairing paths), all counted on `/health`.

---

## Evidence pointers

- `tests/unit/a2a-relay-unknown-sender-trust.test.ts` — 32 tests.
- `tests/integration/threadline/a2a-relay-unknown-sender-trust.test.ts` — 4 tests.
- `tests/e2e/threadline/a2a-relay-unknown-sender-trust-alive.test.ts` — 3 tests, real relay.
- Risk check, development machine, 2026-10-09: two fingerprint profiles, both `verified` / `setup-default` (created by this path).

---

## Class-Closure Declaration (display-only mirror)

No self-triggered controller — not applicable. The check runs only inside an inbound relay message and fires no restart, spawn, notify or retry.
