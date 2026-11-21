# The stop-gate's one-time reminder note moves into the agent's own folder

<!-- bump: patch -->

## What Changed

SEC-131. The stop-gate router blocks a stop once when the session has a green pull request, and remembers that with a marker file. The marker used to be written in the shared temp folder with a plain write, which follows symlinks. It now lives in `.instar/state/stop-gate-markers/` (folder mode 0700) and is created exclusively with mode 0600: an existing file or link counts as already fired and is never written through. If the marker cannot be created, the reminder is skipped instead of repeating. The hook is rewritten on every update, so existing agents get this automatically.

## What to Tell Your User

- **Safer reminder notes**: "A small note my stop check leaves for itself now stays in my own folder instead of the shared temporary folder."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Stop-gate green-PR marker kept under the agent state folder, created exclusively | Automatic |

## Evidence

- `tests/unit/stop-gate-greenpr-marker.test.ts` (new): runs the real rendered hook against a local server that reports a green PR. It blocks once, the marker sits under `.instar/state/stop-gate-markers` with mode 0600 and nothing appears in the temp folder, and the second stop goes through (fails on main). A link pre-planted at the marker name is not written through and counts as fired.
