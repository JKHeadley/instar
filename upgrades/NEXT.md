# Upgrade Notes (Unreleased)

## What Changed

This release adds **additive loader-side support** for the new agentmd job format described in the approved INSTAR-JOBS-AS-AGENTMD spec. Job prompts can now live in markdown files at `.instar/jobs/<origin>/<slug>.md`, with a tiny per-slug manifest at `.instar/jobs/schedule/<slug>.json` carrying the cron/priority/model metadata.

This is Phase 1a of the rollout — loader-only. agentmd entries LOAD and VALIDATE but do not yet fire; Phase 1b adds scheduler dispatch and Phase 1c adds the signed lock-file pipeline. Existing `execute.type: "prompt" | "skill" | "script"` jobs continue to work unchanged. Agents with a legacy `jobs.json` see no behavioral difference.

### feat(scheduler): additive agentmd format support (Phase 1a of jobs-as-agentmd spec)

The job scheduler can now read per-slug manifests from `.instar/jobs/schedule/<slug>.json` and resolve `execute.type: "agentmd"` entries to a markdown body at `.instar/jobs/<origin>/<slug>.md`. Entries are validated through a hardened YAML parser (FAILSAFE_SCHEMA + parsed-tree anchor rejection + size caps + Zod preprocessor coercion) and through deterministic path-safety checks (no symlinks, ASCII-only slug regex, case-fold collision resolution with instar-wins precedence). Backwards-compatible: legacy jobs.json setups load identically to before; mixed-state agents have per-slug manifests win on slug collision.

- **Types added** on `JobDefinition`: `body`, `frontmatter`, `origin: "instar" | "user"`, `unrestrictedTools`. `execute.type` extended to include `"agentmd"`. New `AgentMdExecute` interface (body lives in the `.md` file, not the manifest).
- **Per-slug manifest reads** from `.instar/jobs/schedule/<slug>.json`, with hand-rolled bounded-concurrency runner (limit = 32) exposed for Phase 1b's async migration.
- **YAML hardening**: `js-yaml` ≥ 4 with `FAILSAFE_SCHEMA`; anchor/alias rejection via the parser's `listener` callback (the parsed-tree walk the spec mandates — legit markdown like `description: "Bash & Read"` is NOT over-rejected); 16 KB frontmatter cap; 64 KB body cap; closed-set frontmatter key whitelist.
- **Zod preprocessor coercion** per spec §6: `BoolField` accepts `true/True/TRUE/false/False/FALSE` and rejects `yes/no/on/off`; `IntField` accepts ASCII integers and rejects floats/`NaN`/`Infinity`/non-ASCII digits.
- **Path safety**: `lstat` rejects symlinks, `realpath` rejects intermediate-symlink redirection, slug regex rejects `..`, leading `/`, NUL, RTL override (U+202E), ZWJ/ZWNJ/ZWSP, dotless-i, and non-ASCII digits.
- **Case-fold collision handling**: across all loaded entries, `origin === "instar"` wins over `origin === "user"`; same-origin collisions skip both; problems are surfaced via the load-problems list.
- **What does NOT work yet (Phase 1b/1c follow-ups)**: scheduler dispatch of agentmd entries (currently filtered out at `JobScheduler.start` with a clear log line); `--allowedTools` plumbing through Claude Code; lock-file signature verification; lock-file generation in the build pipeline; custom git merge drivers; migration script; dashboard surfaces; PostUpdateMigrator changes.

### Evidence

New test files added:

- `tests/unit/scheduler/JobLoader.agentmd.test.ts` — 68 test cases covering happy path, YAML hardening, Zod preprocessors, path safety, case-fold collision, mixed-state precedence, backwards compatibility, hydration invariant, manifest validation edge cases, and the direct `loadAgentMdJobs` contract.
- `tests/unit/scheduler/agentmd-helpers.ts` — synthetic-agent layout builder for arbitrary `jobs.json` + `schedule/` + `instar/` + `user/` trees.

Test highlights (verified locally):

```
 ✓ tests/unit/scheduler/JobLoader.agentmd.test.ts (68 tests) 90ms
   Tests  68 passed (68)
```

Existing `tests/unit/JobLoader.test.ts` (the pre-spec test suite) continues to pass unchanged — backwards compatibility is structural, not just documented.

## What to Tell Your User

Instar is preparing to move job prompts out of one big `jobs.json` blob and into individual markdown files (one file per job). This update lays the groundwork: the loader now understands the new format, and the new validation rules are all in place. Nothing changes for you yet — your existing jobs keep running exactly as before, and you can ignore this change entirely if you want. The actual cut-over (where jobs start firing from their `.md` files) happens in the next few releases. If you ever see a warning in your logs about an `agentmd` job being "deferred — Phase 1b adds the dispatch path," that's expected for now.

## Summary of New Capabilities

- **agentmd job format (loader-side)** — `JobDefinition` now carries `body`, `frontmatter`, `origin`, and `unrestrictedTools`. `execute.type` accepts `"agentmd"`.
- **Per-slug manifest layout** — `.instar/jobs/schedule/<slug>.json` is read at load time; mixed-state agents have per-slug entries win on slug collision.
- **Hardened YAML parsing** — `js-yaml` FAILSAFE_SCHEMA + parsed-tree anchor rejection + size caps + closed-set key whitelist.
- **Zod preprocessor coercion (`BoolField`, `IntField`)** — exported from `src/scheduler/AgentMdJobLoader.ts` for downstream phases.
- **Path safety helpers** — symlink rejection, slug regex, case-fold collision resolution (instar-wins).
