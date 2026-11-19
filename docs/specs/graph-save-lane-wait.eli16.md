# Saves stop queuing behind background checks (plain-English overview)

**What happened.** After the third fix, Accept all still stopped at "Stopped at 2 of 14: your agent is not answering right now". The new log lines showed two things.

**Why.** First, the history check that the third fix moved into the background was starting again after every save. Each save changes the history, so the last check no longer counted. Each check took one to two minutes of reading, so the busy Studio was reading almost all the time. Second, every save still waited in the same one-job-at-a-time line as a background check of the other machines. With a slow Studio that check grew to almost a minute, longer than the page waits.

**What changes.**
- A save now waits at most 3 seconds for that line. If the background job is still busy, the save goes ahead on the history that is already open. Reads have worked this way since the round 3 fix. The background job finishes on its own afterwards.
- The background history check starts at most once every 5 minutes, instead of after every save.

**What stays the same.** Who may save and every check on the person saving (owner only, still signed in) run before the save, exactly as before. A save made while the machines are catching up is still recorded and then confirmed by the other machine. Nothing about how the machines confirm a change is relaxed.

**What you need to decide.** Nothing. It is small and reversible (Tier 1), and a revert undoes it.
