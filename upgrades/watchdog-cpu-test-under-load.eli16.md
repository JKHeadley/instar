# Watchdog CPU test: wait for the reading instead of assuming it

**What was wrong.** One integration test checks that the watchdog can see a busy process using CPU. It started a process that spins at full speed, waited exactly 1.5 seconds, and expected the process to have used more than 1 second of CPU. On a busy machine a spinning process gets less than a whole core, so it can fall short, and the test failed even though the watchdog was fine.

**What changes.** The test now checks every quarter second, for up to 10 seconds, until the process has used more than 1 second of CPU. The 1-second bar is the same one the watchdog uses, so the test checks the same thing; it only waits longer when the machine is busy.

**Measured.** With all 16 cores kept busy, the old test failed and the new one passed. Alone, both pass.

**What to decide.** Nothing.
