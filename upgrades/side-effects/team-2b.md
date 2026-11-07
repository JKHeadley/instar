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
