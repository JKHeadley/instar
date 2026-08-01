# Project rounds now have to prove they are done

The project tracker has two layers of state. Each individual work item says what
stage it reached, while the containing round also stores a summary such as
`pending` or `complete`. Those two layers could disagree. In particular, an old
round could remain `pending` after every item merged, and the “what should I do
next?” endpoint trusted that stale summary. It could therefore recommend
starting the round again.

There was a second, subtler problem in older data. Before the merge-evidence fix
landed, some item rows were labeled `merged` but did not retain the PR number,
merge commit, or the time at which the merge and CI were verified. Treating
those labels as proof would make completion too easy; treating them as ordinary
unfinished work would risk building an already-completed feature twice.

This change makes item evidence the source of truth. A round is derived as
complete only when every member is either explicitly skipped or is merged with
all three evidence fields. The round’s stored status remains a cache for
workflow details, but it cannot overrule the members. Project reads show the
derived status, and the next-action endpoint skips rounds that have genuinely
earned completion.

If an old item says `merged` without its evidence, the tracker returns a
specific repair action instead of `start-round`. Repair uses the existing
advance endpoint: supplying the PR re-runs the full GitHub, canonical-main, and
CI validation and attaches the resulting evidence atomically. Nothing is
guessed and the feature is not rebuilt. The autonomous runner has the same
defense, so directly invoking it cannot bypass the safer next-action result.
If git definitively proves a recorded commit is no longer on the main branch,
that stronger negative verdict still permits repair work to run; missing old
metadata never hides a real regression.

The intended outcome is simple: cached summaries can no longer create work or
erase proof. New merge transitions keep their evidence as before, old rows have
an honest repair path, and a project round’s conclusion is always traceable to
the records of its members.
