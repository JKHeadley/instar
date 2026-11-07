# Convergence report: engine and model changes for every conversation (part 1 of 3)

Six review rounds, the cap for Tier 2, each by an independent reviewer subagent that read the spec against the code. Every round through round 5 found design defects. Round 6 found none, only a missing sentence, which was added. No cross-model pass ran.

## ELI10 overview

Every kind of conversation (Instar app, Slack, Telegram) can switch its engine and model from the phone or the dashboard. The session restarts at once on the new engine, keeping the conversation. Moving between machines, and giving every session a conversation, are parts 2 and 3.

## What the rounds changed

- **Round 1: the scope was split into three parts.** The machine-move half had four defects that would let two machines serve one conversation or refuse replies: lease-tied reply checks, an unreplayable forward, app keys caught by the Slack forward arm, and a drain that never closed app or Slack sessions. Moving is now part 3, with its own spec. Part 1 also gained per-kind orchestrator ports, a defined message-free app start, an honest authority rule (an MSP's app conversation is refused from the owner's side), and the phone route's reference grammar.
- **Round 2.** Slack resume ids carry their engine. The phone converts a reference to its profile key. An app write must be on the machine that serves the conversation. Ports match the orchestrator's sequence. Fleet model switching is stated as the existing write regime.
- **Round 3.** Slack resume writers get the orchestrator's write gates, and records carry where the id came from.
- **Round 4.** The gate is chosen by engine (Claude or Codex), and the Slack port offers both views.
- **Round 5.** Both views park one record. Spawns report what they landed on. A message during a switch waits for the start. The escalation lease is released for every kind. The new callsite is registered.
- **Round 6.** A held message is dispatched normally if the start is refused.

| Round | Design defects | Spec changes |
|---|---|---|
| 1 | 10 + 6 minor | split into three parts; ports, startApp, authority, references |
| 2 | 6 | Slack resume engine, key conversion, owner check, port shapes, regime words |
| 3 | 2 + wording | Slack write gates, provenance |
| 4 | 2 | gate by engine, Codex view |
| 5 | 4 + naming | one-record park, recordSpawnSuccess, in-flight hold, escalation port |
| 6 | 0 | the held message's fallback |
