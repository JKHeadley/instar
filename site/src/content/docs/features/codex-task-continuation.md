---
title: Codex task continuation
description: Bounded continuation for explicit multi-step Codex work.
---

# Codex task continuation

`CodexTaskContinuationStore` lets an agent keep an ordinary Codex assignment moving across response boundaries while its explicit checklist still has unchecked items. It does not infer tasks from conversation text, and it does not treat a dirty worktree as permission to continue.

The feature is off by default. When enabled, the agent owns the lifecycle through the `instar continuation` commands. A continuation is bound to one local topic and session, and both a duration ceiling and a continuation-count ceiling limit it. Operator stop markers always outrank the ledger; malformed state, ownership mismatch, lock contention, or an audit failure all make Codex stop normally.

## Local API

The authenticated local server exposes the lifecycle used by the CLI and trusted Stop hook:

- `POST /continuation/start` creates a bounded ledger from an explicit task list.
- `GET /continuation/:topic/status` returns counts and bounds without task prose.
- `POST /continuation/:topic/complete` checks one eligible task by ordinal.
- `POST /continuation/:topic/stop` writes a topic stop marker and deactivates its ledger.
- `POST /continuation/stop-all` publishes a global stop marker before deactivation cleanup.
- `POST /continuation/decide` is the sole turn-boundary authority used by the Codex Stop hook.

Continuation state is machine-local because it belongs to the local Codex process. After a restart or machine transfer, the resumed agent must re-ground and explicitly start a new generation rather than adopting an old session's authority.
