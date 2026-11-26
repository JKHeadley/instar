# Side effects: session-pool default-on, step 1

**Second-pass reviewer:** independent general-purpose subagent (Opus 5.5), concurred after fixes

## Summary

Read-only readiness report, an hourly history row on agents with peers, one printed note in pair and join,
corrected stage text, and an awareness line. No config default, stage, routing or promotion change.

## What this touches

- `src/core/MachinePoolRegistry.ts`: report-only slot for the last direct advert; placement never reads it.
- `src/core/poolReadiness.ts` new; `src/core/leaseMediumSelection.ts` gains `gitLeaseHasNoRemote`.
- `src/commands/server.ts`: boot-cached takeover reading after the lease medium is chosen; report wired on
  the existing 30-second pool beat.
- `src/server/routes.ts`: `GET /session-pool/readiness`. `src/server/CapabilityIndex.ts`: named under the `session-pool` prefix.
- `src/commands/machine.ts`: printed note. `src/core/PostUpdateMigrator.ts`, `src/scaffold/templates.ts`: awareness line.
- `src/core/types.ts`, pool spec text, one comment: `shadow` described as it behaves.

## Risks considered

- **Blocking the pool beat.** The log tick does one registry read and, once an hour, one small append, inside
  a try/catch. It cannot throw into the beat. `refreshPool` still runs first.
- **`/health`.** Not touched. The git read happens once at boot, with a 2-second timeout.
- **Boot.** One extra `git remote` read, only where the git lease was chosen; an error reads as unknown.
- **Single-machine agents.** No peers means no log file and no folder; the route answers `single-machine`.
- **False comfort.** `ready` could read as a promise. The report carries a note saying it is not, the start
  line says it cannot prove a login, and takeover is never reported `ok`.
- **Log growth.** One row an hour, about 2 KB. No rotation in this step: about 17 MB a year per machine.

## Authority

None added. Nothing reads the report to allow or block anything.

## Rollback

Revert the release. No state depends on it.

## Second-pass review

**Reviewer:** independent general-purpose subagent (Opus 5.5), read the diff and this artifact cold
**Independent read of the artifact:** concur (after two rounds of fixes)

First read raised seven: `ready` could never be true on a real peer, because capacity read a field that never
crosses the wire, and the fixture hid it; a coarse beat wiped the quota and channel signals; a peer never reached
read false clock and channel lines; the pair note could print on a git-ignored registry; `impaired` read ok; a
wired single-machine agent got the full report; and no test reached `ready` through real data. All fixed: the e2e
now feeds a real payload through the real narrowing and registry. Re-read raised one more: a fresh report with
an unknown verdict read ok. Fixed. Final word: concur.

## Evidence pointers

Live readings on Echo, 2026-11-03: `GET /health` lease medium, `logs/`. Spec review rounds: `docs/specs/reports/session-pool-default-on-convergence.md`.
