# Side-Effects Review — `instar dev:profile-node`

**Version / slug:** `dev-profile-node-tool`
**Date:** `2026-06-03`
**Author:** `echo`
**Second-pass reviewer:** `not required (dev-only CLI; read-only sampling; no server/runtime surface)`

## Summary of the change

A new dev CLI command that CPU-profiles a running node process via SIGUSR1 + the
node inspector + a CDP CPU profile, and prints the hottest JS frames. New file
`src/commands/devProfileNode.ts` + a cli.ts registration + a manifest entry +
awareness lines. No server, route, config, or runtime-behavior change.

## Decision-point inventory

1. **pid resolution** — explicit `[pid]` digits win; otherwise auto-pick the
   hottest `node` process (`ps -Aceo pcpu,pid,comm`). No node found → exit 1.
2. **Inspector discovery** — probe ports 9229–9235 (node's default + increments
   when the default is taken); first target with a `webSocketDebuggerUrl` wins;
   none → exit 1 with a clear message.
3. **Profile aggregation** — `aggregateHotFrames` sums per-node `hitCount` by call
   frame, normalizes the path to `dist/…`/`src/…`, +1 to the 0-based line, and
   returns top-N by self-time. Idle/native frames are kept on purpose (seeing
   "48% idle, 30% readFileUtf8" is the signal).
4. **Exit codes** — 0 on a successful print (even "no samples"); 1 only on an
   operational failure (no node, signal failed, no inspector, capture threw).

## 1. The one real side effect — SIGUSR1 opens the inspector

SIGUSR1 tells node to start its inspector on `127.0.0.1` (localhost-only) for the
life of the process. Implications, all bounded:
- **Localhost-only** — the inspector binds 127.0.0.1, not a public interface; it is
  not remotely reachable.
- **Transient** — it closes when the process restarts; it does not persist.
- **Disclosed** — the command prints that it left the inspector open on the pid.
- **No state mutation** — profiling samples the process; it does not change its
  behavior, memory, or files.

This is the same standard procedure node documents for live debugging; it is the
*only* way to symbolicate JS frames on a running process. The benefit (pinning a
hot loop that no other tool can see) outweighs a transient localhost debug port on
a dev box. Operators who object can simply not run the command.

## 2. Over/under-block

Not applicable — it gates nothing and changes no behavior. A wrong pid or a
non-node target fails cleanly with exit 1; it never acts on the target beyond
SIGUSR1 + reading the profile.

## 3. Blast radius

Zero runtime surface. The command runs only when a contributor/agent invokes it.
No server code path imports it; it is a leaf CLI command behind a dynamic import
(like `dev:ci-failures`). The `ws` dependency is already present (`^8.19.0`).

## 4. Migration parity

CLAUDE.md template (`generateClaudeMd`) + `site/.../cli.md` + the builtin-manifest
(`cli:dev-profile-node`) are updated in lockstep so the awareness + discoverability
checks stay green. No config/hook/skill migration — it is a pure CLI addition
(same shape as `dev:ci-failures`, which needed none).

## 5. Testability

`aggregateHotFrames` and `findInspectorTarget` are pure/dep-injected; the
SIGUSR1 / inspector-http / ws-CDP boundary is behind `ProfileNodeDeps` so the
orchestration is unit-tested without a real process. A live end-to-end smoke
(profiling a spawned busy node) confirmed the real path.

## 6. What it does NOT do

- Does not kill, restart, or modify the target (only SIGUSR1 + sample).
- Does not run as part of the server or any job — invoked on demand only.
- Does not expose a remote/public debug port (inspector is localhost).
