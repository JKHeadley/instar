# Bug: stale machine claims + overload protection

Opened 2026-10-25 from topic 127504 at Justin's request. Issue topic: 10000000832 (Echo Bugs group).

## The example (use this one)
On 2026-10-25 13:50 PDT the Mac Studio told Justin the Mama PC had been "offline since Oct 23".
False: the Mama PC was active all along, but overloaded. Evidence at the time:
- `.instar/machines/registry.json` lastSeen for Mama PC = 2026-10-23T16:25Z (git-synced record, stale).
- Live `GET /pool` at 14:00 PDT: Mama PC `online:false`, `lastSeen:null`, `load:null` for every machine.
- server.log: rope-probe to m_e8c9b243.../tailscale failing (dial-failed: fetch failed), 8 consecutive.
An overloaded machine looked identical to a dead one, and I reported it as dead instead of "unknown".

## What Justin asked for
1. Stale claims: never state a machine's state from an old record; say how fresh the evidence is, and "unknown" when it is.
2. Self-protection: each machine protects its own resources and moves work to another machine when it needs to.
3. Very robust, trustworthy load insight: several independent checks plus an intelligent assessment (efficient models like Jev), so decisions rest on high-quality signal.
4. The mesh knows every machine's current state at any moment.
5. A reserved capacity floor on every machine, dedicated to mesh communication: always enough to run one session that can assess and act.
Why critical: topics going silent and many other issues later traced to overload.

## How the work is done
Multiple frontier models: GPT-6 Astra, Gemini 4 Argon, and Opus 5.5 (Justin, 2026-10-25 14:00).
Use them for the design and for review; reuse existing 1.x pieces first (load-assess.sh, ResourceLedger,
ProcessFootprintMonitor, rope-health, quota-aware placement, SelfActionGovernor).
