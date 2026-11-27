---
title: "A new agent's spare machine can take over"
slug: "session-pool-takeover-at-pairing"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
status: "converged"
approved: true
approved-by: "echo, under the operator's standing rule (Justin, 2026-10-22 08:58 PDT: \"I should ONLY have to approve constitution changes\"); proven-parts-first ordering from Justin 2026-11-03, topic 136110; no CODEOWNERS path touched"
eli16-overview: "docs/specs/session-pool-takeover-at-pairing.eli16.md"
review-convergence: "2026-11-06T02:30:22.548Z"
review-iterations: 4
review-completed-at: "2026-11-06T02:30:22.548Z"
review-report: "docs/specs/reports/session-pool-takeover-at-pairing-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# A new agent's spare machine can take over

## Problem statement

`docs/specs/session-pool-default-on.md` step 3 pairs two things: moves on request and takeover. Takeover is now proved and moves are not yet measured, and proven parts go first (Justin, 2026-11-03, topic 136110). So this ships takeover alone.

A new agent that pairs a second machine has no git remote. Without the takeover switch its standby cannot take over: `GitLeaseStore` commits locally, fails to push, reads "CAS lost to epoch N (our candidate N)" and yields (fb-29bc773f-713). On 2026-11-05 the same defect made a test pair flap for about 7 minutes after a restart.

Proof, on unmodified Instar with Telegram's server and the model stubbed (`.instar/vm-test/takeover-drill-137054/REPLY-RESULT.md`):
- Killed the holder: the standby took the lease in about 60 s, restarted once, and became the only poller. The next message got exactly one reply from a real session.
- The old machine returned: it stood down, one poller.
- A 6-minute cut with both machines reaching the API: 7 poll conflicts, 2 messages, one reply each. After the heal, one holder and one poller.

A first fresh pair, 2026-11-05, on two new servers with no git remote, no shared network and no Tailscale, paired through a quick tunnel with the switch on, split for good (`.instar/vm-test/takeover-drill-137054/fresh-pair/STATE.md`):
- Pairing restarts the first machine, which changes its quick-tunnel address.
- The pairing exchange carried no other address. The first machine knew nothing about the second, and the second knew only the dead address.
- 31 minutes later both held the lease, the second had logged 360 failed attempts to reach the first, and nothing healed it.

So the switch alone is unsafe: "both hold until the link heals" is only acceptable when the link can heal.

## Proposed design

**The switch.** Add two keys to `POOL_ACTIVATION_KEYS`: `multiMachine.leaseSelfHeal.soloCaptainHold.enabled: true` and `multiMachine.leaseSelfHeal.soloCaptainHold.requireLastingLink: true`. Both machines write them from the same helper at a first pairing, as with every other key on that list. The helper also writes `soloCaptainHold.pairRole`, `inviter` on the first machine and `joiner` on the new one, and `pairedWith`, the other machine's id. None of these ships as a default, so no other agent's config changes. The role never changes on a machine that has its pairing marker: a re-pair writes no keys there, in whichever direction it runs. A machine that lost its marker and pairs back takes the opposite of its partner's role, sent in the pairing answer, so a pair never holds two joiners. The first switch already enrolls the fast renewal timer (#2803) and turns on the existing rules: a machine holds only with no higher epoch seen, and takes back its own lapsed lease only after asking peers.

**Addresses at pairing.** The joiner sends its lasting addresses in `/api/pair`, and the response carries the first machine's. A lasting address is LAN, Tailscale or a named tunnel, cleaned by `validateMeshEndpoints`. A quick tunnel is left out. LAN detection also learns Linux interface names such as `enp7s0` and `wlp2s0`; it read only `en0` and `eth0` style names, so these machines advertised no LAN address. The LAN subnet check reads a `/32` interface as its `/16`: cloud private networks give each machine a `/32`, so the check ruled out every peer.

