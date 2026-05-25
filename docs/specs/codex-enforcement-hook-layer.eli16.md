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

## What we found when we actually tested it (the fix that matters)
The first time we plugged the guardrails in and ran real Codex, nothing blocked — the agent happily ran a "wipe the disk" command. It turned out we'd wired it almost right but got two small details wrong, and both had to be fixed before anything worked:

1. **We told Codex "watch which tools?" with the wrong symbol.** We wrote `*` meaning "everything," but Codex reads that as a pattern, and a lone `*` actually matches *nothing*. Changed it to `.*` (the real "everything" pattern) and the guardrail started firing.
2. **Codex hands over the command under a different label than Claude.** Our guard looked for a command labelled "command"; Codex labels it "cmd." So even once the guard ran, it saw an empty command. We taught it to read either label.

After both fixes, we rebuilt from clean source, drove a real Codex session, and told it to run a disk-wipe command — and it got **blocked on the spot**. First time the Codex guard has truly fired in the real tool.

One honest caveat we're handling next: Codex still pops a one-time "do you trust these guardrails?" question, and there's no flag that fully skips it. That would freeze an unattended run, and worse, the agent could choose "don't trust them" and switch its own guards off. The clean fix is "managed" guardrails — ones that run by policy and the agent can't disable. That's a separate design decision, so it's the next step, not part of this fix.

## The bigger principle
This closes the single biggest gap between Claude and Codex agents: structural safety. After this, "Structure > Willpower" holds on both engines, not just one.
