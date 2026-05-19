---
title: "FrameworkParitySentinel — ELI16"
slug: "framework-parity-sentinel-eli16"
parent: "framework-parity-sentinel.md"
---

# FrameworkParitySentinel — explained simply

## What it is

The **FrameworkParitySentinel** is the engine that actually runs the cross-framework drift checks Instar has been building. Three primitive PRs (Skill, Hook, Memory) shipped the *rules* — the per-primitive code that knows how to check whether a canonical artifact matches its rendered form on Claude / Codex. But until now, nothing was actually walking the rules registry and running the checks. The sentinel is that walker.

Concretely: on a 30-minute interval (and on demand), the sentinel iterates every parity rule in the registry, lists every instance of that primitive on disk, runs `verify()` on each, and:

- If `verify()` returns OK, moves on.
- If `verify()` returns drift, emits a `parity:gap-found` event and (if the rule says it's safe) calls `remediate()` to re-render canonical into the framework's expected shape.
- If `verify()` returns a user-edit conflict (the operator edited the rendered file directly), refuses to remediate and emits `parity:remediation-refused` so the operator can resolve.

It also exposes HTTP routes (`GET /api/framework-parity/status`, `POST /api/framework-parity/scan`) so the agent can answer "are we set up for Codex?" conversationally.

## Why it matters

Without the sentinel, every parity rule shipped to-date is dead code — a verifier that nobody runs. The sentinel turns "we have the rules" into "drift gets caught and fixed within 30 minutes of happening." This is what makes Instar's cross-framework promise (your agent runs equivalently on Claude or Codex) operationally real instead of theoretical.

## What's new in this spec

The architecture: the sentinel is a thin consumer of the existing rules registry, not a re-implementation of parity logic. It owns scan timing, state persistence, event emission, and HTTP routing. It doesn't own canonical definitions or rendering logic — those stay with the per-primitive rules.

The safety model: the sentinel reads each rule's `remediationPolicy`. Memory's is `flag-only`, so the sentinel never auto-fixes Memory (intentional — Memory is sacrosanct). Skill and Hook are `mirror-trust`, so the sentinel calls `remediate()` for those when the operator's trust level allows.

## What this is NOT

This spec doesn't redefine parity rules — those already exist as code. It doesn't change canonical formats. It doesn't add new primitives. It's just the loop that runs the existing checks on a cadence.

## What changes for the user

Once shipped: drift gets caught. If you edit a `.claude/skills/foo/SKILL.md` directly (instead of the canonical `.instar/skills/foo/`), within 30 minutes the sentinel notices and emits a structured alert pointing at the conflict. If you enable Codex on an existing Claude install, the sentinel runs a full scan and (per policy) re-renders the missing Codex-side artifacts. If your `.instar/AGENT.md` gets corrupted, you get a loud alert pointing at the documented repair procedure — not silent regeneration.

Conversationally: you can ask the agent "are we set up for Codex?" and it'll hit the `/status` endpoint to give you a real answer instead of guessing.
