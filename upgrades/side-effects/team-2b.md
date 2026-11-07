# Side effects: team access on several machines (step 2b)

**Status:** pure rules only so far, in `src/core/TeamAccessMerge.ts`. Nothing calls them yet, so behaviour is unchanged.
**Over-block:** none yet. Once wired, a gap holds every team person until settled, which is deliberate.
**Under-block:** rows only one sleeping machine holds cannot be detected, a stated limit in the spec.
**Level:** pure functions of a set of rows, so two machines holding the same rows reach the same answer. Tests check every arrival order, and each rule was removed in turn to confirm a test fails.
**Signal vs authority:** this is the authority for who has access once wired; it holds none today.
**Rollback:** delete the file; nothing imports it.

## Chained rows
New rows carry origin, incarnation, a hash of the row before and a signed seen-vector. Rows from a 2a build stay valid and are anchored by a prefix hash, so an existing agent keeps its log. On one machine the only behaviour change is that a replaced row now reads as damage even where the numbers still run. A restore starts a new incarnation.

## Several machines in one log
`foldLog` replays one machine's rows in order, exactly as before, and uses the merge rules once a second origin appears. `ingest` takes rows from a peer and leaves out any that fail verification. Each machine numbers its own rows. Nothing calls `ingest` yet: a second machine is still refused at the join.

## Row exchange
`POST /api/team-access/rows` serves the rows a peer lacks, to authenticated machines only. `pullFromPeers` asks each peer and treats silence as normal. `shouldRefuseForStaleness` refuses only for a peer known awake, so a closed lid disturbs nobody. A peer's row whose key has not arrived waits; this machine's own unplaced row still reads as damage. Still refused at the join, so no peer exists yet.

## Confined list across machines
Each conversation locked here is told to peers as a `confine` row, and a peer writes its file before folding. A grant locks its conversation on arrival even if its row cannot be placed yet, since locking is the safe direction. Owned beats shared for one conversation, in any order. A restore's sweep stays local. 2a's entries are told once at boot.

## Phones across machines
A team phone is bound in the log at activation, with a pass at boot for 2a's phones. `reconcileTeamPhones` revokes a phone here when its person was removed elsewhere. A phone whose person the log has never held is left alone, because it can pair before the row arrives.

## The hold
`gapsIn` finds what a log can see is wrong: a broken chain, two rows with one number, a second stream from one machine, or a row that cannot be verified yet. Any of those refuses every team phone with `access-being-checked`, through the one existing refusal point. A log with rows from one machine holds nobody, so an agent on one machine sees no change. Vectors alone cannot show two rows with one number, so a pull also sends the hash of its last row per stream.
**Over-block:** a machine that restores from a backup holds every team phone until the owner settles it. Deliberate: a lost row could have been a removal.
**Settling:** `POST /mobile/team/origin-gone`, owner only, Face ID. A row counts as settling a gap only if the owner's phone signed it. The named machine starts a new stream when it hears.
**Found by the tests:** a machine's next number came from the snapshot's highest row, which can be a peer's, and that read as a lost row. Own numbers now come from own rows once a peer's rows are held.

## The regular exchange
`TeamAccessPuller` asks each peer for what is missing every minute and gives it what it lacks. A machine that cannot be dialled pushes through `POST /api/team-access/push`, machine auth only. With no peers it does nothing, so a one-machine agent sees no change. After rows arrive, each conversation whose sharing changed has its live session ended here, and phones are re-checked.
**Over-block:** team phones wait for the first exchange after boot or sleep, and a peer shown awake that stops answering for 15 minutes refuses them. Both only with the team on and at least one peer.
**Under-block:** a machine cut off from every peer keeps serving, the stated limit in §5. `mobilePairing.team.strictStaleness` closes it at 24 hours, off by default.
**Rollback:** nothing starts the exchange without a machine identity and peers; removing `startTeamPuller` stops it.

## Who may read a message
Once a team is on, or an agent has peers, each new message carries a stamp: where it came from and what its writer knew of the access log. A reader sees a stamped message if a grant to them had seen it, if the message's stamp includes a grant to them, or if they wrote it. Every read path applies this to a team phone: the message list, sync events, reply previews, pushes, file downloads and the history a shared session is given. A team phone reads only what this machine holds, because a peer's rows cannot be judged here.
**Over-block:** a reply written by a machine that had not heard of a grant is held from that person until the owner re-grants. The owner's view marks it with `heldFrom`. A message replicated later can be hidden for a moment if its grant arrives first; that is the design.
**Under-block:** Telegram topics cannot be held, a stated limit in the spec. Messages with no stamp predate this rule and every grant opens them.
**Not proved by a test:** the file download check, which is one line calling the same rule.
**Signal vs authority:** this is authority over what a team phone reads. It changes nothing for the owner, an MSP phone or the bearer token.

**Found on the way:** two session contexts written in one millisecond collided on their file name and failed. The name now carries a short random part.

## The version floor replaces the one-machine block
`teamGate` no longer counts machines. A joiner sends its `teamEnforcement` version and one below the floor is refused while the agent has a team. Each exchange carries what a peer says of itself; a peer last known on an old build, or with native conversations or memory privacy off, blocks new invites and grants, and existing phones keep working. A peer never heard from blocks nothing, because a sleeping laptop must not stop a team.
With native off a machine still keeps the log and the locks, starts nothing in a confined conversation and takes no lease while a team is on. A machine behind a reachable peer takes no lease until it has caught up. A grant to a topic this machine knows is a job's is undone by a row it signs.
**Over-block:** a native-off machine that is the only one awake leaves the agent with no serving machine while a team is on. Spec position: that only binds an agent whose owner turned team access on.
**Under-block:** a machine on an old build that returns after a grant cannot be made to refuse, the stated limit in §3.6. Cutting such a peer from `appConversations` replication is not built yet.
**Rollback:** this is the step that lets a team reach a second machine; restore the `teamGate` machine count and the join refusal to go back.

