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
