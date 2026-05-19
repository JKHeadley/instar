---
title: "Agent — ELI16"
slug: "agent-eli16"
parent: "agent.md"
---

# Agent — explained simply

## What it is

An **Agent** (in Instar's primitive terms — not your top-level Echo or Dawn) is a small sub-agent the main agent can spawn for delegated work. Think of it like temporarily hiring a specialist for a specific task. The sub-agent has its own identity file, its own session, its own conversation history. When it's done, it goes away or gets killed; the main agent gets a summary back.

This is different from skills (instructions the main agent reads) and hooks (scripts that run automatically). An Agent is a whole separate process with its own context window.

## Why it matters for Instar

Sub-agents are how complex work gets parallelized or isolated. "Spawn a code-reviewer agent on this PR." "Spawn a research agent to figure out this API." Without a primitive contract for sub-agents, the way you spawn one looks different on Claude vs Codex, and Instar can't promise consistent behavior.

## What's new in this spec

The Agent primitive is formally defined as a Layer-3 required primitive with a canonical source-of-truth at `.instar/agents/<name>/`. The concept spec ships in this PR along with per-framework descriptive specs.

## The honest gap

Claude has a clear subagent model (Task tool, file-based discovery at `.claude/agents/<name>.md`). Codex's subagent model needs a research pass before the parity rule can render symmetrically. Rather than ship a half-thought-through Codex side, this v0.1 ships the canonical shape + Claude-side coverage; the Codex side lands when the research is done.

This is tracked openly in the spec — not hidden as "future work."

## What changes for the user

Nothing visible yet. Plumbing.
