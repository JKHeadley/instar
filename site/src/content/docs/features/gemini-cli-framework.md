---
title: Gemini CLI Framework
description: Run an Instar agent on Google's Gemini CLI — the third supported agent framework, added via the apprenticeship program's runtime-adapter keystone.
---

Instar's agent layer is framework-agnostic: the same persistent-autonomy "mind" (jobs, messaging,
monitoring, the whole capability surface) runs on top of different coding-agent CLIs — Claude Code,
Codex CLI, and now **Gemini CLI**. Each framework needs a *runtime adapter* — the plumbing that
spawns the CLI, parses its output, resumes its sessions, and maps its hooks — and building that
adapter is the real work of onboarding a framework. Gemini support was added as the keystone of the
apprenticeship program (Step 2).

## Selecting Gemini

Choose `gemini-cli` as the framework when you set up an agent, or bind a single topic to it. The
Gemini CLI must be installed and signed in first. Gemini is then a first-class framework everywhere
the others are — session launch, resume, monitoring, and the framework-blind safety surfaces all
understand it.

## The production path — GeminiCliIntelligenceProvider

When Instar needs Gemini to make a one-shot judgment (a cross-model review, a gate decision), it
builds a `GeminiCliIntelligenceProvider`. This provider spawns a single, pinned, canonical command
— `gemini -m <model> --approval-mode default` with the prompt as exactly one argument — closes
stdin, caps the captured output, and runs under the same circuit-breaker the other providers use.

The provider is a deliberately locked-down *evaluation* path: it pins the safe approval mode and is
never reachable from a tool-taking mode. That is distinct from the **agentic session** path, where a
Gemini agent doing real autonomous work launches with auto-approve (Gemini's `--yolo`) exactly like
a Claude agent uses skip-permissions or a codex agent uses bypass — so the agent can actually act,
while one-shot evaluations stay safe.

## Credential safety

`GeminiCliIntelligenceProvider` builds the child environment from an explicit allowlist and
unconditionally removes the known Google/Gemini billing environment variables, so Gemini stays on
its cached-OAuth credentials and can never be silently billed through an injected API key — the
same Rule-1 posture the codex adapter enforces.

## Framework-blind safety

Adding a framework can silently break monitoring that was written for the existing ones. Gemini's
session/transcript layout is now understood by the resume map, the rate-limit and compaction
recovery checks, and the process/activity detectors — and a drift canary fails the build if any
future framework is added without a correct resolver, so this class of silent fleet-wide breakage
is caught in CI rather than in production.
