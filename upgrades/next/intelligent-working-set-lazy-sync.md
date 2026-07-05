## What Changed

Files an agent writes **interactively** during a conversation (a report or analysis it saves under
`.instar/` with no autonomous run behind it) can now follow that conversation across machines — the
one case the existing working-set engine missed. A new durable record of those interactive writes is
added as a third source to the computed working-set manifest, replicated cross-machine on the existing
mesh working-set path, and surfaced to the agent as an advisory session-start grounding note ("here are
the files you recorded for this conversation"). It ships **dark** on both axes: recording is off by
default (`coherenceJournal.workingSet.recordInteractive`), and cross-machine row replication stays off
until `multiMachine.stateSync.workingSetArtifact` is enabled.

## What to Tell Your User

⚗️ Experimental and off by default — nothing changes until you turn it on. When enabled on a multi-machine
setup, a report I write for you in a conversation on one machine will follow that conversation if it moves
to another machine, and I'll be reminded at the start of each session that those files exist so I can fetch
and re-verify them instead of losing track of my own work. On a single-machine setup it does nothing. It's
deliberately scoped to my own private work area — it does NOT sync your project's source files (those are
already handled by git; a broader project-file sync is a separate decision that needs your sign-off).

## Summary of New Capabilities

- New `working-set-artifact` replicated store + `WorkingSetArtifactManager` (durable rows at
  `.instar/working-set/artifacts.json`, owner-only tombstone, 30-day record GC).
- `computeWorkingSet` gains a third source (interactive `ready` rows), unioned at the serve boundary
  through the identical jail + secret-scan + caps pipeline (no jail widening, no cap lowering).
- `POST /coherence/working-set/record` + a built-in PostToolUse Write/Edit recorder hook (fire-and-forget,
  dark by default); `GET /coherence/working-set` (read) + `GET /coherence/working-set/session-context`
  (advisory grounding block, wrapped in the `<replicated-untrusted-data>` envelope).
- Migration Parity: existing agents receive the recorder hook, the settings.json PostToolUse matcher, and
  the config defaults on update.

## Evidence

- 138 unit + route-integration tests green (store, manager, dual-registry wiring, HTTP route surface,
  manifest union, journal, generated-hooks-parse, migration-parity).
- `tsc --noEmit` clean; generated recorder hook passes `node --check`; generated session-start hook passes `bash -n`.
- Dark-ship verified end-to-end: an omitted `stateSync.workingSetArtifact` produces no replication emit;
  `recordInteractive` code-default false makes the recorder hook a fast no-op.
