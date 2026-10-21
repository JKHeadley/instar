# Side-Effects Review — Encryption to paired peers ships on

**Version / slug:** `threadline-encryption-ships-on`
**Date:** `2026-10-20`
**Author:** `Dawn`
**Second-pass reviewer:** `Echo (requested on the PR; her three review criteria are built in, see "Echo's criteria")`

## Summary of the change

Justin's ruling (topic 61599, 2026-10-20 11:50 PDT): "why is encryption shipped off? Please change it such that it ships on."

- `threadline.encryptToPinned` (spec `threadline-standalone-pairing` D9, rollout step 5) now defaults to **enforce** on every agent, development or not. `enabled` omitted means on; `dryRun` omitted means false. It is no longer a developmentAgent-gated feature (removed from `DEV_GATED_FEATURES`). `ConfigDefaults` writes `threadline.encryptToPinned: { enabled: true }` (no `dryRun`), so `/guards` and the config file show the truth.
- `threadline.refuseDowngrade` (step 6) now defaults to **watch** on every agent (`enabled` omitted means on, `dryRun` omitted means true). Marks are recorded and replicated; would-refuse plaintext is counted. Not enforce: see "Why refuseDowngrade is watch, not enforce".
- An enforcing refusal is now loud: `reportDowngradeRefusal` logs a named reason (`plaintext-from-peer-that-sent-encrypted`) and a remedy, keeps a bounded per-peer record shown on the authed `/health` (`threadline.refuseDowngrade.refusals`), raises one degradation report and sends one fixed notice back to the sender, encrypted to its pinned key (`ThreadlineClient.sendNoticeToPinned`), per peer per hour.
- The multi-machine startup note (enforce + pairing replication off) is now also a degradation report, with plain wording about what happens and how to fix it.
- `ThreadlineBootstrap` with no mode reader supplied now uses the shipped defaults instead of off. So does a reader that throws (see the revision below).

## Upgrade migration

`applyDefaults` is add-missing. An agent whose config has no `threadline.encryptToPinned` gets `{ enabled: true }` and resolves to enforce. An explicit `enabled: false` (off) or `dryRun: true` (watch) is never overwritten. Same for `refuseDowngrade` (`{ enabled: true }`, resolves to watch; an explicit `dryRun: false` stays enforce, an explicit `enabled: false` stays off). `dryRun` is deliberately not written, so the shipped posture lives in code: a later move of refuseDowngrade to enforce is a code default, not a migration. Tests: fresh agent enforce, explicit off off, explicit watch watch, dev and non-dev both enforce.

### Every existing peer with NO pinned key (Echo criterion 1)

Nothing changes for them. encryptToPinned and refuseDowngrade act only on a peer whose trust profile is `pairingMethod: 'invite'` with a `peerIdentityPub` and state `mutual-verified` (or `identity-verified` inherited from a replicated invite record). For every other peer the previous rule holds exactly:

- Never paired, or a relay-first-contact stranger: no pin. Sends encrypt when the relay supplied the peer's keys this session, plaintext otherwise. Inbound plaintext is handled by the unknown-sender path as before.
- Paired by the older SAS method (`pairingMethod: 'sas'`, or a legacy profile with a `sasFingerprint`): previous rule, because such a peer may be too old to decrypt to a pinned key.
- Inherited from a replicated record that carried no method (`pairingMethod: 'inherited'`): previous rule.
- `invite-accepted` (the inviter before Finish, or a pairing paused after a leaked invite): previous rule, so nothing is lost before Finish.
- A legacy `mutual-verified` profile with no `pairingMethod` and no `sasFingerprint` is backfilled to `invite` on load (existing step-5 behaviour, tested), so it DOES get encryption from this release: that is the intended effect of the ruling.

The e2e test sends plaintext from a never-paired peer to an enforcing agent and asserts it is delivered.

## Why refuseDowngrade is watch, not enforce

Concrete breakage found. Instar before this release (and any Instar with encryptToPinned set off) sends ordinary chat to an invite peer encrypted when the relay has handed it that peer's keys this session (`knownAgents`), and plaintext otherwise (`ThreadlineClient.sendAuto`). After a restart, before discovery, it sends plaintext. Such a peer can therefore send encrypted chat, which sets the mark, and later plaintext, which enforce would refuse, so its ordinary messages would stop until it updates. With encryptToPinned on everywhere from this release, an updated peer never sends plaintext chat to a pinned peer, so enforcing becomes safe once the fleet has updated. The per-peer watch counters (`wouldRefuseDowngrade`) show whether any such peer remains. Proposed: move the default to enforce when they read zero across the fleet for a release cycle. The peer's version cannot be used to decide per peer: the relay supplies it, and the relay is the party this protection defends against.

## Multi-machine decision

`multiMachine.stateSync.threadlinePairing` (pairing replication, step 5b) ships explicitly `enabled: false` on every agent (it feeds the credential-share gate) and that `false` has been written into existing agents' configs by add-missing migration, so it cannot be told apart from an operator's choice. Turning it on by default would either not reach existing agents or overwrite values that may be deliberate. It is NOT turned on here.

encryptToPinned is enforce on multi-machine agents anyway. On the machine that made the pairing, sends are always encrypted to the pin. On another machine that takes over the relay, with no inherited pin, the older rule applies: the same behaviour every machine had before this change. So enforce is never worse than watch on any machine, and strictly better on the pairing machine. Such an agent logs the existing startup warning and now also raises a degradation report naming the fix (turn pairing replication on). The safer-sounding alternative, watch on multi-machine agents, would leave the pairing machine sending plaintext when the relay had not supplied keys, against the ruling, with no gain on the other machines.

