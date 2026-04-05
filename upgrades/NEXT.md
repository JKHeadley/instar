# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

**Fix: `/build` skill now properly installs for all agents.** Three bugs prevented the build skill from working:

1. **Missing from npm package**: The bundled `.claude/skills/build/SKILL.md` was not in the `files` array of `package.json`, so the full 269-line skill definition never shipped. Agents got a minimal 8-line fallback instead.

2. **Broken path resolution**: `installBuildSkill()` and `installHooks()` used `__dirname` to locate bundled files, but `__dirname` is undefined in ESM modules (`"type": "module"`). The bundled copy always silently failed, falling back to the inline version.

3. **Filename casing mismatch**: The build skill was created as `skill.md` (lowercase) while all other built-in skills use `SKILL.md` (uppercase). Now consistent.

### What agents get after this update:

- **Full `/build` skill** (269 lines) with worktree isolation, 6-phase pipeline, quality gates, and stop-hook enforcement — installed via `migrateBuiltinSkills()` during auto-update
- **`build-state.py`** state manager in `playbook-scripts/` — already shipped (was in `files` array)
- **`build-stop-hook.sh`** stop hook in `.instar/hooks/instar/` — installed by `installHooks()` during init/update

### Path resolution fix:

Both `installBuildSkill()` and the build stop hook installer now use `import.meta.url` instead of `__dirname`, matching the pattern used elsewhere in init.ts (e.g., `installAutonomousSkill`).

## What to Tell Your User

- **`/build` now works**: "Your agent now has a fully functional `/build` skill. When you describe a multi-file feature or say 'build something', your agent will offer to use a structured pipeline — planning first, testing at every step, independent verification, and worktree isolation so nothing conflicts with your other work. It was supposed to be available earlier, but a packaging bug prevented it from installing properly. That's fixed now."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `/build` skill (full version) | Say `/build` or describe a substantial task — agent suggests it proactively |
| Build state tracking | `python3 playbook-scripts/build-state.py status` |
| Worktree isolation | Automatic during `/build` — all work in `.instar/worktrees/` |
| Build history | Completed builds archived in `.instar/state/build/history/` |
| Resume after crash | `python3 playbook-scripts/build-state.py resume` |
| Stop-hook enforcement | Automatic — prevents exit during active builds |
