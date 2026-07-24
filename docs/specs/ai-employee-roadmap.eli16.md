# ELI16 — The AI-Employee Roadmap

This change adds one document to the repo: `docs/AI-EMPLOYEE-ROADMAP.md`. It is
a map, not machinery — nothing about how any agent behaves changes.

Here's the idea in plain words. Instar's end goal is an agent that works like a
real employee for an organization. That means three big things: it runs across
several machines (3–4) while still being ONE coherent identity — your
conversation, memory, and work follow you, not the box; it is a first-class
citizen of workplace chat — today Telegram, next Slack — behaving like a
considerate human coworker (threads, channels, DMs, no flooding, honest about
what it's doing); and it serves every staff member at once without mixing them
up — each person gets their own permissions, preferences, and verified
identity, with no bleed between principals.

The roadmap's method is: prove all of that on an apprentice first. The
apprenticeship program already runs a prototype agent (the mentee) under a
mentor's observation, and the mentor talks to it through the same chat channels
a human would use — so every rough edge is discovered by an agent before a
human ever hits it. The document maps each of the three capabilities onto a
ladder of stages (A1→A4 for multi-machine, B1→B3 for Slack, C1→C3 for
multi-principal), each ending in an explicit exit bar.

The key rule: work can happen in parallel, but **graduation is serial and
evidence-gated**. A stage doesn't pass because it feels done — it passes when a
recorded, artifact-backed acceptance says the exit bar is met (clean incident
ledgers, live test-harness runs on the real surface, guards graduated from
observe-only to enforcing). Only when all three bars are green does the
production agent inherit the configuration — as a staged enable of
already-proven pieces, not a rebuild.

Again, to be explicit: this PR is documentation only. No code paths, no config
keys, no routes, no gates, no behavior changes for any deployed agent.
