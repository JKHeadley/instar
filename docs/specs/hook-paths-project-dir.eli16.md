# Built-in hooks now run from any folder: plain-English overview

## What happened

Instar installs small "hook" programs that Claude Code runs around every tool
call and every stop. They report activity to the server, add the Telegram
topic's context, check risky outside actions before they happen, keep a
`/build` session from quitting early, and approve helper permissions.

The settings file told Claude Code where each hook lives. For most hooks it
said "start from the project root" (`${CLAUDE_PROJECT_DIR}/.instar/...`). For
several older ones it only said `.instar/hooks/instar/...`, with no starting
point. Claude Code then looks for that path from whatever folder the session
is working in.

On 2026-09-29 the Instar 2.0 coordinating session on the Mac Studio was
working inside `.instar/lanes/pipeline`. From there, `.instar/hooks/...` does
not exist. Every one of those hooks failed with "file not found" on every
tool call and every stop, and nothing noticed: the activity reporter, topic
context, outside-action check, build stop hook and permission auto-approve
just never ran for that session.

## What changed

- New installs write every built-in hook with the project-root starting
  point, the same way the working hooks already were.
- Existing agents get their settings file fixed on the next update. Only
  Instar's own hooks are changed; hooks an agent or operator wrote
  themselves are left exactly as they are. Running the update again changes
  nothing.
- A few hook programs also read files by a folder-relative path (the build
  state file, some state folders, the Slack hook's config). They now start
  from the project root too, and fall back to the old behaviour if that
  setting is missing.
- The update check that warns "a hook in settings points to a missing file"
  now also checks hooks written in the project-root form.
- The project-root path is now written inside quotes. Without them, a home
  folder with a space in its name (`Agent Home`) got cut in two and every
  hook broke. Existing agents' settings get the quotes on the next update.
- Two hook programs pass that path to a small Python helper. They used to
  paste it into the Python code itself, so a folder named `Justin's Agent`
  broke the code. They now hand it over as plain data.

## What stays the same

Sessions started at the project root behave exactly as before. No gate
decides anything differently; the gates simply run where they were silently
missing.

## What you need to decide

Nothing. This is a path fix with a one-time settings update. Undoing it is a
plain revert; the fixed settings keep working on older versions too.
