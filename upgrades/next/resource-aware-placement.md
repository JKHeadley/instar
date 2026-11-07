# Heavy work goes to big machines with room, never to small ones

## What Changed
Placement used to compare machines by their raw load average, which ignores size: a 10-core Mac Mini and a 16-core Mac Studio at the same number looked equally busy, and a machine with no current load number scored as the idlest. Placement now compares per-core load from fresh evidence only (older than a minute does not count) and ranks machines it cannot measure last. A machine counts as big enough for heavy work (builds, full test runs, simulators) at 12+ cores and 32+ GB, and heavy work goes only to such a machine with room right now; otherwise it waits with a named reason. Local Verify hand-offs follow the same rule, so a small machine no longer receives full verifies. Jobs can declare `workWeight: "heavy"`. Each machine can override the size rule with `multiMachine.placement.heavyWork` (`allow` / `deny` / `auto`), advertised in its load report. New routes: `GET /pool/placement/preview` (read-only: where a piece of work would go and why, per machine) and `POST /pool/heavy-work/spawn` (starts a headless helper session on the chosen machine through that machine's own `/sessions/spawn`). `/sessions/spawn` now answers admission, spawn-cap and duplicate-name refusals with 409 and a code instead of 500.

## What to Tell Your User
When I run on several computers, I now pick by each computer's size as well as how busy it is. Heavy work like builds and full test runs only goes to a big computer that has room, never to a small one like a Mac Mini, and when none has room the work waits instead of piling on. I can also hand heavy helper work to another computer instead of loading the one I'm on. If you want a particular computer to take heavy work anyway, or to stop taking it, I can set that for that computer.

## Summary of New Capabilities
- Size-aware placement: per-core load from fresh evidence; unmeasured machines rank last.
- Heavy work only on big machines with headroom (12+ cores, 32+ GB), with a per-machine override.
- Local Verify peers skip small, busy or unmeasured machines and try the least-loaded first.
- `workWeight` on jobs; a heavy job skips a small machine while a big one is online.
- `GET /pool/placement/preview` and `POST /pool/heavy-work/spawn` for placed helper sessions.

## Evidence
Unit, integration and e2e tiers listed in upgrades/side-effects/resource-aware-placement.md; a read-only preview on Echo's real five-machine fleet chose the Mac M5 Pro for heavy work and refused the Mac Mini as too small.
