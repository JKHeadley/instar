---
title: "A local model as the last resort when every AI door is down"
slug: "backup-local-model-last-resort"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "backup-local-model-last-resort.eli16.md"
related-specs: "recommended-services.md, install-experience.md"
status: "stub"
---

# A local model as the last resort

Owner: Echo. First in the backup work order (`recommended-services.md`, Frontloaded Decisions). Closes the `gap` on the `second-ai-door` catalog row.

## Problem statement

An agent with one AI subscription stops when that provider is down or out of quota. A second subscription helps, but it is another outside service, and the operator's requirement is that no agent relies on one.

## Acceptance

With every subscription unusable and no network, an agent still answers its owner, says plainly what it can't do in this state, and does the work a small model can do. A drill proves it by switching the doors off, and the catalog row moves off `gap`.

## Questions this spec must answer

- Which model and runtime, on which machines, including machines too small to run one. What such a machine does instead.
- How it joins the existing door and framework routing, and what stops ordinary work landing on it when a real door is up.
- What it may do. A weak model must not hold authority that gating checks reserve for a stronger one.
- How it is installed, by the agent, with no steps for the person, and how much disk and memory it takes.

## Status

Stub. Not reviewed or approved, and nothing is built.
