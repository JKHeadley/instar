# Side-effects review — native-module health banner

## The change

A vitest globalSetup that probes better-sqlite3 once and, only on failure, emits one
setup line plus a single banner at teardown (rendered after the run summary). Adds no
detection: it relocates a diagnosis instar already produces to where a reader looks.

## Review answers

1. **Over-block.** The dominant risk, because this runs before EVERY suite on every
   machine. It writes nothing and returns no teardown on a healthy probe — pinned by a
   control. It never fails, skips, or changes an exit code. And it cannot throw: the
   probe is wrapped even though the default probe already catches internally, because
   an exception here would take down every run — strictly worse than the degraded
   state it describes.
2. **Under-block.** It watches ONE module. A different native module breaking silently
   gets no banner. That is deliberate: generalising to "native modules" from a single
   incident would be inventing a class, which is the exact over-read that caused the
   incident. It also cannot detect a module that loads, opens a DB, and misbehaves
   later — the probe is a smoke test, not a health monitor.
3. **Level-of-abstraction fit.** globalSetup is the right layer: a per-file check is
   invisible to the next file (this file's sibling records that lesson explicitly),
   and teardown is the only hook that runs after the summary.
4. **Signal vs authority.** Pure signal. It gates nothing and rejects nothing.
5. **Interactions.** Ordered AFTER `build-dist.globalSetup.ts`, so its teardown runs
   FIRST (teardowns run in reverse) and the banner sits closest to the summary. It
   shares no state with any other setup.
6. **External surfaces.** None. Test-run stderr only; nothing ships to an agent or a
   user, no file is written.
7. **Multi-machine posture.** Machine-local BY DESIGN — it reports on THIS checkout's
   node_modules. There is nothing to replicate; a peer's binary state is irrelevant to
   a local run.
8. **Rollback cost.** Remove the config entry, or delete the file. No migration, no
   state, no consumer.

## Class closure — what this does NOT close

- **It does not prevent the cause.** An install that skips its postinstall still
  produces a broken checkout; this only makes the consequence readable. The hygiene
  fix (never installing with `--ignore-scripts`) is a habit, not code, and I am not
  claiming otherwise.
- **Only better-sqlite3**, and only at run start.
- **Placement depends on vitest rendering teardown output after the summary.** That is
  measured on vitest 2.1.9 here, not guaranteed by contract. If a future version
  reorders it, the setup line still fires at the top — which is why both exist.

## Evidence

- 11/11 in `tests/unit/native-module-health-banner.test.ts`; `tsc --noEmit` exit 0 via
  the real binary; full lint chain exit 0.
- **Placement proven end-to-end.** The broken branch was forced by mutation and a real
  suite was run; the banner rendered AFTER `Test Files / Tests / Duration`. **My first
  mutation attempt applied 0 times and its own count control caught it** — that run
  would have "passed" while proving nothing, which is the defect class this whole
  change is about. Re-applied against the real line (count asserted at exactly 1),
  re-run, restored byte-exact with 0 markers.
- The incident's real signature is pinned: a module that LOADS but cannot open a
  database is reported BROKEN. A require-only probe would have called the entire
  outage healthy.
