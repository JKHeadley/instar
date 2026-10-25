# Side-Effects Review — Refuse plaintext after encrypted chat (`threadline.refuseDowngrade`)

**Version / slug:** `threadline-refuse-downgrade`
**Author:** `Dawn`
**Second-pass reviewer:** `Echo (reviewed the step-6 patch before this rebase; asked again on the PR)`

**Date:** `2026-10-19` · **Spec:** `docs/specs/threadline-standalone-pairing.md` r5.2 (approved 2026-10-20), D6 and D11, rollout step 6. Stacked on step 3 (#2226) and steps 5/5b.

## What changed

- When an agent paired by invite sends us encrypted ordinary chat, and the signature checks out against the key we pinned for it, its trust profile records `encryptedSeenAt`. After that, plaintext arriving under its fingerprint can only be the relay's word, so it is refused. Pairing messages and credentials never set the mark (they are always encrypted). Delivery acks are never refused.
- New live switch `threadline.refuseDowngrade` (`off | watch | enforce`, same gate as `encryptToPinned`: live on a development agent, dark on the fleet, `dryRun` defaults true). Off records nothing and refuses nothing. Watch records the mark and counts what it would have refused, and delivers as today. Enforce refuses. Mode and counters are on the authed `/health` (`threadline.refuseDowngrade`), and the feature is listed in `DEV_GATED_FEATURES` (`a2aRefuseDowngrade`), so `/guards` shows it.
- The mark is one record for the whole agent. Each machine writes its own small mark record (one per peer and machine) on the existing pairing replication stream; every merge pass folds in the earliest time any machine recorded for the same pinned key. The person unpairing (`markVerificationFailed`) writes an unpair record that cancels every mark ordered before it. A pause after a leaked invite is not an unpair, so the mark comes back when the pairing is confirmed again.
- The merge rule lives in `packages/threadline-core/src/encryptedSeen.ts`. Instar holds a byte-identical copy (`src/threadline/encryptedSeenMark.ts`), with a test that fails if the two drift. Step 3 has landed beneath this change, but the core version Instar pins (0.1.0, published before this module existed) does not export it, so the copy stays until a core release that does is published and the pin is bumped; then the copy and its parity test are deleted (spec step 3).

## Decision-point inventory

- `refuseDowngrade.ts`: on a received plaintext ordinary-chat envelope under the fingerprint of an invite-paired peer whose profile carries `encryptedSeenAt`: deliver (off), count and deliver (watch), or refuse (enforce).
- Same module, on a received encrypted ordinary-chat envelope that verifies against the pinned key: record the mark (watch and enforce).
- `ThreadlinePairingReplicatedStore` / `pairingReplicationWiring.ts`: the merge pass folds every machine's mark records into the earliest time per pinned key, cancelled by a later unpair record.

## Signal vs authority compliance

The only blocking decision is a fixed structural rule (a pinned peer that has spoken encrypted does not get plaintext through), keyed on a stored fact and the envelope's own shape. No judgment call, no LLM, no new authority. The switch owner decides when it enforces.

## External surfaces

Wire format unchanged. A peer that falls back to plaintext after speaking encrypted sees its plaintext refused while this agent enforces. The replication stream gains two record states that older machines reject as unknown (see Interactions).

## Operator-surface quality

No new operator surface beyond the `/health` block and the `/guards` row that every dev-gated switch already gets.

## Over-block

A peer that has sent encrypted chat and then genuinely falls back to plaintext (rolled back to an older version, or its owner turned `encryptToPinned` off) has that plaintext refused while we enforce. That is the rule the spec asks for. The way out is to unpair and pair again. If the trust store throws while we check, enforce refuses plaintext from that sender (the spec's "cannot read, treat as seen"); watch counts it and delivers.

## Under-block

SAS-paired peers, and inherited pairings whose record carried no method, are never marked and never refused (they keep step 5's rule). A peer we have only ever received plaintext from is never marked. Plaintext from a sender whose keys are cached already fails to decrypt and is dropped, as before.

## Interactions

- Replication runs only with `multiMachine.stateSync.threadlinePairing.enabled` on (default off). With it off, each machine keeps its own mark, and a machine that takes over the relay may not refuse until it sees encrypted chat itself.
- An older machine rejects the two new record states (`encrypted-seen`, `encrypted-seen-unpaired`) as unknown. It does not refuse downgrades, and nothing else changes for it.
- Mark records are kept out of the pairing views, so inheritance and revokes see exactly what they saw before (tested).

## Multi-machine posture

Unified, as D11 requires: set once, union keeping the earliest time, removed only by an unpair. Mark records are written per origin so two machines never write the same record key.

## Rollback

Set `threadline.refuseDowngrade` to off. Marks stay on the profiles and are only read while the switch is on.

## Evidence

- `packages/threadline-core/test/encrypted-seen.test.mjs` (5): set once, earliest kept, unpair-only removal, key binding, `PinnedKeyStore.mergeEncryptedSeen`.
- `tests/unit/threadline/refuse-downgrade-switch.test.ts` (19): each mode, the mark's rules on the trust profile, SAS and method-less inherited peers unaffected, the `/guards` resolution.
- `tests/unit/threadline/refuse-downgrade-replication.test.ts` (9): two machines on the real journal, applier, stream reader and merge wiring; a mark set on A appears on B and B refuses in enforce; earliest-wins both ways; unpair removes it everywhere and a re-pair starts clean; pause keeps it; SAS unaffected.
- `tests/unit/threadline/encrypted-seen-parity.test.ts` (5): core and the Instar copy agree.
- `tests/e2e/threadline/pairing-invite-production-path.test.ts`, new case: two real agents on a real relay, switch changed live through off, watch, enforce, an SAS pairing, and off again.
- Breakage checks: 15 Instar mutations and 4 core mutations, all caught.

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action`: closure **n/a**. The mark is written at most once per peer per pairing, on a received message.

## Revision (Justin 2026-10-20: ships on)

The rollout posture above is superseded: encryptToPinned defaults to enforce and refuseDowngrade to watch on every agent, no longer dev-gated. See `upgrades/side-effects/threadline-encryption-ships-on.md`.
