# GSD Integration Spike — Live Findings

> Updated as findings surface during the build.

## Finding 1: GSD agents are NOT reachable via the parent agent's Agent tool

**Date discovered:** 2026-05-22, ~30 min into autonomous run

**What I assumed in the integration plan:** That Echo's Agent tool would discover gsd-planner / gsd-executor / gsd-verifier in `~/.claude/agents/` automatically, since that's the standard Claude Code subagent location.

**What I found when I tried it:** Echo's Agent tool returned `Agent type 'gsd-planner' not found. Available agents: claude, claude-code-guide, Explore, general-purpose, Plan, statusline-setup`. The agent discovery is gated to a specific enumerated set; ~/.claude/agents/* files are NOT exposed to the Agent tool of this Echo session.

**Why this matters:** GSD's agents are designed to be spawned by GSD's slash commands inside a Claude Code session where the `gsd-*` skills are installed. The slash commands use Claude Code's Task tool with `subagent_type: "gsd-planner"` etc. — and that works because Claude Code's slash-command runtime discovers them. But when a *different* orchestrator (Instar's /build) tries to spawn the same agents from its own Agent tool, the discovery layer doesn't expose them.

**Implications for the integration:**

The clean composition I drew up in the integration plan — "Instar /build spawns gsd-planner at Phase 1, gsd-executor at Phase 2, gsd-verifier at Phase 3" — is structurally blocked. The Agent tool simply does not know those subagent types exist.

There are three workarounds, ranked by ugliness:

1. **Subprocess via `claude -p`** — Instar /build shells out to a new Claude Code session per GSD agent invocation. The subprocess CAN see gsd-* skills + agents and CAN invoke them. But: each invocation is a fresh LLM call layer (slow), the result has to be marshaled back through stdin/stdout, and the persistent agent context (Telegram, memory, autonomous loop) doesn't propagate inward. Heavy.

2. **Re-synthesize gsd-planner's prompt** (~1300 lines) as the brief to a general-purpose subagent. Cheaper than (1), but the gsd-planner prompt @-includes many other reference files; we'd have to either flatten all of those into one mega-brief or accept that the agent operates without full context. Also: by the time we've re-synthesized it, we've essentially imported the methodology into Instar anyway — at which point why not just internalize it as an Instar skill?

3. **Internalize the methodologies as Instar primitives** — take the 4-tier verifier protocol, the slopcheck pattern, the analysis-paralysis guard, the TDD gate, the auto-fix-vs-ask rule numbers, etc. and re-implement them as Instar hooks / skills. They become first-class Instar capabilities that protect ALL Instar work, not just GSD-routed work. This is the original "cherry-pick" path from the audit.

**Architectural reading:** GSD's design assumes IT is the orchestrator. The whole pipeline (slash command → spawn specialist → write to .planning/ → return to orchestrator → spawn next specialist) is internally consistent because GSD owns the loop. Instar wants to BE the orchestrator (it has its own /build pipeline, autonomous mode, message routing, persistence, hook stack). There's an impedance mismatch: two orchestrators can't both own the loop.

**What this means for the spike's decision gate:** The "use GSD invisibly inside /build via Agent-tool spawning" path is blocked. The remaining options are (1) subprocess (heavy, breaks persistence integration), (2) re-synthesize prompts (no different from internalizing), or (3) cherry-pick methodologies. Option 3 is the most honest answer.

**Pivot for the rest of this build:** Build all of Layer 1 through Instar's normal /build path. The GSD-vs-Instar comparison becomes "we tried to wire it, here's why it didn't fit cleanly, here's what's worth borrowing as Instar primitives instead." The comparison data shifts from "speed/quality on each path" to "structural fit analysis + cherry-pick list."

## Finding 2: Global install side-effects (from Task 2)

GSD installs globally into ~/.claude/ — no project-scoped install path. 67 skills, 33 agents, 9 hooks added to settings.json without consent, statusline replaced. The hooks were removed manually before they could interfere with Instar's hook stack (backup at `/tmp/echo-claude-settings-pre-gsd-restore.json`).

For a user-invisible integration, this would be unacceptable — installing GSD into a user's agent silently modifies their settings. We'd need either a forked GSD that supports project-scoped install OR a wrapper that installs into a sandboxed directory and exposes a subset.

## Findings (more to come as the Layer 1 build proceeds)
