# Template Agent ID Header

<!-- bump: patch -->

## What Changed

Built-in job, hook, and helper-script templates now include the agent identity header on authenticated local API calls. The scheduler and session launcher expose `INSTAR_AGENT_ID` alongside the existing local auth token so installed templates do not need to guess their identity.

## What to Tell Your User

Nothing user-visible. This quiets internal auth deprecation warnings from built-in jobs and hooks and keeps installed templates aligned with the stricter local auth contract.

## Summary of New Capabilities

- Job gates, script jobs, and spawned sessions receive `INSTAR_AGENT_ID`.
- Built-in local API templates send `X-Instar-AgentId` with bearer auth.
- A regression test scans shipped templates for bearer-only local API calls.

## Evidence

Grounded against canonical `authMiddleware`: bearer-only local API calls are still accepted during the deprecation window but log a warning; `/whoami` already requires the header. Focused validation: `npx vitest run tests/unit/template-agent-id-header.test.ts tests/unit/JobScheduler.test.ts tests/unit/JobScheduler-script-job.test.ts tests/unit/telegram-topic-context-session-clock.test.ts` passed, 41/41 tests.
