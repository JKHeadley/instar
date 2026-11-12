# Trial option B: stopped at the round-2 check, with a smaller option proposed

**Health.** Design findings went from 9 in round 1 to 7 in round 2 (Astra 5, Fable 2). They did not halve, so the stop rule fires. Every remaining finding is about evidence bookkeeping for a custom trial journal:
- checking that the token count is complete (transcripts are deleted after 14 days; events can land before the job's run is bound);
- standby machines writing attempt rows;
- queue and retry attempts that never close;
- keeping the journal reliable across a restart;
- team access to the report.

Both reviewers say the design is still the simplest version of option B. The catch is that a custom, honest journal of every attempt is a lot of machinery for a two-week descriptive look.

**Smaller option ("B-lite"): no new code.**
- Once the job-effort piece is merged, Instar's existing per-job cost report (`JobCostReport`, with a frozen baseline) and run history already give, for each job: runs, outcomes and weighted tokens per window.
- B-lite: set `thinkingMode: low` on `bugs-overseer` for 7 days and compare against the baseline week the cost report already froze.
- It's descriptive only, as you chose. You get the two weekly numbers side by side, plus the run-history success rate, with links.
- Its limit, stated plainly: the two weeks may run on different engine versions, and the comparison isn't controlled.

**Recommendation:** B-lite. If its numbers show a large saving and no breakage, we'd only then consider the full B trial or a rollout to more jobs.
