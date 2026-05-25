# Enable-layer coherence (the low-risk half) — plain-English version

## What this is

When we went to "turn on every feature," we found some of the on/off switches were wired to nothing — flipping them did nothing, or errored. This fixes the three cases where that's an objective bug with one obviously-correct answer. (The cases that need a real judgment call from you — like retiring the "act without asking" autonomy path — are deliberately NOT in here; they're a separate piece waiting on your decision.)

## The three fixes

1. **The telemetry catch-22.** Telemetry had a chicken-and-egg bug: the "turn telemetry on" button needed the telemetry engine to already be running, but that engine only got built at startup if telemetry was already on. So you could never turn it on through its own button. The fix: always build the engine (it's cheap and does nothing until switched on — it already refuses to send anything while off, and there are tests proving that). Now the button works. (Your telemetry stays off — this just unbreaks the switch for anyone who wants it.)

2. **Two dead switches.** The "dispatches" and "feedback" feature switches pointed at settings the system flatly refused to change, so flipping them just errored. Both are real settings — they just weren't on the list of things the switch is allowed to touch. Added them to the list. Switches work now.

3. **A guard so this never happens again.** I added a build-time test that checks every feature's on/off switch actually points at something real. If anyone ever ships a feature with a switch wired to nothing, the build fails. This test earned its keep immediately — while writing it, it caught the "feedback" switch bug on its own (I only knew about "dispatches" going in).

## Why it's safe

- The telemetry change can't leak anything: the engine refuses to send while off, and that's covered by existing tests. Worst case of any bug in this whole change is "behaves exactly like today."
- The two switch fixes only *enable* switches that were broken — they don't change any default. Your features stay exactly as on/off as they are now.
- The guard is just a test; it changes no behavior.

## What you approved

The low-risk, objective slice: unbreak the telemetry button, unbreak the two dead switches, and add the guard that keeps switches honest. The judgment calls stay parked for your explicit yes.
