# Side-Effects Review — session launch reads sessions.credentials.anthropic

**Version / slug:** `session-credential-map`
**Date:** `2026-11-02`
**Author:** `echo`
**Second-pass reviewer:** `not required (no block/allow surface; a credential value read at boot, not a session lifecycle decision)`

## Summary of the change

`src/core/Config.ts` adds `resolveAnthropicLaunchFields()` and uses it to fill `SessionManagerConfig.anthropicApiKey` / `anthropicBaseUrl`. These are the two fields every claude-code spawn path turns into `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`. Before, only the legacy `sessions.anthropicApiKey` fed them. An install configured the documented way (`sessions.credentials.anthropic`) therefore launched every session with an EMPTY token, and Claude Code answered "Not logged in". Found 2026-11-02 on the first Linux cloud agent (fb-7cb86d4b-1fd). The precedence now matches `buildCredentialsMap()` / `getProviderCredential()`: explicit `credentials.anthropic` first, legacy fields as the fallback, per field. Tier 1, 1 source file (+~25 LOC), 1 new test file (8 tests). Effort: one round, one commit attempt.

## Decision-point inventory

No decision-point surface. It selects which configured credential string a spawn uses. Nothing is gated, blocked or filtered.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface — under-block not applicable. Known remaining gap: a credential stored as an unmigrated `{ secret: true }` placeholder is ignored (not stringified) and falls through to the legacy field or none. This is the same behavior an install had before.

## 3. Level-of-abstraction fit

Right layer. Config assembly is the single place `SessionManagerConfig` is built. Fixing it there keeps the six spawn sites in `SessionManager.ts` untouched, and reuses the precedence `buildCredentialsMap()` already documents. Patching each spawn site would have duplicated that rule six times.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It reads configuration. No detector and no authority is added or changed.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The precedence is an enumerable invariant: an explicit entry beats the legacy fallback, and this was already documented in `buildCredentialsMap()`.

## 5. Interactions

- `getProviderCredential()` / `buildProviderEnvFlags()` already used the map first, so the two paths now agree instead of disagreeing.
- Provenance (`credentialSource: 'env' | 'store'`, SessionManager §2.10) keys on `anthropicApiKey !== ''`. A map-only install now correctly reports `env` (an env-token launch), and the CredentialEnvTokenGate sees the token it actually launched with.
- Installs that set BOTH fields with DIFFERENT values: the explicit `credentials.anthropic` value now wins at launch where the legacy one used to. The map already won everywhere else, so this removes a split-brain rather than creating one.

## 6. External surfaces

Sessions on map-only installs now authenticate instead of starting "Not logged in". No route, file format or message changes. No new egress.

## 6b. Operator-surface quality

No operator surface touched.

## 7. Multi-machine posture

Machine-local BY DESIGN. Each machine reads its own `.instar/config.json` at boot, and credentials are never replicated (WS5.2: logins are minted per machine).

## 8. Rollback cost

A revert restores the old legacy-only read. No migration, no state. A map-only install would go back to "Not logged in" until the legacy field is set.

## Conclusion

Safe, narrow fix that removes a disagreement between two credential readers. Ship as Tier 1.

## Evidence pointers

- Live failure: Cirrus (Hetzner, Ubuntu 24.04, Instar 1.3.1611) at 2026-11-03T01:33Z. tmux launch argv carried `-e CLAUDE_CODE_OAUTH_TOKEN=` (empty), and the transcript answered "Not logged in · Please run /login". Setting the legacy field made `/tmp/smoke.txt` appear.
- `tests/unit/anthropic-launch-credential.test.ts`: 8 tests. The loadConfig wiring test fails with the old line restored (verified 2026-11-02 20:12 PST) and passes with the fix.
