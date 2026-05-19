---
title: "Skill — ELI16"
slug: "skill-eli16"
parent: "skill.md"
---

# Skill — explained simply

## What it is

A **Skill** is a little bundle of "how to do X" that an agent can use when it makes sense. It's a file with a short name, a description of when to use it, and the actual instructions. It can also carry helper scripts, reference docs, and asset files (icons, templates, anything the skill needs).

Imagine you're showing a new coworker around. You hand them a single-page guide: "When a customer asks about refunds, here's how to handle it." That guide is a skill. The agent reads it, follows it, gets the job done.

## Why it matters for Instar

Two reasons.

**One:** Skills are the main way agents extend their behavior without changing their core code. Want the agent to handle a new kind of request? Add a skill. The agent will read its description, recognize when the user's request matches, and follow the skill's instructions.

**Two:** Skills are the first thing we're proving works the same way across different agent frameworks. Claude Code and Codex CLI both support skills, but they look for them in different folders and expect slightly different file formats. Instar's job is to make this difference invisible. You write a skill once in Instar's canonical format; Instar renders it correctly for whichever framework is running. From the agent's perspective and the user's perspective, skills "just work."

## What already exists

Two pieces are already in place:

- Claude Code reads skills from `.claude/skills/`. Has been working for a while.
- Codex CLI reads skills from `.agents/skills/`. Fixed in PR #249 — Instar was writing them to the wrong place before.

## What's new in this spec

This spec formally writes down what a "Skill" is in Instar terms, separate from any one framework. Three new things land alongside it:

1. **The Instar-canonical Skill format** — one master shape that lives at `.instar/skills/<name>/`. Both framework folders become renderings of this master.
2. **Per-framework rendering specs** — small docs at `specs/frameworks/<framework>/skills.md` that describe exactly how each framework's version looks (path, file format, sibling files, quirks). These are descriptive — they capture what we've learned about each framework.
3. **A parity rule in code** — a small piece of TypeScript that, for any skill, checks that every enabled framework's rendering is in sync with the canonical master. If they drift apart (manual edit, framework version change, etc.), the rule notices.

## What this is NOT

This spec doesn't build:

- A new way for users to chat-create skills (that's the Conversational-action primitive, separate spec).
- A live-deployed parity sentinel that scans the whole codebase on a schedule (that's the FrameworkParitySentinel, separate spec).
- A migration tool that backfills `.instar/skills/` from existing `.claude/skills/` content (the sentinel handles that on its initial-scan path).

## What changes for the user

Nothing visible yet. This is plumbing. The user will feel the impact later when:

- They install a skill once and it works on whichever framework they're routed to.
- They ask the agent conversationally "can you handle X for me?" and the agent either uses an existing skill or suggests creating one.
- They never have to learn that "Claude expects skills here, Codex expects them there."

## The pattern

Every future required primitive (Hook, Agent, Tool, Memory) will get the same treatment: one Instar-canonical spec describing what the primitive *is*, per-framework specs describing how it renders, and a parity rule in code. Skill is the prototype — getting it right means every subsequent primitive has a clear template to follow.

## What to expect downstream

After this lands: when we ship the Hook primitive next, the work is mechanical — write the spec, write the renderings, write the parity rule, register it. By the time we have 3-4 primitives in the registry, the FrameworkParitySentinel becomes the obvious next build: a single watcher that consumes the registry and keeps every (primitive × framework) cell in sync.
