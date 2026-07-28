# Codex Enforcement-Hook Layer — in plain terms

This serves Instar's **Structure beats Willpower** principle: safety must be enforced by the runtime, not remembered by the agent.

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

## What we found when we actually tested it (the fix that matters)
The first time we plugged the guardrails in and ran real Codex, nothing blocked — the agent happily ran a "wipe the disk" command. It turned out we'd wired it almost right but got two small details wrong, and both had to be fixed before anything worked:

1. **We told Codex "watch which tools?" with the wrong symbol.** We wrote `*` meaning "everything," but Codex reads that as a pattern, and a lone `*` actually matches *nothing*. Changed it to `.*` (the real "everything" pattern) and the guardrail started firing.
2. **Codex hands over the command under a different label than Claude.** Our guard looked for a command labelled "command"; Codex labels it "cmd." So even once the guard ran, it saw an empty command. We taught it to read either label.

After both fixes, we rebuilt from clean source, drove a real Codex session, and told it to run a disk-wipe command — and it got **blocked on the spot**. First time the Codex guard has truly fired in the real tool.

## The "do you trust these guardrails?" prompt (now handled too)
Codex pops a one-time "do you trust these guardrails?" question before running them. For an agent working unattended that's a problem twice over: it would freeze waiting for an answer, and the prompt even offers a "no, don't run them" option — so the agent could switch its own guards off.

We first assumed the only fix was "managed" guardrails installed at the system level. But testing real Codex showed a cleaner answer: a launch setting (`--dangerously-bypass-hook-trust`) that tells Codex "these guardrails are pre-vetted, run them, don't ask." Since **instar is the one that starts Codex**, instar adds that setting itself — the agent never sees the prompt and can't strip the setting out of its own startup. We went with this per-agent approach instead of a system-wide install because it's contained: it doesn't touch the rest of your machine and doesn't interfere with Codex when *you* use it personally (your own launches still ask normally, which is right). Proven live: with the setting on and trust never granted, the guard still blocked a disk-wipe command. It only switches on for Codex versions new enough to understand the setting; older ones fall back to the safe (just-prompts) behaviour.

## The bigger principle
This closes the single biggest gap between Claude and Codex agents: structural safety. After this, "Structure > Willpower" holds on both engines, not just one.
