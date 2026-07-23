## What Changed

`GET /decision-quality` no longer reports a peer-minted tracking action as a dead tracker.

Each pending decision point's tracker id is a shipped source constant (`pending:ACT-1193` on all 49 entries), but it was validated against the machine-local, unreplicated evolution action queue. A machine that had never minted an id that high reported every entry as dangling — measured 2026-07-23: the Mac Mini (high-water `ACT-1119`) flagged all 49, while the tracker sat open on the Laptop (high-water `ACT-1211`). The queues cannot converge; evolution-action replication has a wired send side but an explicitly unbuilt apply side.

`censusDebt` now separates the two states:

- `pendingRefDead` — a tracker within the range this machine has minted, now absent or terminal. **The real "the plan lost its tracker" alarm, unchanged.**
- `pendingRefUnverifiable` — additive; a tracker minted above this machine's id high-water mark, i.e. created on a peer.

Read-only observability; gates nothing. `pendingRefDead` keeps its name and type — it just stops carrying false entries.

## Summary of New Capabilities

- `censusDebt.pendingRefUnverifiable` on `GET /decision-quality`: pending trackers this machine cannot adjudicate because they were minted on a peer, reported separately from genuine losses.

## What to Tell Your User

Nothing to do. If you run on more than one machine, the decision-quality census used to report 49 "lost" tracking items on any machine that hadn't personally created them — a false alarm caused by checking a shipped constant against a per-machine to-do list. Those now show up as "made on another machine" rather than "gone". A genuinely deleted tracker still raises the same alarm it always did.
