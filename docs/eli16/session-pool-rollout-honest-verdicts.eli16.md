# The session pool stopped demoting itself over a busy machine — plain-English overview

**What this is about.** When this agent runs on more than one machine, a "session pool" lets a conversation move between machines. It is switched on in stages (dark, then shadow, then live-transfer). An automatic gate moves it up a stage only after a real two-machine failover test passes, and moves it back down when that test fails. Every hour the agent runs that test on itself and records "green" or "red".

**What went wrong on 2026-10-28.** Most of the "red" results that day were not failures of the failover test at all. The machine has a limit on how many test runs may happen at once. When it was busy, the test runner refused to start and said so ("could not start within budget — this is NOT a test failure"). The agent only looked at whether the test process exited with an error, and a refusal exits with an error, so it wrote "red". 25 of the 29 reds that day were these. Each one pushed the pool back down to "dark".

Two more problems made it worse. First, once the pool was demoted, the old red stayed on the books for the higher stage. Every time a fresh green arrived at the lower stage, the pool moved up, and a minute later the gate saw that old red and moved it straight back down. That happened 69 times in one day, and every move was logged as "rollout advanced", which looked like progress. Second, the durable inbound message queue (the feature that keeps your messages safe when a machine is overloaded or a conversation is moving) was only started when the pool's stage was above dark. It had been fully switched on on 10-24, but a demotion to dark meant the next restart would quietly not start it, and the restart would also throw away any messages it was holding.

**What changes.**

1. A test run where no failover test actually ran is now "inconclusive": nothing is recorded, and nothing is promoted or demoted. The agent now asks vitest for a small results file and only counts a run as green or red when that file shows tests really ran, or the test file itself failed (it could not load, or its setup threw), which is a real failure. A refused run leaves an empty results file, so it is easy to tell apart.
2. An old red no longer undoes a promotion that a newer green justified. A red that arrives after that green still demotes, exactly as before.
3. "Rollout advanced" is written only when the stage really reads back as the new stage.
4. The inbound message queue now follows its own on/off switch and the pool's on/off switch, not the pool's stage. A demotion can no longer turn it off.

**What stays the same.** The gate still needs a real green to promote and still demotes on a real red. No setting changes. Fleet agents, where all of this is off, see no difference.

**What you need to decide.** Nothing. This fixes the evidence the existing gate reads; it does not give the gate any new power.
