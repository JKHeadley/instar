<!-- bump: minor -->

## What Changed

**Coherence Journal P1.1** (COHERENCE-JOURNAL-SPEC, converged + approved):
every machine now writes per-kind append-only event streams under
`state/coherence-journal/` — `topic-placement` (emitted at all 8
ownership-CAS sites with caller-known reasons, paired by a new CI lint),
`session-lifecycle` (derived at the saveSession funnel; `reaped` emitted
beside the reap-log), `autonomous-run` (60s observer + stop-funnel seam —
no phantom-live runs). Writer is non-blocking (memory enqueue + 250ms
flusher; zero sync I/O in caller stacks), crash-safe (repair-counted
truncation, incarnation-fenced restore detection), single-process-locked,
schema-typed with artifactPath jail. Plus: the State-Coherence Registry is
now machine-readable (`src/data/state-coherence-registry.json`, 66
categories) with `lint-state-registry` failing CI on undeclared durable
stores. Dark-ship: `multiMachine.coherenceJournal.enabled ?? developmentAgent`.

## What to Tell Your User

Nothing user-visible yet — this is the foundation layer. Your agent's
machines have started keeping reliable local "diaries" of where
conversations live, when sessions open/close, and where autonomous runs
put their files. The pieces that let you ASK about that history from any
machine arrive in the next two updates (the query API, then
machine-to-machine sync).

## Summary of New Capabilities

- None user-invocable yet (P1.2 ships `GET /coherence/journal` + the
  agent-facing docs). Internal: `CoherenceJournal` writer,
  `StateManager.guardJournalWrite`, machine-readable state registry, two
  new CI lints.

## Evidence

- 56 new tests (writer 33 incl. fault-injected non-blocking emit +
  kill-9-window re-mint precision; wiring 9 with independent oracles;
  guard 7; registry lint 7); 357 tests green across the affected surface;
  both lints clean on the real tree; tsc clean.
- The cas-pairing lint caught a real unpaired site (POST /pool/transfer
  release) during development — the structural guard works.
