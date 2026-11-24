# Codex calls that read outside text run with an explicit tool-free profile

<!-- bump: patch -->

## What Changed

SEC-175. A Codex judgment call marked `noLocalTools` (used when the prompt holds outside text, today the ecosystem idea review) now runs with one explicit tool-free profile, `src/core/codexToolFreeProfile.ts`. Besides the switches it already had (shell, unified exec, apps, browser, computer use, MCP servers), it now also sets `web_search="disabled"` and turns off image viewing, image generation, sub-agents and plugins. The new switches use `-c` settings, which an older Codex ignores, so no Codex version starts failing. Ordinary Codex calls are unchanged.

## What to Tell Your User

- **Codex helper**: "When I ask Codex about text that came from outside, it now runs with every tool off, web search included."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Tool-free Codex calls also turn off web search and the remaining built-in tools | Automatic |

## Evidence

- `tests/unit/sec175-codex-tool-free-profile.test.ts`: through the real provider and a recording stand-in for the Codex binary, a `noLocalTools` call carries `-c web_search="disabled"` and every profile switch, in both the exec-json and plain modes, and an ordinary call carries none of them. A coverage test requires a closing rule for every built-in tool the openai-codex adapter registers.
- By hand on codex-cli 0.171.0, `codex features list` with the profile's switches shows view_image, image_generation, multi_agent and plugins off; with the old switches they were on. `web_search="disabled"` is accepted, and an invalid value is refused, which shows the key is read.
