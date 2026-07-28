# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Reap Log entries now include a consistent disposition field for skipped rows as well as reaped rows. This fixes a dogfood issue where skipped rows explained the authority refusal in a separate field but did not populate the common outcome field, making "where did my session go?" tooling harder to consume.

## What to Tell Your User

The session reap log is easier to read now: every row has a clear outcome, including attempts that were safely skipped.

## Summary of New Capabilities

| Area | Capability |
| --- | --- |
| Reap Log | Skipped rows now include a normalized outcome like skipped:protected or skipped:not-lease-holder. |
| Observability | Older skipped log lines are normalized when read, so existing logs become easier to interpret immediately. |
| Compatibility | The existing skipped detail field remains available for clients that already use it. |

## Evidence

- Unit coverage: `tests/unit/reap-log.test.ts` verifies new skipped entries and legacy skipped rows include a normalized disposition.
- Integration coverage: `tests/integration/reap-log-route.test.ts` verifies the route surfaces skipped dispositions.
- E2E coverage: `tests/e2e/reap-log-lifecycle.test.ts` verifies the live server path returns the normalized skipped disposition.
