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

- Every settings hook command instar generates (templates,
  `settings-template.json`, init, migrations, the `/build` and `/autonomous`
  stop-hook registrations) now writes the quoted form
  `node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/…"`, keeping any trailing
  arguments. The quotes keep an agent home whose path contains a space
  (`/Users/x/Agent Home`) working.
- `migrateSettings()` rewrites existing built-in commands, both the bare form
  and the unquoted `${CLAUDE_PROJECT_DIR}/…` form, to the quoted form, once.
  Custom hooks are never touched.
- `build-stop-hook.sh`, the scope-coherence and claim-intercept hooks, and
  `slack-channel-context.sh` read agent-home files from `CLAUDE_PROJECT_DIR`
  (falling back to the cwd when it is unset). The two shell hooks hand that
  path to Python as an argument, never inside the Python source, so a home
  named `Justin's Agent` parses. Deployed Slack hooks are upgraded once.
- The missing-hook-file check on update also covers anchored and quoted
  commands.
- Installed `/autonomous` and `/build` skills get their Stop-hook
  registration line swapped for the quoted one, once
  (`migrateSkillStopHookRegistrationQuoting`). Only the exact shipped line is
  replaced; the rest of the file, custom edits included, is kept. Without
  this, running an installed registration block after update rewrote the
  quoted settings command back to the unquoted form.

## Evidence

- `tests/unit/hook-command-project-dir-anchor.test.ts`: templates and
  init-generated settings have no `node .instar/` / `bash .instar/` built-in
  command; an old settings file is rewritten once and a second run leaves it
  byte-identical; a custom hook is untouched; the unquoted anchored form is
  quoted with arguments kept and no double prefix; every emitted command runs
  from a subdirectory of a home named `Agent Home` (the unquoted form fails
  there); the Slack hook reads port, token and agent id from a home named
  `Justin's Agent Home`.
- `tests/unit/PostUpdateMigrator-skillHookRegistrationQuoting.test.ts`: a
  pre-fix installed `/autonomous` or `/build` skill in a home named
  `Justin's Agent Home` is upgraded with custom content kept; its
  registration block then keeps the settings command quoted and the command
  runs (the pre-fix block writes an unquoted command that fails); a second
  run is a no-op; a custom skill is untouched.
- `tests/unit/build-stop-hook-session-scoping.test.ts`: the shipped build stop
  hook fired from `.instar/lanes/pipeline` finds the build state, also under a
  home named `Justin's Agent Home`; both fail on the previous hook.

## What to Tell Your User

My built-in safety and reporting hooks now work even when I'm working inside
a subfolder of my home, and when my home folder's name has a space or an
apostrophe in it. Before, they could quietly stop running there.

## Summary of New Capabilities

- Built-in hooks run correctly for sessions started in any subdirectory of
  the agent home.
