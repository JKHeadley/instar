---
title: "Lessons-aware reviewer — ELI16"
slug: "lessons-aware-reviewer-eli16"
parent: "lessons-aware-reviewer.md"
---

# Lessons-aware reviewer — explained simply

## What it is

A new reviewer added to the `/spec-converge` process. There were already seven: four internal (security, scalability, adversarial, integration) plus three external (GPT, Gemini, Grok). This adds an eighth. Its only job: load the canonical Instar Design Principles + Lessons Learned catalog plus the agent's accumulated lesson memory, and check the spec for any documented lesson it contradicts or fails to engage with.

It's not a security reviewer. Not an architecture reviewer. It's a memory reviewer: "you wrote this spec; did you remember what we've already learned about this surface area?"

## Why it matters

Echo just shipped six PRs that backtracked on multiple documented lessons — the AGENT.md context-bloat trap, the Migration Parity standard, the Testing Integrity standard, the install-if-missing wedge for built-in hooks. None of the seven existing reviewers were tasked with checking against the lessons memory. The author (Echo) was running the convergence on Echo's own specs under a pre-authorization that said "self-verify against the foundational specs you just wrote" — a circular check.

The lessons-aware reviewer is the structural fix. It's the one reviewer whose context is "the catalog of everything we've already paid for in pain," independent of the spec author's framing. When the spec contradicts a lesson, the reviewer flags it. When the spec touches a surface a lesson covers but never engages with the lesson, the reviewer flags that too.

## What's new in this spec

Two artifacts: a reviewer prompt template (the new file the convergence skill spawns as the 8th parallel reviewer) and a skill update (declares the reviewer, says it MUST run on every round, updates the "seven" references to "eight"). v0.1 enforcement is prompt-level (the SKILL.md says it MUST run); v0.2 adds a deterministic script check that refuses to write the convergence tag without lessons-aware findings in the report.

The spec also documents the bootstrap exception: this spec is the reviewer itself, so it can't run through the reviewer. A manual lessons-aware check is applied in the spec body against the just-merged principles index — same bootstrap pattern `/spec-converge` used when first introduced.

## What this is NOT

Not a replacement for the other seven reviewers — they cover their own perspectives. Not an architecture reviewer. Not a code-style reviewer. It checks one specific axis: does this spec respect or contradict the documented lessons? Everything else stays in its own reviewer's lane.

## What changes for the user

For Justin: when Echo (or any Instar agent) drafts a spec going forward, the convergence cycle will catch lesson-backtracks before approval. The specific kind of failure that produced the recent backtrack chain (author + convergence-runner + self-verifier collapsed into one) is structurally prevented.

For other Instar agents using the convergence skill: same — their `.instar/memory/` lessons get loaded into the reviewer, so per-agent specific lessons also surface during convergence.
