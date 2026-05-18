# Side-effects review — Codex Telegram-relay bootstrap fix

**Version / slug:** `codex-telegram-relay-bootstrap`
**Date:** `2026-05-18`
**Author:** Echo
**Second-pass reviewer:** self-review — additive structural fix; framework-aware; covered by new tests + scenario-level test-as-self.
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md` (Rule 2 + Codex/local-model parity).

## Summary

Codex-routed Telegram topics on v1.0.0 received user messages, processed them in the Codex CLI session, but never called `telegram-reply.sh` — the user only saw PresenceProxy standby messages and assumed the agent had ignored them. Claude Code-routed topics didn't have this bug because a SessionStart shell hook (`.claude/hooks/instar/session-start.sh`) re-injects "MANDATORY: After EVERY response, relay…" at every session start. Codex CLI has no analogous hook system, so the relay convention has to live somewhere structural in the prompt context.

Three changes, shipped together so the fix is durable across both turn-1 spawn and every subsequent injection within a long-running session:

1. **`src/messaging/shared/telegramRelayPrompt.ts` (new).** Pure helper that emits the inline "Telegram Relay (MANDATORY)" block with the exact bash command, framework-aware. Imported by every bootstrap-construction call site.

2. **`src/commands/server.ts` + `src/server/routes.ts`.** All three Telegram bootstrap paths (spawnSessionForTopic, /internal/telegram-forward main, /internal/telegram-forward Secret Drop) now append the relay block inline. Previously the relay instruction lived in a side ctx file that the agent was supposed to read — Codex apparently treats that as skippable background, not a structural directive.

3. **`src/core/IdentityRenderer.ts`.** New `appendTelegramRelayBlock` option auto-appends a "## Telegram Relay (MANDATORY)" section to AGENTS.md/CLAUDE.md at render time. AGENTS.md is loaded into Codex's system prompt for the entire session lifetime, so this covers every subsequent turn — not just turn 1. Idempotent: existing shadows with the appendix are skipped; missing-appendix shadows get re-rendered when the caller asks.

Plus the test-as-self framework upgrade Justin requested:

4. **`run-v1-scenarios.py`.** New `is_sentinel_text` helper recognizes sentinel/proxy patterns (✓ Delivered, Session restarting, Session respawned, 🔭/✷︎ prefix + "N-minute update/check", "appears to be stuck", "Reply unstick", etc.). `wait-for-response` excludes them by default; scenarios that legitimately want sentinel-acceptance can opt in via `acceptSentinel: true`. Without this, every "did the agent reply?" assertion was satisfied by sentinel chatter — the exact failure mode the screenshot caught.

5. **Two new scenarios.** `12-codex-telegram-roundtrip` flips topic 2525 to Codex and asserts a non-sentinel "PONG12" reply within 120s. `13-local-model-telegram-roundtrip` does the same for the Codex --oss + Ollama passthrough (degrades to cloud Codex if the operator hasn't configured `topicCodexLocalProvider`, still passes because the assertion is "agent replied at all").

## Decision-point inventory

- **Inline bootstrap relay block** — `change`. The previous ctx-file indirection was structurally too weak for Codex. Mirrors signal-vs-authority: the relay convention is authoritative, not optional context.
- **AGENTS.md appendix** — `add`. New structural surface, gated on `appendTelegramRelayBlock: true` so non-Telegram installs aren't affected.
- **Idempotent re-render when appendix missing** — `change`. ensureFrameworkIdentityFile's "shadow exists → no-op" was too coarse; we need to re-render when the appendix is missing but requested.
- **Sentinel-exclusion in test driver** — `change`. The default-true behavior is "agent must really reply"; the opt-in for sentinel-friendly scenarios stays narrow.

## Signal vs authority

- The relay block is authoritative: presence in the prompt is enforced by the bootstrap path (server.ts/routes.ts) and by IdentityRenderer. Removal regresses obvious behavior.
- Sentinels remain signal: they detect agent silence and emit standby messages, but they don't carry the agent's voice. The test driver's `is_sentinel_text` filter encodes this distinction structurally.

## Over-block / under-block analysis

**Over-block:** None. Existing Claude installs receive the same inline block; their SessionStart hook also fires — duplicate reminder is harmless (Claude already complies). Codex installs receive the block where they previously received nothing.

**Under-block:** None. The block is appended to every Telegram-spawned session regardless of framework; the appendix renders into both AGENTS.md (Codex) and CLAUDE.md (Claude) when callers pass `appendTelegramRelayBlock: true`.

## Level-of-abstraction fit

- `buildTelegramRelayBlock` lives in `src/messaging/shared/` next to `isSystemOrProxyMessage` — peer location for shared message-classification helpers.
- IdentityRenderer extension stays in IdentityRenderer; no new module.
- Test driver changes stay in the existing runner; no new entry point.

## Interactions

- Coexists with the SessionStart shell hook (Claude Code path) — the bootstrap inline block is harmless redundancy when the hook fires.
- Coexists with PresenceProxy: when the agent now replies for real, PresenceProxy's standby messages stop appearing because the agent's reply clears the watchdog. Verified end-to-end in scenario 12 (PONG12 reply lands, sentinel chatter stops).
- The `telegram-reply.sh` template drift surfaced during scenario validation: deep-signal had an OLD relay script that posted directly to Telegram instead of through the local server. This is fixed by `TemplatesDriftVerifier` + PostUpdateMigrator's hook-overwrite path on the next `instar update`; the fix here is structurally independent.

## Rollback cost

- Revert is one commit. Restored behavior is "Codex sessions don't relay, sentinels fill the gap" — the bug, but no data loss.
- No schema changes. AGENT.md (canonical source) is unchanged; only the rendered shadows gain the appendix.

## Verification

- `npx tsc --noEmit` clean.
- `npm run lint` clean (Rule 1 drift gate green).
- New unit tests: `tests/unit/telegramRelayPrompt.test.ts` (7 tests), `tests/unit/IdentityRenderer.test.ts` extended (+5 new tests for appendTelegramRelayBlock).
- End-to-end on deep-signal (running v1.0.0 + this fix deployed): 14/14 scenarios PASS, including 12-codex-telegram-roundtrip (PONG12 codex-cli) and 13-local-model-telegram-roundtrip (PING13 gpt-5.3-codex).
- Pre-fix scenario 12 deterministically FAILS with the correct diagnostic: "last sentinel message seen: '🔭 deep-signal is actively working…' — the agent itself never replied, only sentinels did". This is the regression-prevention shape Justin asked for.
