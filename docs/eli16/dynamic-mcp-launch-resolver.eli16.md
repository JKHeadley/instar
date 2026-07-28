# Dynamic MCP — the launch-set resolver (ELI16 overview)

## What this adds

This is one small, pure decision function for the dynamic-MCP feature: given
everything the caller already looked up, it answers "**which MCP helpers should
this session start with?**" The whole point is to get the *order of checks* right,
because getting it wrong could strand a session without its tools — so it lives in
its own function with its own tests rather than buried inside the launch code.

## The order (and why each step matters)

1. **Is the feature even on?** If not, return "use the full helper list, like
   today." This check comes FIRST, before anything else, so that turning the
   feature off is always a clean undo — even for a session that had been trimmed,
   it goes right back to the full list instead of staying stuck trimmed.

2. **Is this a Claude session?** The trim mechanism only works for Claude Code
   (other AI frameworks configure their helpers a different way), so for anything
   else we also just use the full list.

3. **Does the session have a saved helper list?** If a session already recorded
   "I'm running with these helpers," use that — that's how a restart remembers
   what it had loaded.

4. **Couldn't read the saved list?** Fall back to the *lean* starting set, NOT the
   full one. This is the safety subtlety: if we fell back to "load everything" on a
   read hiccup, a momentary glitch across many sessions could relaunch every heavy
   browser at once and re-create the very crash this feature exists to prevent. So
   the safe fallback is "lean," not "everything."

5. **Otherwise** use the configured lean starting set, or — if none is configured —
   the full list.

## Why it's safe

It's a pure function: it reads nothing, writes nothing, starts nothing. It just
returns a list. It's off by default (returns "full list" when the feature is off),
and every fallback path is chosen to keep the machine's footprint bounded while
never leaving a session toolless. Eight tests pin every branch, including the two
subtle ones (clean-undo-when-disabled, and fall-to-lean-not-full on a read error).
