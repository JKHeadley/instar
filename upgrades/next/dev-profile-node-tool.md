# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Adds `instar dev:profile-node [pid]` — a contributor/agent dev command that
CPU-profiles a **running** node process and prints its hottest JS functions
(function + `file:line` + self-time %).

**Why this exists (the technique that cracked a real bug).** macOS `sample` — and
lsof snapshots, empty `gh run --log`, port-grep — cannot symbolicate a node
process's **JS** frames; they show only native/V8 frames, so a busy agent server's
actual hot *function* stays invisible. The way to see it is the node process's own
introspection: `SIGUSR1` opens node's inspector on the running process, then a CDP
CPU profile over the inspector websocket reports the exact JS call frames. This is
literally how the systemic agent-server hot-loop was pinned — `StateManager.listSessions`
burning ~30% of CPU in `readFileUtf8`, invisible to every other tool. This command
turns that hard-won procedure into one reusable command.

**What it does:** resolves the pid (or auto-finds the hottest `node` process) →
`SIGUSR1` → probes `127.0.0.1:9229-9235` for the inspector target → captures a CPU
profile (default 5s, `--duration`) → prints the top frames by self-time (`--top`).
The biggest non-idle frame is the hot path. Read-only aside from the SIGUSR1, which
opens the inspector on localhost for the process's lifetime (it closes on the next
restart) — the command says so in its output.

Pairs with `dev:ci-failures` and `dev:preflight` as the contributor dev-loop
toolkit (friction → tooling).

## What to Tell Your User

Nothing required — it is a developer/agent tool for working on Instar. When an
agent server is mysteriously burning CPU, the instar dev:profile-node command
prints the exact JS function responsible, which native profilers cannot show.

## Summary of New Capabilities

- `instar dev:profile-node [pid] [--duration <sec>] [--top <n>]` — CPU-profile a
  running node process (SIGUSR1 + inspector + CDP) and print its hottest JS frames.
  No pid → profiles the hottest node process.

## Evidence

- Built directly from the technique that pinned the real hot-loop: after `sample`,
  lsof, grep, and log-diffing all failed, SIGUSR1 + a CDP CPU profile showed 30.8%
  `readFileUtf8` + 7% `listSessions` (StateManager) — the JS frame nothing else
  could see — leading to the cache fix.
- Live end-to-end smoke: profiling a spawned CPU-busy node correctly reported the
  hot frame (`listOnTimeout`, where the busy loop ran).
- Tests: `tests/unit/devProfileNode.test.ts` — pure `aggregateHotFrames` (ranking,
  file:line normalization, anonymous-frame fallback, empty profile, topN) +
  `findInspectorTarget` (first-hit / none) + `runDevProfileNode` orchestration with
  injected deps (happy path, no-pid→hottest, no-node→exit1, signal-fail→exit1,
  no-inspector→exit1, capture-throw→exit1).
