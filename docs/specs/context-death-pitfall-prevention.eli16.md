# Context-Death Pitfall Prevention — Plain English

## What This Is

Sometimes an agent stops in the middle of real work and explains the stop by saying the session is getting long, the context window might run out, or a fresh session would be cleaner. That sounds responsible, but in this system it is usually the wrong move. Instar already has recovery machinery that reloads identity, recent memory, and conversation context when a session compacts or restarts. If the work has a durable plan, committed code, a ledger entry, or another concrete artifact, the agent should continue from that artifact instead of making the user ask again.

This spec creates a guard for that failure mode. The guard watches Stop events, gathers evidence about whether the agent has a real reason to stop, and asks a server-side authority whether the stop should be allowed or turned into a continuation reminder.

## What Already Exists

Instar already has several pieces that make continuation safe: session-start context, compaction recovery, durable memory files, project maps, and hook events. It also already has a server route family for the stop gate and an authority called UnjustifiedStopGate. Those pieces are useful only if they are wired into the live server and connected to the actual Stop hook path.

## What Is New

The missing part is the circuit. The server must construct the authority and database. The hook installer must put a small router into the Stop hook chain. The router must ask the server for the hot-path state, then submit the Stop event for evaluation when the gate is in shadow or enforce mode. Shadow mode records what would have happened without blocking the agent. Enforce mode can block only when the server authority says the agent should continue.

The first rollout is shadow mode. That means no user workflow changes and no surprise blocking. It lets us collect real Stop-event evidence before any later decision to enforce.

## Safeguards

The hook fails open. If the server is down, the payload is malformed, the gate is off, the kill switch is active, compaction is already happening, or the authority/database cannot initialize, the agent is allowed to stop. The hook itself does not decide whether the stop is unjustified; it only sends evidence to the server. The LLM authority remains the decision point.

The mode is persisted so restarts do not silently erase the operator's chosen setting. The decision log is stored in SQLite so later review can inspect what the gate saw. Existing autonomous Stop behavior stays compatible, but the stop-gate router runs first when both are present so shadow telemetry is not hidden.

## What The Reader Decides

The key decision is whether shadow-mode evidence looks trustworthy enough to flip enforcement on later. This change does not make that flip. It only wires the observation path so the next decision can be based on real data instead of guesses.
