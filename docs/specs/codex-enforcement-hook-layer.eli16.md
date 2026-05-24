# Codex Enforcement-Hook Layer — in plain terms

## The problem
instar has safety guardrails — things that check "is this action safe?" or "is this response coherent?" right before an agent does something, and can say **no, blocked**. On agents running **Claude**, these guardrails really work: they're wired into Claude's checkpoint system, so the agent literally can't skip them.

On agents running **Codex**, those same guardrails are only *written into the instructions*. Nothing actually stops the agent from crossing them — it's trusting the agent to remember and behave. That's exactly the "rely on willpower" setup instar is built to avoid. So Codex agents have been running with **zero real enforcement**.

## The good news
Codex has the **same kind of checkpoint system Claude does** — little programs that run right before a risky step and can block it (we verified this against Codex's official docs, didn't assume). The guardrail logic already exists on instar's side and is shared. We just never plugged our guardrails into Codex's checkpoints. So this is **connecting existing wiring, not building new machinery**.

## What we're building
1. A step that, when we set up a Codex agent, registers our guardrails into Codex's checkpoint system (so a Codex agent gets the same can't-skip protection a Claude agent has).
2. A migration so Codex agents **already out there** get it on their next update — not just brand-new ones.
3. We use Codex's bonus "permission" checkpoint too — but carefully: it routes to instar's own trust logic and decides **automatically**, with **no human prompt**. So it adds safety without ever turning into a "waiting for approval" stall. Codex stays in full-autonomy mode; we just intercept the event to apply our gate, never to ask the operator.

## How we'll know it works
We'll test it live on codey (the sandbox Codex agent): trigger a bad action and watch the guardrail actually block it, and a normal action sail through. Not a mock — a real block on the real agent.

## The bigger principle
This closes the single biggest gap between Claude and Codex agents: structural safety. After this, "Structure > Willpower" holds on both engines, not just one.
