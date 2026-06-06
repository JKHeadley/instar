# Sentinels stop failing healthy sessions over a stale transcript pointer

When a session gets throttled by the API, a watchdog (the RateLimitSentinel) nudges it back awake and then checks "did it actually recover?" by watching the session's transcript file grow — output means alive. Same trick for compaction recovery (CompactionSentinel).

The bug: the server remembers WHICH transcript file belongs to a session by its conversation ID — but that memory was write-once. The first time a session ever reported its ID, it was frozen forever. When a session later respawned or resumed (which gives the conversation a NEW ID and a NEW transcript file), the record kept pointing at the OLD file — one that never grows again, or never even existed. On this box, 6 of 7 checked session records pointed at transcripts that didn't exist.

The consequence: for any such session, "did it recover?" could literally never come back yes. The watchdog would nudge 6 times over ~20 minutes — against a session that was actively answering the user the whole time — then falsely declare it stuck ("no jsonl growth after 6 attempts"). This happened live on 2026-06-06: one session got 6 pointless wake-up nudges mid-conversation, and another was falsely escalated at 2am.

Two fixes, root cause first:

1. **The pointer now follows the conversation.** Every hook event a session sends carries its current conversation ID; the record now updates whenever that ID changes (a respawn/resume rotates it), instead of refusing to ever change. A rotation is logged so drift is diagnosable.

2. **A stale pointer degrades instead of failing.** If the recorded ID's transcript file is missing, both sentinels now fall back to watching the newest transcript in the project — the exact same heuristic they already use when no ID is known at all — instead of returning "no file, recovery unverifiable, forever." When the exact file exists, behavior is byte-for-byte unchanged (a sibling session's output still doesn't count as your recovery).

Regression tests replay the live incident: phantom ID + a growing real transcript must produce "recovered", never a false escalation.
