# Side-Effects Review — relay reply scripts resolve auth token from INSTAR_AUTH_TOKEN (survive secret-externalization)

**Version / slug:** `telegram-reply-secret-token`
**Date:** `2026-05-29`
**Author:** `instar-echo`
**Spec:** `docs/specs/delivery-robustness.md` (the reply scripts are the agent's outbound delivery transport — a delivery-robustness layer)

## Summary of the change

When **secret-externalization** is enabled, `.instar/config.json`'s `authToken` is rewritten from a plaintext string into a secret-**reference** object (`{"secret":true}`), with the real token moved into the encrypted store (`.instar/secrets/config.secrets.enc`). The messaging reply scripts read `authToken` straight from `config.json` via `python json...get('authToken','')`, so after externalization they emitted a **Python dict-repr** (`{'secret': True}`) as the bearer token → every send got **HTTP 403** → the agent's mandatory Telegram relay (and Slack/WhatsApp/iMessage equivalents) silently broke.

Fix applied to all four reply scripts (`src/templates/scripts/{telegram,slack,whatsapp,imessage}-reply.sh`):
1. **Sanitize the config read** — `print(t if isinstance(t, str) else '')` so a secret-ref object yields `''`, never a dict-repr.
2. **Prefer the env var** — `if [ -n "$INSTAR_AUTH_TOKEN" ]; then AUTH(_TOKEN)="$INSTAR_AUTH_TOKEN"; fi`. The launcher already injects the **resolved** token into every session as `$INSTAR_AUTH_TOKEN` (verified: `SessionManager` spawns with `-e INSTAR_AUTH_TOKEN=${config.authToken}`, and `JobScheduler` sets it too). Env is therefore authoritative; config.json is a legacy fallback only.

## Decision-point inventory

- reply-script auth resolution — **modify** — env-first with sanitized config fallback. Chooses which token the script presents.
- python config read — **modify** — guard non-string `authToken` to prevent dict-repr leakage.

## 1. Over-block

None. The change only *adds* a token source (env) and *sanitizes* a malformed one. A legitimate plaintext `authToken` in config.json still works when no env var is present (unchanged legacy behavior). No new failure path for correctly-configured agents.

## 2. Under-block

If `INSTAR_AUTH_TOKEN` were ever set to a WRONG value it would override config — but the launcher sets it from the same resolved `config.authToken`, so it's correct by construction. A manual invocation outside a launched session (no env var) falls back to config.json exactly as before. No new auth bypass.

## 3. Level-of-abstraction fit

The fix belongs in the scripts because they are the leaf transport that talks to the local server with the bearer token. The deeper fix (the server resolving secrets) already exists — `SecretStore` decrypts `config.secrets.enc`, and the launcher exports the resolved token. The scripts simply need to consume the env the launcher already provides. (Precedent: `src/data/pr-gate-artifacts.ts` already uses `AUTH_TOKEN="${INSTAR_AUTH_TOKEN:-}"`.)

## 4. Signal vs authority compliance

Not applicable — this is a transport auth-resolution fix, not a gate/classifier. No block/allow surface, no LLM judgment.

## 5. Interactions

- **Migration parity:** `PostUpdateMigrator` already overwrites the deployed `telegram-reply.sh` (and the framework-neutral `.instar/scripts/` copy) on every update (PostUpdateMigrator.ts ~3707–3756), so existing agents get the fixed script on their next update. The sibling scripts (slack/whatsapp/imessage) ship via the same template-refresh path. **No new migration code needed** — verify the existing migrator covers the siblings; if a sibling isn't in the always-overwrite set, that's a follow-up (telegram is the critical/mandatory path and is covered).
- **No config/schema change.** No new env var (INSTAR_AUTH_TOKEN already exists and is already injected).
- **Blast radius:** the four reply scripts only. Rollback = revert the per-script blocks.

## 6. Known same-pattern siblings (follow-up, not in this PR)

These also read `authToken` from config.json and would 403 the same way under externalization, but are lower-criticality (hooks/observability, not the mandatory user-reply path):
`src/templates/hooks/session-start.sh`, `telegram-topic-context.sh`, `compaction-recovery.sh`, `slack-channel-context.sh`; `src/templates/scripts/instar-watchdog.sh`, `serendipity-capture.sh`. Recommended follow-up: apply the same env-first guard. Flagged so it's not silently forgotten.

## Tests

`tests/unit/reply-scripts.test.ts` (the existing real-script harness — spawns the actual `.sh` against a mock HTTP server) extended with an "auth token resolution under secret-externalization" block covering telegram/slack/whatsapp: (a) env token is used when config.json `authToken` is a secret-ref object; (b) no dict-repr/object leak when env is unset; (c) env overrides a stale plaintext config token. **21/21 tests pass; `tsc --noEmit` clean.**
