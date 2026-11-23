# Side effects: explicit Codex tool-free profile (SEC-175)

In plain words: a Codex call that reads outside text now also turns off web search, image viewing, image generation, sub-agents and plugins. Nothing else changes.

Tier 1 by size, security-sensitive: an independent second-pass review is recorded below. Size: one new module `src/core/codexToolFreeProfile.ts`, a one-line change plus an import in `src/core/CodexCliIntelligenceProvider.ts`, one new unit test file.

## What changes for running agents
- **Who is affected.** Only calls with `noLocalTools: true`. Today that is the ecosystem idea review's Codex caller (`src/ecosystem/buildEcosystemIdeas.ts`). Every other Codex call produces the same argv as before (pinned by a test).
- **The argv.** The five `--disable` names are unchanged and in the same order. Added: `-c web_search="disabled"`, `-c features.view_image=false`, `-c features.image_generation=false`, `-c features.multi_agent=false`, `-c features.multi_agent_v2=false`, `-c features.plugins=false`, `-c features.standalone_web_search=false`, `-c tools.web_search=false` (older spelling), and `-c features.goals/skill_search/tool_suggest/remote_plugin=false` at the reviewer's suggestion. `-c mcp_servers={}` stays.
- **Older Codex versions.** Codex refuses an unknown `--disable` name but ignores an unknown `-c` key or feature (checked on codex-cli 0.171.0). So the new switches are all `-c`, and a test freezes the `--disable` list.
- **Review quality.** The idea review judges the text it is given. It never needed search, images or helpers, so its answers should not change.

## Signal vs authority
Not applicable as a new judgment: this hardens a deterministic launch profile, an invariant by design ("a call holding outside text gets no tools").

## Second-pass review
**Reviewer:** independent Claude Sonnet subagent (fresh context, read-only, given the finding and the diff), 2026-11-22. Verdict: CONCUR, no blocking items. It confirmed:
- both spawn sites (exec-json and plain) get the full profile, and the ecosystem idea review is the only `noLocalTools` caller;
- with the profile's flags, `codex features list` on 0.171.0 shows image viewing, image generation, sub-agents, plugins, apps, browser and shell off;
- existing tests and ordinary-call argv are unchanged, and the new test fails on the old code.

Its suggestions, all applied: reword the ELI16 sentence about what the coverage test reads; add the older `tools.web_search=false` spelling; turn off goals, skill search, tool suggestions and remote plugins too.

Known limits, not fixed here:
- `unified_exec` still lists as on even with `--disable unified_exec` on 0.171.0, while `shell_tool` flips off. This predates the change and probably does not matter, because `shell_tool=false` closes the command tool. It cannot be confirmed without a model call.
- A user's own Codex profile in `~/.codex/config.toml` that sets web search may outrank a top-level `-c` value. The scratch-dir launch selects no profile, and this machine's config has none.

## Rollback
Revert the commit. No stored state changes.

## Tests
- `tests/unit/sec175-codex-tool-free-profile.test.ts` (new).
- Existing Codex provider tests pass unchanged: `codex-cli-provider-execjson`, `CodexCliIntelligenceProvider`.

## Class-Closure Declaration
- `unbounded-self-action`: closure n/a. No loop or spawn added.
