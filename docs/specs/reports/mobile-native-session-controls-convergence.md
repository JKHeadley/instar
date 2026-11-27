# Convergence report: the app's session screen reaches the dashboard's controls

## How it was reviewed

Three rounds, the cap for this tier, each by an independent reviewer subagent reading the spec and the code. No cross-model pass ran. Round 1 found 4 design defects and 4 minor points, round 2 found 4 design defects in or around the fixes, and round 3 found 1 narrow reliability defect and no security defect. All were fixed. Round 3's fix was not reviewed again, because the cap was reached.

## ELI10 overview

The app's session screen gets the dashboard's controls, on the dashboard's own routes. What ends, moves or starts a session needs Face ID each time. A phone can also reach sessions on other machines, and the machine running the session keeps its own rule about typing.

## What the reviews changed

- **Another machine's PIN could reach a phone through History.** That machine now reads its own record and removes its own secrets.
- **Removal could break an answer.** It rewrote serialized JSON, so a number holding a PIN crashed the parse. It now works on string values only and leaves fields that name something (ids, times, a saved path).
- **A file sent to another machine skipped that machine's typing rule and session check.** It has a relay route with the same checks.
- **A line naming a machine could run here when this machine has no mesh id.** Action lines and device writes both refuse this now.
- **A secret straddling a cut could leave a fragment.** The transcript reader now removes before it clips.
- **A move could hit a 408 while it still landed.** The route has its own budget, past the machines read plus the transfer, and the app waits past that.
- **Smaller points.** A signed choice that the route would drop is refused at signing. `none`, `here` and `auto` can't be values. A move's target must be a machine in the roster, with the read having worked. 200 MB of attached files per rolling hour per machine.

## Iteration summary

| Round | Findings | Changes |
|---|---|---|
| 1 | 4 design, 4 minor | History relay, string-only removal, attachment relay, no-mesh refusal, tighter action fields, hour limit |
| 2 | 4 design | Remove before clip, route budgets, refusal for device writes, exempt keys |
| 3 | 1 reliability | Move budget |

## Open

Face ID writes and the relay have not run from a real phone or between two real machines. The tests cover them with real signatures and a stand-in peer.