## Echo's criteria

1. Peers with no pin on upgrade: above.
2. Loud refusal: named reason + remedy in the log line; counted (`refusedDowngrade`) and recorded per peer (`count`, `firstAt`, `lastAt`, `reason`, `explanation`, `remedy`, `noticesSent`, `noticeFailures`) on the authed `/health`; one degradation report and one encrypted notice to the sender per peer per hour. The notice is a fixed server string, never peer text, sent only to the pinned key (never a relay-supplied key, never plaintext). The hourly bound keeps a forging relay from turning the agent into a sender, and breaks a loop with an old peer that replies in plaintext.
3. Test: `tests/e2e/threadline/pairing-invite-production-path.test.ts`, "enforcing refuse-downgrade (Echo, 2026-10-20)": real relay, three real agents; the pinned peer's plaintext is refused, the refusal record carries the reason and remedy, the pinned peer receives the notice encrypted, the refusal is on `/health`; the never-paired peer's plaintext is delivered.

## Revision (Echo's review of #2236): a throwing mode reader is the shipped default, never off

Before: when the live mode reader threw, every fallback resolved to off, so an unreadable config silently stopped encryption. Now `readEncryptToPinnedMode` returns the shipped default (enforce) and `readRefuseDowngradeMode` returns its shipped default (watch). The send resolver, the client fail-closed check, the receive label, the mark and the refusal check all read through these. The `ThreadlineBootstrap` reader wrappers fall back to the same defaults. Tests: unit (each module with a throwing reader, plus a control that a reader that answers is used as-is), and an e2e test where both readers throw on two real agents. There, chat still goes encrypted to the pin with no cached keys, and the mark is still recorded. Mutating any of the four fallbacks back to off is caught.

## Decision-point inventory

- `resolveEncryptToPinnedMode`: default enforce for all agents.
- `resolveRefuseDowngradeMode`: default watch for all agents.
- `reportDowngradeRefusal`: whether a notice/report is due (one per peer per hour).

## 1. Over-block

- encryptToPinned enforce fails closed when the trust store throws: ordinary chat to every peer is refused (502) until it is repaired (existing step-5 behaviour, now on every agent; counted on `/health`).
- A pinned invite peer that cannot decrypt to a pinned key: excluded by design (only invite pairings, which need 1.3.1352+).
- refuseDowngrade over-block is avoided by shipping it at watch (see above).

## 2. Under-block

- Multi-machine agents without pairing replication: the non-pairing machines keep the older rule (warned).
- refuseDowngrade at watch delivers plaintext from a marked peer (counted per peer), as before this change.

## 3. Level-of-abstraction fit

Defaults live in the two resolvers and ConfigDefaults; the refusal record and notice policy live in `refuseDowngrade.ts` beside the decision; the bootstrap only wires the log, degradation report and client send.

## 4. Signal vs authority compliance

No new authority. The notice reuses the pinned key that already authorises credential sends.

## 4b. Judgment-point check

None; mechanical.

## 5. Interactions

- threadline-mcp peers: they encrypt to pinned peers already and refuse downgrade themselves; with Instar enforcing they now always receive encrypted chat from it, which is what makes their refusal safe.
- Older Instar peers: receive encrypted chat to their pinned key (1.3.1345+ decrypts with an empty cache). Their own intermittent plaintext is delivered (watch), labelled unverified (step 5 receive label, now on by default) and capped at `verified` trust.
- The receive-side unverified label is now on by default: plaintext under an invite peer's fingerprint is delivered with the fixed notice and at no more than `verified`. That is a behaviour change on every agent for such plaintext.
- CollaborationRedriveEngine and the a2a outbox redeliver already treat `EncryptToPinnedSendError` as not-sent (step 5).

## 6. External surfaces

Peers see encrypted envelopes where they used to see plaintext. A peer whose plaintext is refused under enforce receives one encrypted notice per hour.

## 6b. Operator-surface quality

`/guards` shows both switches resolved on for every agent. `/health` gains `threadline.refuseDowngrade.refusals`.

## 7. Multi-machine posture

Above. Marks record and replicate at watch when replication is on.

## 8. Rollback cost

Per agent, live: `threadline.encryptToPinned.enabled: false`. Cost unchanged from step 5: a threadline-mcp peer that has seen encrypted chat then refuses Instar's plaintext until re-pair. `threadline.refuseDowngrade.enabled: false` stops recording marks; marks already recorded stay. Reverting the release restores the dev-gated defaults; config values written by this release (`enabled: true`) then turn both switches on at their old dry-run default (watch), not off.

## Conclusion

Ships encryption on, as ruled, without cutting any peer's chat: the one switch with a concrete breakage ships at watch with the evidence needed to move it.

## Evidence pointers

- `tests/unit/threadline/encrypt-to-pinned-switch.test.ts`: default, explicit wins, upgrade migration, `/guards` for dev and non-dev.
- `tests/unit/threadline/refuse-downgrade-switch.test.ts`: default, upgrade migration, `/guards`, loud refusal (reason, remedy, per-peer record, notice to the pinned key, hourly bound, notice failure, bounded log).
- `tests/e2e/threadline/pairing-invite-production-path.test.ts`: Echo criterion 3 on a real relay.
- `tests/unit/ThreadlineClient-no-plaintext-chat-to-pinned.test.ts`: the new `sendNoticeToPinned` is classified as always-encrypted.

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action` — closure **bounded**. The only self-triggered action added is the refusal notice, bounded to one per peer per hour, with a bounded per-peer table (256).
