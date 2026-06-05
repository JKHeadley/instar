# Side-Effects Review — per-job MCP access scoping (`mcpAccess`)

**Version / slug:** `job-mcp-access`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `self-review under the Tier-1 lite lane; the capability-loss question (does any job need MCP?) is addressed explicitly below`

## Summary of the change

`JobDefinition.mcpAccess?: 'project' | 'none'`. When `'none'`, `spawnJobSession` passes the EXISTING `disableProjectMcp` option to `spawnSession` (shipped + verified by the mentor autonomous-fix loop, docs/specs/LOOP-SESSION-NO-MCP-SPEC.md), which emits `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` on claude-code spawns and nothing on other frameworks. The field flows frontmatter → InstallBuiltinJobs → per-slug manifest → validateManifest → manifestToJobDefinition. 14 shipped utility templates declare `mcpAccess: none`.

## Decision-point inventory

- `types.ts JobDefinition.mcpAccess` — add — optional, absent = legacy.
- `AgentMdJobLoader.ALLOWED_FRONTMATTER_KEYS` — modified — `mcpAccess` joins the closed-set whitelist (deliberate, per the set's own doc).
- `PerSlugManifest.mcpAccess` + `validateManifest` — add — closed two-value enum, loud throw otherwise.
- `buildPerSlugManifest` — modified — carries the field; omits the key when undefined.
- `InstallBuiltinJobs` — modified — derives from frontmatter; out-of-set values → undefined (fail-safe to legacy), then validateManifest re-checks the generated manifest.
- `JobScheduler.spawnJobSession` — modified — `disableProjectMcp: job.mcpAccess === 'none' ? true : undefined`.
- 14 templates — modified — `mcpAccess: none` added to frontmatter.

## 1. Direction-of-failure analysis (capability loss)

The risk: a job whose body NEEDS an MCP tool gets spawned without MCP and fails mid-run.

- **Grounding:** zero shipped templates reference `mcp__*`, `threadline_*`, playwright, browser, or chrome (grep across `src/scaffold/templates/jobs/instar/*.md`). The marked 14 are bash/curl-only by construction.
- **Deliberately unmarked:** the orchestration family (`mentor-onboarding`, all `overseer-*`, `evolution-proposal-implement`) keeps project MCP — they drive sessions/build code and are the apprenticeship machinery; this slice does not touch their spawn behavior.
- **Custom/user jobs:** never affected — the field is opt-in and absent on every existing user job.
- **Worst NEW case:** a future template author marks a job `none` then writes a body that wants MCP — the session still runs (built-in tools work; MCP tools are simply absent), the job degrades visibly in its own output rather than hanging. That is strictly better than the current failure direction (auth-required remote MCP can hang the headless boot silently).

## 2. Over-permit

None — the change only ever REMOVES servers from a spawn, never adds; and only for jobs that explicitly opt in.

## 3. Scope deliberately NOT taken

- No default flip: absent stays legacy full-MCP. A future slice may flip instar-origin jobs by default after this one soaks.
- Topic/chat sessions untouched (capability matters there; the standing-cost problem for those is the idle-reap path, fixed separately by the meaningful-tail work).
- No per-job CUSTOM MCP subset (`--mcp-config` with a real server list) — only the binary none/project. Subset selection is a follow-up if a real job needs it.

## 4. Migration parity

Built-in templates are re-installed by `installBuiltinJobs()` on every update via `refreshHooksAndSettings()`, and the per-slug manifests are REGENERATED from the templates — existing agents pick up the 14 `mcpAccess: none` declarations on their next update without a dedicated migration. Operator-disabled jobs keep their disabled state (existing `existingEnabled` preservation). No config/hook/skill/CLAUDE.md surface changes.

## 5. Token/cost impact

Strictly negative (saves): every marked job spawn skips MCP server boot (playwright-mcp alone ≈125MB + node startup per spawn; health-check spawns 288×/day). No new LLM calls.

## 6. Rollback

Revert the commit. Manifests regenerate without the field on the next install pass; spawns return to full-project-MCP.
