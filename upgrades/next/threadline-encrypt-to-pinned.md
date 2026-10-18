# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- Ordinary chat to an agent paired by invite is now always encrypted, to the identity key pinned when the two people paired. Before this, an Instar agent encrypted only when the relay had handed it the peer's keys during the current session; after a restart, or for a peer the relay had not described yet, it sent plaintext, even to a paired peer. `ThreadlineClient.sendAuto` now asks a new resolver (`setEncryptToResolver`) first, and `hasEncryptedSendPath` reports the pinned path too. Spec: `docs/specs/threadline-standalone-pairing.md` (D6, step 9).
- The bootstrap returns a key only for peers that are `mutual-verified` AND were paired by invite (no SAS fingerprint). An acceptor still waiting for the inviter's Finish keeps the old rule, because the inviter cannot read a message encrypted by an agent it holds no key for yet. A peer paired by the older SAS method keeps the old rule too, because it may run a version from before 1.3.1345, which cannot decrypt to a pinned key without a cached one. Both sides of an invite pairing run 1.3.1352 or later, which can.
- **Explicit pairing method.** Trust profiles now record `pairingMethod` (`invite`, `sas` or `inherited`). The resolver keys on `pairingMethod === 'invite'` rather than on a missing SAS fingerprint (an inherited pairing has none either). Profiles from before the field are backfilled on load: a `mutual-verified` profile gets `sas` when it holds a SAS fingerprint, else `invite`; an existing value is never overwritten.
- **Live switch `threadline.encryptToPinned`** (`{ enabled?, dryRun? }`, same gate as `threadline.relayUnknownSenderTrust`: `enabled` omitted is live on a development agent and dark on the fleet; `dryRun` defaults true). Off: today's behaviour. Watch (`dryRun` not false): sends unchanged; each send that would have gone encrypted to the pinned key is counted (`wouldEncryptToPinned`). Enforce (`dryRun: false`): encrypted to the pinned key. Mode and counters: authed `/health` → `threadline.encryptToPinned`.
- **Never plaintext in enforce.** When the pinned send cannot be built or handed to the relay, `sendAuto` throws ("no plaintext fallback") instead of trying the relay-key or plaintext paths.
- **Receive-side label (enforce only, never a refusal).** Plaintext ordinary chat under the fingerprint of an invite-paired, mutual-verified peer is delivered with a fixed server notice ("unverified sender … the relay could have written it") and at no more than `verified`. Watch counts it (`wouldLabelUnverified`).
- On an agent's other machines, a replicated pairing keeps the previous rule until the replicated record carries the pairing method (spec §8.2).
- Decrypting is unchanged. Every version that can pair by invite already decrypts messages encrypted to its pinned key.

## What to Tell Your User

If you paired me with another agent using an invite, everything I send that agent is now encrypted, every time. Before, my ordinary messages to it went out unencrypted after I restarted, until the relay reminded me of its keys. Secrets were already protected and still are. Agents you paired the older way, by comparing words, work exactly as before.

## Summary of New Capabilities

- `ThreadlineClient.setEncryptToResolver(fp => Buffer | null)`: the pinned key to always encrypt ordinary chat to.
- Invite-paired, mutual-verified peers: ordinary chat always encrypted to the pinned key.

## Evidence

- `tests/e2e/threadline/pairing-invite-production-path.test.ts`, new case on two real Instar agents and a real relay with both key caches cleared. Before Finish, the acceptor's message arrives in plaintext and is not lost. After Finish, both directions arrive encrypted. A pairing marked as SAS-made goes back to the old rule.
- `tests/unit/ThreadlineClient-encrypt-to-pinned.test.ts` (4): the pinned key and its derived X25519 are used with no cached keys, and the resend flag is carried; the pinned key takes precedence over relay-supplied keys; a key for another agent, or a resolver that throws, is ignored; with no resolver, behaviour is unchanged.
- Breakage checks: 6 tried, 6 caught. The threadline unit and integration suites pass: 147 files, 2,540 tests.
