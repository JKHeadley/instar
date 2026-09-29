# Built-in hooks now run from any session folder

## What Changed

Claude Code runs a hook command from the session's working directory. Several
built-in hook commands in `.claude/settings.json` were bare relative paths
(`node .instar/hooks/instar/hook-event-reporter.js`,
`bash .instar/hooks/instar/session-start.sh`, the topic context, the
external-operation gate, the build stop hook, permission auto-approve). A
session started in a subdirectory of the agent home (seen 2026-09-29 on the
Instar 2.0 coordinating session, cwd `.instar/lanes/pipeline`) got
`MODULE_NOT_FOUND` / `No such file or directory` on every tool call and stop,
and those hooks silently never ran.

- The hook-event reporter templates, `settings-template.json` and the
  `/build` stop-hook registration now write
  `${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/…`, like every other built-in
  entry.
- `migrateSettings()` rewrites existing bare built-in commands to that form,
  once. Custom hooks are never touched.
- `build-stop-hook.sh`, the scope-coherence and claim-intercept hooks, and
  `slack-channel-context.sh` read agent-home files from `CLAUDE_PROJECT_DIR`
  (falling back to the cwd when it is unset). Deployed Slack hooks are
  upgraded once.
- The missing-hook-file check on update also covers anchored commands.

## Evidence

- `tests/unit/hook-command-project-dir-anchor.test.ts`: templates and
  init-generated settings have no `node .instar/` / `bash .instar/` built-in
  command; an old settings file is rewritten once and a second run leaves it
  byte-identical; a custom hook is untouched.
- `tests/unit/build-stop-hook-session-scoping.test.ts`: the shipped build stop
  hook fired from `.instar/lanes/pipeline` finds the build state; this test
  fails on the previous hook.

## What to Tell Your User

My built-in safety and reporting hooks now work even when I'm working inside
a subfolder of my home. Before, they could quietly stop running there.

## Summary of New Capabilities

- Built-in hooks run correctly for sessions started in any subdirectory of
  the agent home.
