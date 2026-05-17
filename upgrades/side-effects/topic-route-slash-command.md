# Side-effects review — /route slash-command + TopicFrameworksStore

**Version / slug:** `topic-route-slash-command`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (additive command surface + new persistent store; existing topicFrameworks config still consulted as a default layer; reverts are mechanical)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md`

## Summary of the change

Justin confirmed the user-facing model: per-topic choice is "Claude Code" or "Codex." The (a)/(b) sub-distinction is invisible — handled by Phase 5c's cost-aware router for internal calls. This commit adds the manual swap mechanism Justin asked for: a `/route` slash-command in Telegram topics + a persistent store that survives restarts.

Files added:
- `src/core/TopicFrameworksStore.ts` — runtime-mutable, atomically-persisted per-topic framework binding. Two-layer read (overrides from state file ∪ config defaults from `InstarConfig.topicFrameworks`); writes only to state file at `<stateDir>/state/topic-frameworks.json`. Tolerates a corrupt state file at boot (logs, falls back to config defaults).
- `tests/unit/TopicFrameworksStore.test.ts` — 9 cases covering atomic writes, layer merge, clear/snapshot, corrupt-file tolerance, hostile-value rejection.

Files modified:
- `src/messaging/TelegramAdapter.ts` — new `onRouteCommand` callback hook; `/route` and `/route <framework>` parsing in `handleCommand` (uses the existing intercept-before-injection pattern that `/sessions`, `/claim`, `/flush` already follow). `handleCommand` is now `public` (was `private`) so the lifeline-forward path in `server.ts` can invoke it directly.
- `src/commands/server.ts` — initializes `TopicFrameworksStore` at boot; wires `telegram.onRouteCommand` in `wireTelegramCallbacks`. The handler persists the new framework via the store, then triggers a respawn via the existing `respawnSessionForTopic` flow so the change takes effect immediately. `resolveTopicFramework` consults the store first (overrides win), then the legacy in-memory `_topicFrameworks` (config defaults), then the agent-level default. Also added: at the top of `onTopicMessage`, call `telegram.handleCommand(text, topicId, telegramUserId)` for `/`-prefixed text and return early if handled. This is the lifeline-forward fix — in lifeline-owned polling mode (deep-signal, echo), TelegramAdapter's own poll loop never runs, so commands forwarded through `/internal/telegram-forward` previously bypassed `handleCommand` entirely and reached the spawned AI session as plain chat text. With this in place `/route`, `/sessions`, `/claim`, `/flush`, `/login`, `/quota`, `/interrupt`, etc. all behave identically whether the server polls Telegram directly or lifeline forwards.

User-facing surface:
- `/route` or `/route status` — show the framework currently active for this topic.
- `/route claude-code` — switch this topic to Claude Code; respawns the session if one is running.
- `/route codex-cli` — switch this topic to Codex; respawns the session if one is running.

## Decision-point inventory

- **Separate state file vs config.json mutation** — `add` (separate file). Per Justin's #3 design requirement ("robust, no surprises"): operator-edited config and agent-edited runtime state should not share a write path. Risks of mixing: an in-flight agent write trampling Justin's manual edit, or vice versa. The two-layer merge gives him a stable place to set defaults that the agent never overwrites.
- **Atomic write via tmp + rename** — `add`. Standard fs idiom for crash-safety; partial writes never appear at the canonical path.
- **Trigger respawn synchronously after persist** — `add`. The change isn't useful if it doesn't take effect immediately. Justin's clarification was "as seamless as possible" — making the swap visible in the next message rather than the next restart fits that.
- **Reuse `respawnSessionForTopic` instead of inventing a new flow** — `add`. Per Justin's spec answer to question 2 ("handled just like a regular session start after a message lands in an existing topic. Please look this up."). The respawn path already bootstraps the new session with TopicMemory's summary + recent messages — conversation continuity is free.
- **No /route command for the global framework** — `defer`. The global choice is set via `INSTAR_FRAMEWORK` env at boot. Adding a global slash-command is a different problem (cross-topic side effects) and not in this commit's scope.
- **Tolerate corrupt state file** — `add`. The store logs and silently falls back to config defaults rather than crashing the server boot. Justin's design constraint was "robust, no surprises" — crashing on corrupt state would be a surprise.

## Signal vs authority

The `/route` command is user-authority — Justin (or an authorized user in the topic) explicitly asks for the change. The store is a deterministic persistence layer; it has no policy authority of its own. Future AI-suggested swaps will route through the same store via the existing TelegramConfirmer flow (Phase 5b) — that path is deferred to a follow-up commit.

## Over-block / under-block analysis

**Over-block:** None. The command is additive. Topics without `/route` use the existing config-default path unchanged. The new `handleCommand` call in `onTopicMessage` returns `false` for unrecognized `/`-prefixed text, so plain chat messages that happen to start with `/` fall through to the existing AI-session injection path. In polling mode, `onTopicMessage` is never called for commands at all (the adapter's own poll loop short-circuits at line 2899), so the new code is dead in that path — no double-handling risk.

**Under-block:** A user with shell access to the state file could write any string value and the store would drop it silently. That's the right behavior (graceful degradation), but the user gets no feedback that their edit was rejected. Acceptable for v1.0.0 because the canonical edit path is the slash-command, not direct file edits.

## Level-of-abstraction fit

- `TopicFrameworksStore` lives in `src/core/` alongside other persistent-config siblings (`Config.ts`, `StateManager.ts`).
- `onRouteCommand` is a callback hook on `TelegramAdapter` matching the pattern of `onListSessions`, `onInterruptSession`, etc. The adapter owns the parse; the server owns the policy. Clean signal-vs-authority split.
- `resolveTopicFramework` lives in `server.ts` as before; the store is a new dependency it consults.

## Interactions

- `spawnSessionForTopic` and `respawnSessionForTopic` consume `resolveTopicFramework(topicId)` — now reading from the store. No interface change.
- `Tier 1.A` topicFrameworks config keys remain readable as defaults. Operators who set them keep working.
- Phase 5c cost-aware routing — unaffected by this commit. The router still picks SDK-vs-subscription adapters; the framework binding is per-topic and orthogonal.

## External surfaces

- New slash-command in Telegram: `/route` and `/route <framework>`.
- New persistent state file: `<stateDir>/state/topic-frameworks.json`.
- No new endpoints, env vars, or config keys.

## Rollback cost

Low. Revert removes the store, the command handler, and the wiring. The legacy in-memory `_topicFrameworks` path still works for config-level defaults. No state-shape migration needed (the state file is opt-in).

## Tests / verification

- `npx tsc --noEmit` clean.
- 9 new store unit tests pass (atomic persist + reload, layer merge, corrupt-file tolerance, hostile-value rejection).
- 89 touched-area tests still pass (including the integration suite covering per-topic dispatch).
- No real-Telegram smoke test in this commit — verification requires Justin to actually run `/route` in a topic against his live agent. The fake-binary integration tests prove the spawn shape; only Telegram round-trip exercises the parser.
