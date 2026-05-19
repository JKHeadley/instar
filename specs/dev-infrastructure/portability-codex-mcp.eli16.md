---
title: "Codex MCP registration — ELI16"
slug: "portability-codex-mcp-eli16"
parent: "portability-codex-mcp.md"
---

# Codex MCP registration — explained simply

## The problem

When an agent joins the agent-to-agent network (Threadline), it advertises a
small set of tools so other agents can reach it. The setup code only told
Claude Code about those tools. A Codex agent could join the network and have
the connection running, but Codex itself never knew the tools existed — so
from Codex you couldn't actually use them.

## How we found Codex's format

Not guessed. Codex lists its tool servers as `[mcp_servers."name"]` blocks in
`~/.codex/config.toml`. Confirmed two ways: our own code already documented
this, and we checked the real `~/.codex/config.toml` on the machine.

## The fix

After registering with Claude Code (unchanged), the setup now also adds the
`[mcp_servers."threadline"]` block to Codex's config file — but only if Codex
is actually installed on the machine, so a Claude-only computer never gets a
Codex config it doesn't use. It reuses the Codex config writer we already had
and tested, so there's no second copy of that logic to drift.

## Why it's safe

It only runs when Codex is present, it's wrapped so a failure can't break the
Claude setup or the network connection, it replaces rather than duplicates its
own block on repeat runs, and it leaves any other settings in your Codex
config untouched. Four tests check the format, the no-duplicate behavior,
preserving unrelated config, and the "is it registered" check. This is the
last of the six code-level portability gaps; only one architecture question
remains for operator review.
