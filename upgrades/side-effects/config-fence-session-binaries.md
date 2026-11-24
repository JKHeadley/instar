# Side effects: more session settings are file-only (SEC-145)

In plain words: five more session settings can no longer be changed through the settings API, only in the settings file.

Tier 1. Size: 2 source files (`src/server/routes.ts`: the `OPERATOR_ONLY_SESSION_KEYS` list and its refusal text; `src/config/bearerConfigWrite.ts`: refusal text), 1 test file extended.

## What changes
- `PATCH /config` with any of `sessions.tmuxPath`, `sessions.anthropicBaseUrl`, `sessions.anthropicApiKey`, `sessions.credentials`, `sessions.retainedClaudeBinary` (at its own path or inside a `sessions` object) answers 400 with the existing "not patchable via the API" message. The commitment tracker's bearer write guard (`bearerConfigWriteRefusal`) reads the same list.
- Checked for legitimate API writers before closing: none in `src`, `dashboard`, `scripts` or `skills`. These keys are set by hand in the config file, by `Config.ts` defaults and by the update migrator (direct file writes, not the API), all unchanged.
- Reading them is unchanged.

## Signal vs authority
Narrows who may change a setting; refuses nothing that runs today.

## Rollback
Revert the commit.

## Tests
- `bearer-config-write` (+1), `grok-build-round17-security`, `feature-action-applier`, `refuse-unsupported-fields`: all pass.

## Second-pass review

**Reviewer:** independent Claude reviewer subagent. Verdict: concur. Its notes, applied here: the refusal wording in both write paths now names where sessions connect and which account pays, not only which program runs; the summary now says an address change can reach new Claude sessions at once, not only after a restart.

Recorded as a separate finding for the security ledger, not changed here: `tunnel.token`, `tunnel.configFile` and `tunnel.hostname` are patchable and could re-point the agent's public address at another tunnel account; `threadline.relayUrl` and the framework-routing keys are lower-impact routing settings in the same review.