## Rolling updates and messages that waited
A machine row with an event this build does not know is kept and holds every team phone, so an older machine waits for its update and never loses its log. A team phone's message carries its person, and the machine that delivers it judges them on what it knows, at the drain and when a peer hands it over: a queued message can outlive a removal.
**Under-block:** a request row of a kind this build does not know is refused on arrival, and shows as a gap until the machine updates.
**Not built, on purpose:** `place-applied`. The spec keeps it only as a signal that sessions ended, and nothing reads it, so a machine ending its own sessions on a fold covers what it was for. `eventId` is not built either: one signed request cannot reach two machines, and the spec says so.

## A damaged machine repairs itself
A machine with a damaged log or lock list rebuilds from any peer that answers: what was there is set aside, not deleted, and it carries on under a new stream. That new stream holds every team phone until the owner settles it, which they can do from a phone on that machine, because naming its earlier stream is allowed. With no peer answering the owner's restore applies as before.

## Proved on two servers
`tests/e2e/team-access-two-machines.test.ts` boots two real servers on one computer. Rows cross the real signed route, both reach one answer, and a removal made on one revokes a phone on the other. It found that a machine which had only received rows counted as having no log, so everyone there had no access. Fixed.
**Cannot cross by this route:** conversation events share one journal that all peers copy, so a below-floor peer cannot be cut off alone. A stated limit.

## First review of the read paths
An independent reader found these, all fixed with a test each unless noted: the conversation list showed a held message's first words, and a pool list asked peers; the session-history check ran only on a fallback path, not in production (held by a source check, not a running test); files and transcripts waiting for a session ignored holds; Telegram reply pushes and files stopped for team phones; a peer's push was dropped when it arrived before its row; a lost message record reused numbers an old grant had seen, so numbers now run on their own stream, written atomically; what a session knew did not survive a restart, and a failed session end was never retried; an unreadable stamp counted as no stamp and is now held from everyone; a machine with a peer it could not dial stopped stamping; held names reached MSP phones. Each read re-verified the whole log, so a person's grants are now remembered until a row changes.
**Left as stated limits:** a stamp is trusted as a peer's word, carried inside the machines' signed replication, and is not signed on its own. A held row's owner mark is lost on a peer-only pool row. A file in both a held and a visible message can show as missing, never the reverse. "Show to" is a re-grant today; the app has no button for it yet.

## First review of the access rules
An independent reader proved these with throwaway tests, all fixed with a test each that fails without the fix: a torn lock list threw away a healthy log, which could undo a removal only that machine held; a rebuild could shrink the lock list; a peer that could be reached only one way held everyone with no way out; naming a machine gone cleared neither the wait nor the version block; a restore keyed rows by number alone and dropped rows on several machines; a row refused on arrival never came back; a peer could store a row no known machine signed, and write into another machine's stream; a native-off machine read the team as off and could take the lease; the gap could name the wrong stream, and a second loss went unseen; a role lowered on a gone machine was voided, and a machine row could raise a role; owned beat shared in the list but not in the grants; ownership from a voided range still counted; ties depended on arrival order; phones could be revoked on silence rather than a verified removal.
**Left as stated limits:** `teamEnforcement` in a pair request is a plain field, protected by the pairing code. A peer saying it no longer has a row is not read as a gap. Rows are not pulled in dependency order, so a row waits as pending instead. `privacy-required` is not in the log, so turning memory privacy on is per machine and the floor reports it. Fork rows count until the owner settles, while every phone is held. A fresh joiner could take the lease before its first exchange.

## Second review of the fixes
A third reader found eight more, all fixed with a test that fails without the fix: a repaired machine that later received its own lost rows read as damaged at every boot; a read that failed once at boot could cost a good log; a restore's sweep reached peers at the next boot, so what 2a confined is now told once; a peer that stopped answering could keep a machine behind for good; a fork found by one machine did not reach the other; a refused first row of a stream never came back; naming a machine gone was out of reach for a peer with rows, so the owner's context now lists `streams`, and rows from before chains no longer block it; an old team-off counted as removing anyone; three cases of what a gone machine's rows may still narrow; and each team phone request re-verified the log, so a verified row is now checked once.

## Final review of the fixes
A last reader found that some fixes above went too far, and each is corrected with a test that fails without it: a read grant from a gone machine could bring back something the owner removed, so a gone machine's `use` to `read` change is voided again and stays a stated limit; an owner's restore stopped surviving a reboot on one machine; with peers, a corrupted row of this machine's went unseen, and now leads to a repair; a verified row was remembered for good, though a revocation can fail one, so it is remembered for 30 seconds; a torn list at first boot lost the telling of 2a locks, and a sweep could still be told, so a restore now marks the telling done; the one-machine integrity check had weakened after a restore; a second read kept stale gaps. A repair now records what it accepted, as a restore does.
**Stated limit:** the first row of a stream is not checked against the stream before it on a one-machine agent that has moved stream.
