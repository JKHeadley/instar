---
slug: secret-drop-hardened-retrieve-template
title: Ship the hardened Secret Drop retrieve helper as a template; retire the unsafe curl pattern from all agent-facing surfaces
review-convergence: 2026-05-21T07:00:00Z
approved: true
eli16-overview: secret-drop-hardened-retrieve-template.eli16.md
---

# Secret Drop Hardened Retrieve Template

## Problem

The 2026-05-20 incident exposed a credential-leak failure class. When an agent received a Secret Drop submission, every documented retrieval path instructed `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:$PORT/secrets/retrieve/TOKEN`. That curl prints the full JSON response — which contains the secret in `values.<field>` — to the Bash tool's stdout. The stdout is captured in the Claude Code JSONL transcript, included in subsequent context windows, and sent to Anthropic's API as part of the conversation. The secret leaks the moment it is retrieved.

After the incident, a hardened helper (`secret-drop-retrieve.mjs`) was written on one agent's machine. It streams the requested field value to stdout, prints field NAMES + lengths to stderr, and structurally refuses to print the response body. The helper closes the leak class — but only for that one agent. Every other instar agent still runs the unsafe pattern because:

1. The helper is not in `src/templates/scripts/`, so `init` does not install it for new agents.
2. There is no `PostUpdateMigrator` entry installing it for existing agents.
3. The CLAUDE.md template at `src/scaffold/templates.ts:430` still documents the raw curl pattern as the canonical retrieval form.
4. The spawn message injected into agent sessions on Secret Drop submission (`src/server/routes.ts`, the `[secret-drop-received]` system message) instructs the agent to run the raw curl.
5. The stuck-consumer retry message in `secretDrop.onStuckConsumer` also instructs the raw curl.
6. The `secrets.retrievalHint` in the `/capabilities` response (shipped in PR #290) names the hardened helper but does not give the exact command form.

## Approach

Six interlocking changes, one PR:

1. **`src/templates/scripts/secret-drop-retrieve.mjs`** — ship the hardened helper as a canonical template. Reads `authToken` + `port` from `.instar/config.json` at runtime; no init-time port substitution needed (the script is Node, not bash). `INSTAR_PORT` env var overrides the config port for parity with `telegram-reply.sh`.

2. **`src/commands/init.ts`** — add `installSecretDropRetrieve(projectDir)` that mirrors `installSerendipityCapture`. Call from the three existing init paths next to the serendipity install.

3. **`src/core/PostUpdateMigrator.ts`** (`migrateScripts`) — always-overwrite `.instar/scripts/secret-drop-retrieve.mjs` on every update run. Same pattern as `convergence-check.sh`: generated infrastructure, not user-edited. The always-overwrite is intentional because the helper is security-relevant — a stale copy that printed the body would defeat the purpose.

4. **`src/server/routes.ts` spawn message** (`[secret-drop-received]`) — replace the `curl -s -X POST .../secrets/retrieve/TOKEN` instruction with `node .instar/scripts/secret-drop-retrieve.mjs TOKEN <field-name>`. Include `--names` for field discovery, explicit `--consume` for opt-in destructive read, and a one-line explicit warning that raw curl leaks.

5. **`src/server/routes.ts` stuck-consumer retry message** (`[secret-drop-stuck]`) — same hardened command form.

6. **CLAUDE.md template** (`src/scaffold/templates.ts`) and **`migrateClaudeMd`** — rewrite the Secret Drop documentation block to lead with the hardened helper. The migrator detects the legacy `curl /secrets/retrieve/TOKEN` line via a port-tolerant regex and replaces it. Idempotent: a CLAUDE.md that already documents `secret-drop-retrieve.mjs` is skipped.

The `/capabilities` `secrets.retrievalHint` is updated to give the exact command form so an agent reading `/capabilities` learns the safe pattern directly from the discovery surface.

## Non-goals

- Refactor `/capabilities` to introspect from `FeatureRegistry` + the live router. Tracked separately as follow-up #2.
- Add a server-side check that refuses raw retrieve requests from clients without a hardened-client header. The signal-vs-authority principle keeps the server permissive; the agent-side hardening is the right layer.

## Acceptance criteria

- `src/templates/scripts/secret-drop-retrieve.mjs` exists and is executable. It honors `--names`, `--consume`, and the default peek mode. It uses `process.stdout.write(v)` (not `console.log`) and structurally cannot print the response body.
- `init.ts` writes `.instar/scripts/secret-drop-retrieve.mjs` for new agents at all three install paths.
- `PostUpdateMigrator.migrateScripts` writes the file for existing agents on every update run; output is identical on repeat runs.
- `PostUpdateMigrator.migrateClaudeMd` rewrites the legacy retrieval line to the hardened guidance. Idempotent; port-tolerant.
- The `[secret-drop-received]` and `[secret-drop-stuck]` system messages in `routes.ts` instruct the hardened helper and explicitly warn against the raw curl pattern.
- The CLAUDE.md template (`generateClaudeMd`) documents the hardened helper as the required retrieval form.
- `/capabilities.secrets.retrievalHint` gives the exact `node .instar/scripts/secret-drop-retrieve.mjs TOKEN field-name` command.
- Tier 1 tests (`tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts`) cover script install + CLAUDE.md rewrite, 8 cases.

## Decision points touched

- `[secret-drop-received]` system message — **modify** — the structural prompt the agent reads to learn how to retrieve. Changed from unsafe to hardened pattern.
- `[secret-drop-stuck]` system message — **modify** — same change for the retry path.
- CLAUDE.md template + migrator — **modify** — the static guidance an agent reads on session start.
- `/capabilities.secrets.retrievalHint` — **modify** — make the recommendation actionable (full command form).

No new gate/block authority introduced. The server's `/secrets/retrieve` endpoint behavior is unchanged. The hardening lives at the agent-facing instruction layer, which is the right level: agents read guidance to learn safe patterns, and the only way to enforce a safe pattern is to make it the documented one across every surface the agent reads from.

## Migration

- Hooks: no change.
- Settings: no change.
- Config defaults: no change.
- CLAUDE.md sections: existing Secret Drop block is rewritten in place via port-tolerant regex.
- Hook scripts: no change.
- Built-in skills: no change.
- New script template: `.instar/scripts/secret-drop-retrieve.mjs` installed by `migrateScripts` (always-overwrite).

## Rollback

Pure code change. Revert the migrator + init + templates diff; the previously-shipped helper on existing agents stays (we don't delete during rollback). Agents that had the unsafe pattern restored in CLAUDE.md by an erroneous rollback would resume the leak — so any rollback should explicitly re-ship the hardened guidance before reverting the migrator.

## Origin

2026-05-20 incident (topic 9984): unsafe `curl /secrets/retrieve` leaked Bitwarden master password into the Claude Code JSONL transcript and downstream Anthropic API context.

2026-05-21 case-study audit (topic 11141): identified three compounding failures. Failure #1 (discoverability) was closed by PR #290 (capabilities-discoverability spec). This spec closes failure #2 (workaround reflex / unsafe retrieve pattern across every agent-facing surface).
