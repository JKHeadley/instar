### Decision-quality census: peer-minted trackers no longer read as "dead"

`GET /decision-quality` used to report all 49 pending decision-point trackers as
dangling on any machine that had not personally created the tracking to-do item.
The tracker id is a shipped source constant; the to-do queue it was checked against
is machine-local and unreplicated, so a second machine flagged every entry.

`censusDebt` now separates the two states: `pendingRefDead` keeps its meaning (a
tracker within the range this machine has minted, now absent or terminal — the real
"the plan lost its tracker" alarm) and the additive `pendingRefUnverifiable` carries
trackers minted above this machine's id high-water mark, i.e. created on a peer.

Read-only observability; gates nothing. `pendingRefDead` is unchanged in name and
type — it just stops carrying false entries.
