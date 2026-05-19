---
title: "Codex CLI — Agent rendering"
slug: "frameworks-codex-cli-agents"
framework: "codex-cli"
primitive: "agent"
parent-concept: "specs/instar-concepts/agent.md"
status: "research-pending"
---

# Codex CLI — Agent rendering

## Status: research-pending

Codex 0.130 has subagent / multi-agent capability (the `multi_agent` feature flag is stable + true by default), but the canonical-to-Codex mapping for the Instar Agent primitive needs a research pass before this spec can document concrete rendering targets.

## What's known

- The `multi_agent` and `child_agents_md` feature flags exist in `codex features list`.
- Codex's plugin marketplace + skill model are documented; subagent model less so.
- The `.agents/skills/` discovery pattern (for skills) suggests `.agents/agents/` may be a similar pattern but this has not been verified.

## What needs to be done

1. Test-drive Codex's subagent spawn from a project file (likely `.agents/agents/<name>/` based on the skills pattern).
2. Document the file shape + frontmatter conventions Codex 0.130 expects.
3. Map canonical AGENT.md → Codex-native rendering.
4. Ship `agentParityRule.codex` extending the existing parity-rule registry.

## v0.1 stance

Codex agent rendering is **not yet supported** by Instar's parity layer. Agents work on Claude-routed topics; spawning subagents on Codex-routed topics is currently a manual operator concern (out-of-band Codex CLI usage).

This is the only required primitive with framework asymmetry at v0.1, and it's tracked openly rather than glossed over.
