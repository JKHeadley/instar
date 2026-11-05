# Peer stream read cache: plain overview

Opening "How I'm doing inside" in the app froze the agent's server for about fifteen seconds, and a plain health check had to wait behind it. The screen lists class reviews, and listing them re-read and re-checked the whole record stream once for every review.

An earlier fix added a single-read path, and every test passed, but it changed nothing on the live server. The reader is wired up in two places at startup and the later one replaces the earlier one. The fix went into the first place only, so the live server kept the old slow reader. This change puts the wiring in one shared function that both places call, with a test that fails if either place goes back to writing its own.

It also makes the reader remember what it last read. It checks each file's size, time and identity, which costs almost nothing, and reads again only when one has changed. Callers get their own copy, so nothing they do can affect the next reader. A failed read is never remembered, and very large stores are not held in memory.

Timed on a copy of the real data, the same two reads went from about 18 seconds to about 50 milliseconds with an identical answer. If this turned out wrong, reverting the commit restores the old behaviour. There is nothing to decide.