**Addresses at a re-pair.** Pairing again merges the addresses it receives with those already known, so a working address is not lost, and the first machine reads its own addresses fresh at that moment, because its registry entry is written only at boot. Pairing again also clears the proof for that peer on both sides, since its keys or network may be new.

**Proof before the spare acts alone.** Proof is one lease exchange on a lasting address whose answer the peer signed (the mesh ack, checked against its key and this request's nonce), written once to `state/lasting-link.json` so it survives a restart. An unsigned 2xx from an older peer never counts. Until a machine has proof:
- The inviter serves as it always did. It holds its lease alone, so a pair that can never reach each other still has one working machine.
- The joiner does not take the lease on its own (`acquireHeldBack`, checked at the top of acquisition, on either lease store) and does not keep one through a lost link (`survivorMayHold`). It stays standby and quiet, with no suspend loop, and keeps dialling so that proof can form. The proof that counts is with `pairedWith`: proof with a third machine says nothing about reaching the first, and a replacement added later must not stop the only working machine. Once that partner is revoked the rule no longer applies.
- A pool that names a preferred machine keeps its rule whole: none of this applies there.

A joiner already in charge when a re-pair clears its proof keeps the lease while the link lives, and suspends if the link dies. It cannot split, because the inviter defers to it only over that link.

So an unproved pair has one machine in charge and no takeover: if the inviter dies, the joiner waits for its owner. Once the joiner has proof it behaves as the switch describes.

**Saying so.** `instar join` prints a note when either side has no lasting address, with the fix: same network or Tailscale, then pair again. It cannot see an address that exists but does not connect, so `GET /session-pool/readiness` is the fuller answer: it reports takeover as `unknown` with that reason and fix until proof exists. The agent's own reference line for readiness says to tell its owner. `instar pair` no longer prints the old no-git-remote note on a pairing that will turn the switch on.

## Decision points touched

| Decision point | Class | Justification |
|---|---|---|
| `survivorMayHold`, new input: a joiner needs proof of a lasting link to a peer | `invariant` | A structural check on signed-dial history. Failing it removes a permission. It weighs no competing signals. |
| Which addresses count as lasting | `invariant` | A quick tunnel's address changes at each restart, by how quick tunnels work. Everything else counts, and only a signed answer turns it into proof. |
| `acquireHeldBack`: an unproved joiner does not take the lease | `invariant` | With no proof it cannot tell dead from lost, and the inviter is serving. A fixed rule gives exactly one machine in charge, and the cost is only a missed takeover, which is named. |

## Evidence declaration

- **Symbol:** a row in `state/lasting-link.json`.
- **State it claims:** this machine reached that peer, authenticated, over an address of a kind that does not change at a restart. That the path will still be there later is an assumption, and the permanent-disconnection row names where it fails.
- **Corroboration:** the peer signed a lease answer bound to this request's nonce on that address. Nothing else writes the row.
- **Present but state absent:** the proof is never withdrawn, so a path that later disappears still counts. Named under Failure modes.
- **State present but symbol absent:** the link works but no signed exchange has happened yet, or the file was lost. A joiner waits until the next exchange writes it, so takeover is delayed and nothing unsafe happens.
- **Unmeasurable:** an unreadable file counts as no proof, and readiness reports `unknown`, never `ok`.

## Multi-machine posture

- `state/lasting-link.json`: machine-local. Each machine records what it reached itself, and another machine's dial proves nothing about this one's path.
  machine-local-justification: hardware-bound-resource
- The two config keys: written on both machines at pairing, as with every other activation key.
- Addresses: exchanged at pairing, then kept current by the existing lease-response path (`mesh-endpoint-http-propagation`).
- Notices: printed once by the `instar join` that the person ran. Readiness is per machine, read through the existing route.

## Frontloaded Decisions

1. A pair with no lasting link gets no takeover rather than a warning with takeover on. Two machines in charge with nothing to end it is worse than a dead machine waiting for its owner.
2. One signed answer is enough proof. The signature already rules out a stranger on a look-alike network, so a streak adds delay and no safety.
3. The proof is cleared only by pairing again. It is needed exactly when the peer cannot be reached, so unreachability cannot clear it.
5. Unproved, the inviter serves and the joiner waits. The role comes from who invited whom, so both sides agree with no contact between them.
4. A `/32` interface reads as its `/16` in the LAN check only. A wrong guess costs one failed dial, and identity comes from the signature.

## Who is affected

Only an agent's first pairing after this release. An agent already paired, a re-pair that is not activated, a declined activation and a single machine are all unchanged, since `decidePairActivation` is not changed. Existing pairs do not receive these keys: they are written at a first pairing (`decidePairActivation`, `first-pairing`), plus on a machine whose home lost its pairing marker when it pairs again, which takes the opposite of its partner's role. No migration applies. A hand-set switch, as on Echo, has no `requireLastingLink` and holds as before.

Three smaller changes do reach existing agents. A Linux machine with no plain-named interface may advertise a LAN address where it had none; one with a plain name keeps the address it has. A `/32` interface now passes the LAN check within its `/16`, so a peer's address is tried instead of dropped; a wrong one costs a failed dial. And a re-pair merges addresses and clears proof, as above.

A pair that names a preferred captain keeps its rule whole, because `survivorMayHold` is false there.

## Failure modes

| Case | Result |
|---|---|
| Link cut, lasting link proved | Both machines hold until it heals, then the higher epoch wins. Measured at 6 minutes. This already follows from the switch's design. |
| A working lasting address that lost its first dial, while a quick tunnel answers | The tunnel can keep winning the race, so the lasting address may not be dialled again and proof may not form. Takeover stays off, which is the safe side, and readiness says so. Pairing again retries. |
| Pair with only quick tunnels | One machine in charge, the inviter. Conversations stay on it, because the machines cannot reach each other to share. The joiner stays quiet and keeps failing to dial. No takeover. The note says so and how to fix it. Reconnecting such a pair needs a way to find each other with no git remote and no paid service; tracked as fb-53e359fb-042 and CMT-1381. <!-- tracked: CMT-1381 --> |
| Two private networks that look alike, such as two homes on 192.168.1.x | The address is exchanged but never confirmed, because only the peer can sign the answer. Same as above, except no note prints at join, because both sides have an address. Readiness says so. |
| Proved, then the machines truly lose each other: a laptop leaves home | Quick tunnels usually carry on, and each machine's new tunnel address reaches the other over them. If both tunnels restart while apart, nothing connects them and both hold until they meet again, so jobs run twice and pollers conflict. Measured at 6 minutes only. Same tracked item, CMT-1381. <!-- tracked: CMT-1381 --> |
| A machine revoked while still running | Revocation is not pushed to it. With proof it keeps holding, where before it would have fenced itself. It already holds the bot token, so revocation never stopped it reaching Telegram. Filed as feedback. |
| Cut, and a message arrives | Measured 2 of 2 delivered once. The two pollers conflict. Not proved for a longer cut, so a duplicate reply stays possible, and jobs can run on both sides. The duplicate check only observes (it runs dry), so nothing stops either. This is accepted for a proved pair: it ends when the link heals. |
| Standby with no channel of its own, such as a Slack pair | It takes the lease and runs jobs, but cannot answer on Slack. `SlackAdapter` has no lease awareness. Same as today, since today it answers nothing either. |
| Live session on the dead machine | Gone. The next message starts a new session on the survivor. |
| Inviter and joiner on different releases | One machine has the switch and the other does not. The one without can still take over only as it does today. Fixed by updating. |

Carrier for the two tracked rows above (frozen excerpt from the commitment registry, 2026-11-06; the feedback item it carries is fb-53e359fb-042):

> **CMT-1381** — "I will build a way for two paired machines to find each other again with no git remote and no paid service, so a pair that only has quick tunnels, or a proved pair whose laptop left home and whose tunnels both restarted, reconnects instead of staying split. Takeover at pairing (topic 137054) ships the guard only: no takeover hold without a proven lasting link."

## Testing

- **Unit:** both keys are written on both sides from the real shipped defaults, their paths exist there, and a declined activation writes nothing. Which addresses count as lasting, proof surviving a restart, a working quick tunnel proving nothing, the transport reporting a signed answer and not an unsigned or forged one, and the Linux interface names.
- **Route:** both machines learn each other's lasting addresses and never a quick tunnel; a joiner with none pairs as before.
- **Integration and e2e:** the existing activation tiers run this list. The e2e test that the switch enrolls the renewal timer came with #2803.
- **Live, required before merge:** two fresh servers, non-development, paired by `instar pair` and `instar join` from this build, through the quick tunnel as a new agent would, so the config is what pairing writes.
  - No shared network: across several lease lifetimes and restarts, one holder, one poller, the joiner quiet, one reply to a message.
  - On a private network: proof appears on both. Power the holder off for 30 minutes with messages through it, every reply delivered once and a flat epoch, as `session-pool-default-on.md` step 3 requires. Then the machine's return, then a link cut, as above.
  Recorded in the report beside this spec.
- **Live result, 2026-11-06 (run 9, `.instar/vm-test/takeover-drill-137054/fresh-pair/run9-fixed-stageB.log`).** This build plus #2828, on a freshly paired private-network pair. Proof formed on both machines over the LAN. 12 of 12 messages got exactly one reply:
  - one before the power-off;
  - six during the 30-minute power-off of the holder, all answered by the joiner, which took the lease within 2 minutes;
  - two after the holder's return, which did not take the lease back;
  - two during a 6-minute cut of every link;
  - one after the heal, when one machine stood back.

  The no-shared-network stage passed earlier on the same build (one holder, one poller, the joiner quiet through restarts of both).
- **Found by the drill and fixed separately, both needed for takeover to keep its promise:**
  - #2828 (merged): a machine that got 409s during a split, stood by, and later took the lease never polled again.
  - #2833 (in review): on Linux the lifeline's self-restart never ran, and watchdog self-restarts had no daily bound on any platform.

## Rollback

Set `multiMachine.leaseSelfHeal.soloCaptainHold.enabled:false` on both machines and restart each. One machine alone is not enough: the key is per machine and does not replicate. This must come first: without `requireLastingLink`, or on an older release that does not read it, a machine with the switch on holds with no proof at all, which is the permanent split this spec exists to prevent. So reverting the release does not stop agents already paired on it, and they must have the switch set off too. Measured on 2026-11-05 on the test pair: with the switch off, a restart flapped for about 7 minutes and settled with no takeover ability.

## Agent awareness

`GET /session-pool/readiness` already reads the switch: it reports `failing` only for a git lease with no remote when the switch is off or a captain is named, and `unknown` otherwise, since only a real takeover proves it. It now gives the no-lasting-connection reason and fix, and the agent's reference line for readiness tells it to pass that to its owner in plain words. `instar pair` and `instar join` printed that takeover does not work on such a pair; that note now prints only when the switch is off and this pairing will not turn it on, so a new pair is not told something false.

## Maturation plan

- **test-agent-live:** the fresh pair under Testing.
- **dev-agent-live:** the same pair, kept running, because Echo's hand-set switch has no `requireLastingLink` and cannot exercise it.
- **fleet:** new agents at first pairing, in the release that carries it.
- **graduation criterion:** the live drill rerun on a fresh pair at release, plus 14 days with no feedback report of a duplicate reply or a failed takeover on a new pair. There is no fleet row to count these, so absence of a report is weak evidence, and it is named as such.
- **ladder:** multiMachine.leaseSelfHeal.soloCaptainHold
- **dark-window:** none for new pairs. Existing pairs stay as they are.

## Open questions

None.
