# Local Verify on the performance cores (ELI16)

**What changes:** on a Mac, the test run that decides whether a change can merge (Local Verify) now starts as its own small macOS background job marked "Interactive". Before this, it started as a child of the agent server.

**Why it matters:** the agent server runs inside tmux, and tmux was started by a plain launchd job. macOS treats everything under such a job as low-importance background work. It gives that work priority 20 and keeps it on the four slow "efficiency" cores of the Mac Studio, while the twelve fast "performance" cores sit mostly idle. Every session, every lint run and every test run shared those four slow cores. On the night of 2026-11-10 the sessions got busy. Every verify lane (unit, integration, end-to-end) then ran out its time limit, so `main` could never be re-checked green. The merge queue held every change for hours. It looked like "waiting on GitHub", but GitHub was not involved: the only required check is our own.

We measured the same fixed piece of work. Started from a session, it took 12.6 seconds. Started as an Interactive launchd job, it took 1.2 seconds. Children of such a job keep the faster treatment, so the test lanes the run starts get it too.

**How it works:**
- The server writes a tiny job description (a plist), asks launchd to start it, and reads back the process id.
- It then watches for the process to end and asks launchd for the exit code.
- Finally it removes the job.

The rest of Local Verify does not change. The run still leads its own process group, so stopping it still works. It still writes to the same log, and its result is still read from the same result file.

**If anything goes wrong:** if launchd refuses to start the job, or the job never reports its id, the server stops the job and falls back to the old way of starting the run. It also logs a degradation report so the fallback is visible. The fallback never starts a run twice.

**What you would notice:** verify runs finish in normal time even while the Studio is busy, and the queue stops stalling behind runs that time out. On Linux nothing changes. To turn it off on a machine, set `localVerify.performanceCores` to `false` in the config.

**Rollback:** turn the setting off, or revert the change. No stored state depends on it.

- Agents are now told where to look when a change is waiting to merge: our own test queue, not GitHub's run list. This stops reports that blame GitHub for a wait it did not cause.
