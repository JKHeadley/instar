# Targeted verification, internal reviewer (general-purpose subagent, Claude family). Raw output, transcribed verbatim by Echo from the agent's result at 2026-11-11 ~15:05 PST

**Fix 1: RESOLVED.** Only runs whose `launch.applied` shows the expected `thinkingMode` count as treatment. Baseline runs must have no `thinkingMode` and no effort pin. So dropped or overridden runs no longer count. Runs with an `unknown` CLI version are left out and reported separately, so two `unknown`s can't match each other anymore. Alternating the two arms by day keeps both on the same CLI versions. I found no new design problem: having too few matched runs still gives `unknown`, never a pass.

**Fix 2: RESOLVED.** The spec keeps `recordStart` exactly where it runs today, inside the spawn's `.then` (`JobScheduler.ts:~3156`), with `activeRunIds.set` right after it. Completion matching (`~3540`) is unchanged.

A later `recordLaunchVersion` can't overwrite a completion row. If it copies `recordReflection` (`JobRunHistory.ts:356`), it reads the latest row for the run (`findRun`: the last entry wins), adds the version field and appends a new copy. Node runs each of these steps to the end before anything else, so the two writes can't interleave:
- Probe settles after completion: the new copy keeps the completed result and adds `cliVersion`.
- Probe settles before completion: `recordCompletion` reads the patched row (still `pending`) and keeps `cliVersion` in the completed row.

Either way both fields survive. One thing the spec should say: the helper must copy the latest row whole and touch only `cliVersion`, never rebuild the row from the start data.
