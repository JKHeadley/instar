# Side-effects review — subscription-pool session pinning (makes auto-swap functional)

## What changed
- `src/core/SessionManager.ts`: new optional `spawnAccountResolver` dep + `setSpawnAccountResolver()` setter (mirrors `setTopicBindingChecker`). In BOTH initial-spawn lanes (headless `spawnSession` + the rerouted-interactive spawn), when the resolver returns an account AND the launching framework is claude-code, set `spec.envOverrides.CLAUDE_CONFIG_DIR = account.configHome` and tag the session record `subscriptionAccountId: account.id`.
- `src/core/types.ts`: new `subscriptionPool.pinSessionsToPool?: boolean` (default off).
- `src/commands/server.ts`: when `pinSessionsToPool` is enabled, wire `setSpawnAccountResolver` to `selectAccount(pool.list(), {nowMs})` (the scheduler's reset-date/headroom score).

## Why (the bug it fixes)
Auto-swap (`server.ts` `rate-limit:escalated` handler) does `if (!session.subscriptionAccountId) return;` — it only moves sessions tagged with an account. But NO spawn ever wrote that field (0/60 live), because sessions launch on the default config, not via the pool. So auto-swap was a structural no-op and a session that hit its account's quota wall just died (live incident 2026-06-08). This change writes the tag (and launches on a real pool account), which is the missing prerequisite that makes auto-swap function.

## Blast radius — CRITICAL PATH, gated to a strict no-op by default
- This touches session SPAWNING (the most critical path). It is gated three ways so the default is byte-identical: (1) `pinSessionsToPool` defaults off → server never calls the setter → `spawnAccountResolver` stays unset; (2) with the resolver unset, both lanes take the `pinnedAccount = null` branch → no `CLAUDE_CONFIG_DIR` added, no `subscriptionAccountId` set — exactly today's behavior; (3) the claude-code guard means a codex/gemini spawn is never given a Claude config home.
- When ENABLED: claude-code spawns launch under the scheduler-picked account's config home. The config homes come from the pool (real enrolled accounts), so the spawn authenticates correctly. If `selectAccount` finds no eligible account, the resolver returns null → falls back to the default config (no breakage).
- The account-swap restart method (`SessionManager` ~line 3057) ALREADY set `subscriptionAccountId` + configHome for swaps — untouched; this only adds the same tagging to INITIAL spawns.

## Framework generality
- Pinning is claude-code-specific by design (CLAUDE_CONFIG_DIR is a Claude env var; the headless lane guards on `headlessFramework === 'claude-code'`, the interactive reroute lane is always claude-code). Codex/Gemini spawns are unaffected — they never receive a config-home override.

## Migration parity
- No agent-installed files change. New config field (`pinSessionsToPool`) is optional, default off → existing agents unaffected until explicitly enabled. No `PostUpdateMigrator` entry needed.

## Tests
- Unit (`session-manager-behavioral.test.ts`): spawnSession pins (CLAUDE_CONFIG_DIR flag + subscriptionAccountId, persisted) when the resolver is set; does NOT pin when unset or when the resolver returns null. Inspects the real tmux `new-session` argv via the execFileSync mock.
- Integration (`subscription-pin-sessions.test.ts`): the full production chain — real SubscriptionPool + the real `selectAccount` resolver wired exactly as server.ts → spawnSession pins to the optimal account (the higher-headroom/sooner-reset one wins); empty pool → no pin.
- No HTTP route, so the standard's Tier-3 "route alive (200 not 503)" form does not apply; the integration test exercises the production wiring shape (the server.ts resolver closure) instead.
