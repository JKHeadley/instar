# Upgrade Guide — fix gemini/codex-only scaffold leak

<!-- patch = bug fix, no breaking changes -->

## What Changed

`refreshHooksAndSettings()` (and the sibling resolver in init) read the persisted
`enabledFrameworks` from config.json through a hardcoded filter
`f === 'claude-code' || f === 'codex-cli'` that silently DROPPED `gemini-cli`. For a
gemini-only agent (`enabledFrameworks: ['gemini-cli']`) the filtered list came back
empty, so the code fell through to its `['claude-code']` default, `claudeEnabled`
became true, and `installClaudeSettings()` wrote a full Claude `.claude/settings.json`
into an agent that does not run Claude Code. Both filter sites now validate through a
single canonical `isKnownFramework` guard (backed by a `KNOWN_FRAMEWORKS` list kept in
sync with `IntelligenceFramework`), so no installed framework is dropped and a new one
cannot silently regress this again. New gemini-only and codex-only installs no longer
get a stray Claude settings file; claude-code installs are unchanged.

## What to Tell Your User

- **Cleaner non-Claude installs**: "If you set me up as a Gemini-only or Codex-only
  agent, I was accidentally dropping a Claude configuration file into your project even
  though I don't use Claude there. That's fixed — a Gemini agent now stays a Gemini
  agent, with no stray Claude settings."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Framework-correct scaffolding | Automatic (gemini/codex-only installs skip Claude settings) |

## Evidence

- **Live before:** the gemini agent installed during dogfooding
  (`~/.instar/agents/gemini`, `enabledFrameworks: ['gemini-cli']`) contained a
  7559-byte `.claude/settings.json` plus `.claude/skills`/`.claude/scripts` — Claude
  hook config it can never use. Confirmed by direct inspection of the agent home.
- **After (code path):** a behavioral test drives `refreshHooksAndSettings()` against a
  temp project with `enabledFrameworks: ['gemini-cli']` and asserts no
  `.claude/settings.json` is written; `['codex-cli']` likewise; `['claude-code']` and
  `['claude-code','gemini-cli']` still write it (no regression). A fresh gemini-only
  install therefore no longer leaks the file.
- **Residue note:** agents installed BEFORE this fix keep their already-written stray
  `.claude/settings.json` (the fix stops re-writing it but does not delete the residue);
  cleaning that inert leftover is a separate follow-up.
