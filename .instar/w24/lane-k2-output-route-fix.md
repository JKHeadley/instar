# Lane K2 — bounded session-output identifier resolution fix

Measured on 2026-08-23. Verdict vocabulary is literal: `true`, `false`, and
`unmeasured` are distinct.

## Verdict

| Question | Verdict | Measurement |
|---|---:|---|
| Lane K's measured premise is correct | **true** | Source inspection at 2026-08-23T07:15:44Z confirmed `GET /sessions` reads state records while the output route passed its parameter directly to `captureOutput`; Lane K's 2026-08-23T07:13:24Z tmux-name control returned 200 while logical name returned 404. |
| Branch fix is effective | **true** | Focused unit/integration run at 2026-08-23T07:19:17Z passed 60/60 assertions across five files; the E2E branch-test lifecycle at 2026-08-23T07:18:37Z passed against a real `AgentServer`, `StateManager`, `SessionManager`, and live tmux pane. |
| Fix is deployed | **false** | `git status` and branch inspection at 2026-08-23T07:19:47Z showed work confined to `echo/w24-lane-k` at base `8e5b0d2c1`; no live-server restart, deployment, push, or merge was performed. |
| Deployed effectiveness | **unmeasured** | The live process was intentionally untouched. A post-deployment authenticated request by logical name and UUID is the control that could establish deployed effectiveness; it was not authorized or run. |

This is a long-standing identifier-contract mismatch, **not a regression**.

## Change

At the one route seam, `GET /sessions/:name/output` now searches active state
(`starting` or `running`) for an exact match on `id`, logical `name`, or
`tmuxSession`, then calls `captureOutput` with the record's `tmuxSession`.
Unknown identifiers never call the capture primitive and retain the existing 404
response.

The compatibility inventory at 2026-08-23T07:15:44Z found no other HTTP caller
of this route in the tree. Internal `captureOutput` callers use tmux names
directly. Matching `tmuxSession` remains supported, so the known compatible call
shape is preserved. The control that could have disproved compatibility was an
active record addressed by its tmux name; the integration suite exercises that
form and returned 200 at 2026-08-23T07:17:53Z.

## Evidence

- **Unit:** `tests/unit/session-output-resolution.test.ts` resolves UUID,
  logical name, and tmux name, and returns `null` for a genuinely unknown value.
  Focused run passed 4/4 at 2026-08-23T07:17:53Z.
- **Integration:** `tests/integration/session-output-route-resolution.test.ts`
  mounts the real Express handler. All three forms returned 200 and the unknown
  control returned 404 without invoking capture. Focused run passed 4/4 at
  2026-08-23T07:17:53Z.
- **E2E branch-test lifecycle:**
  `tests/e2e/session-output-route-branch-lifecycle.test.ts` assembled the real
  server/state/session-manager path, spawned a live tmux session, and read its
  output by logical name and UUID; the unknown control returned 404. The first
  run at 2026-08-23T07:18:23Z exposed a pane-paint startup race; after adding a
  bounded readiness poll, the run passed 1/1 at 2026-08-23T07:18:37Z.
- **Affected existing route tests:** 60/60 assertions passed across the new unit
  and integration files plus `server.test.ts`, `route-validation-edge.test.ts`,
  and `server-host-binding.test.ts` at 2026-08-23T07:19:17Z. These older tests now
  register the active state record required by the route contract.
- **Type safety:** bounded `tsc --noEmit` exited 0 at 2026-08-23T07:19:47Z.
- **Patch hygiene:** `git diff --check` exited 0 at 2026-08-23T07:19:47Z.

Every test command was process-timeout bounded (120 or 180 seconds). The full
suite was not run, per lane instruction. The test-runner admission hook reported
its existing dry-run/fail-open `rendezvous-unwritable` warning; it did not affect
the focused test results.
