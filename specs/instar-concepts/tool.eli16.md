---
title: "Tool — ELI16"
slug: "tool-eli16"
parent: "tool.md"
---

# Tool — explained simply

## What it is

A **Tool** is something the model can do during a turn — read a file, run a shell command, fetch a URL. Tools come from the agent framework (Claude Code provides Read/Edit/Bash; Codex CLI provides its own set). Instar doesn't implement tools — they come for free with whichever framework is running.

What Instar IS responsible for: making sure when a skill says "this skill can use the Read and Bash tools," the names "Read" and "Bash" mean the same thing on both Claude and Codex. Claude calls it "Read"; Codex might call it "view" — Instar has the mapping table.

## Why it matters

When skills, agents, or other primitives say "only allow these tools," that restriction needs to land correctly on whichever framework is running. Without the mapping table, you'd either have to write framework-specific tool lists (ugly) or hope the names happen to match (they don't).

## What's new in this spec

A canonical tool-name vocabulary (kebab-case like `read`, `bash`, `web-fetch`) and a mapping table to each framework's native naming. The mapping ships as code (`toolNameMapping.ts`) so other primitives can consume it when they render their `allowed-tools` fields.

## What this is NOT

This spec doesn't define what `read` actually does (that's the framework's tool implementation). It doesn't manage MCP server lifecycle (separate primitive). It doesn't gate tool calls (framework runtime concern).

## What changes for the user

Nothing visible yet. This unblocks the deferred `allowed-tools` rendering in Skill v0.2 — skills will be able to declare tool restrictions canonically and have them render correctly on whichever framework the agent is routed to.
