# The diary becomes answerable (P1.2 of the coherence journal)

P1.1 made every machine KEEP the diaries; this makes them ANSWERABLE. One new read endpoint serves the question this project was born from: "which machine was conversation X on last night, why did it move, and where did the overnight run put its files?" — answered from local disk, merged across every diary the machine holds.

The answers are engineered not to lie. Cross-machine ordering uses the placement epoch (a counter that can't disagree between machines) instead of wall-clocks, so two machines with slightly different clocks can't make history look like a conversation was in two places at once — the exact confusion you'd be diagnosing. Copied diaries from other machines are labeled as copies with their staleness in milliseconds, so nothing ever mistakes a replica for live truth. Duplicate move records (from operation retries) collapse to one. A corrupted line degrades the answer and says so — it never crashes the query.

The reads can't hurt a loaded box: newest-first with hard ceilings on bytes scanned, an honest "partial result" flag when a bound is hit, and the one exemption the review demanded — placement history (tiny, kept forever) is always answer-complete, so old history doesn't become unreachable just because it's old.

Two structural guards ride along. First, the reader is a deliberately separate module from the writer, and a new CI lint BANS every session-killing/spawning/moving module from importing it — "the diary never drives actions" is now build-enforced, not promised. Second, every agent's own documentation teaches the new endpoint (capability awareness rule): the moment this ships, agents know to reach for it when you ask "where did this conversation live?"

Also closed: the one stop-path from P1.1 that relied on the once-a-minute observer (emergency stops via Telegram) now reports instantly. Tier-3 boot test proves the feature is genuinely alive in a production-shaped server, not just in unit tests.
