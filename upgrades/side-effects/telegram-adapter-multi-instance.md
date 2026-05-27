# Side-Effects Review — TelegramAdapter multi-instance isolation + Message-type extension (PR 2a)

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Fix 2b "Implementation surface" items
1-2 + round-2 integration F1 (converged, approved). PR 2 of the staged build, part a.
**Change:** Make `TelegramAdapter` safe to run as a second (non-primary) instance in one
process, and expose the Telegram fields the a2a spoof-defense needs. **Ships dark** — no
caller passes the new options yet; the new Message fields are additive-optional.
**Files:** `src/messaging/TelegramAdapter.ts`, `tests/unit/telegram-adapter-multi-instance.test.ts` (new).

## What changed

1. **Constructor opts `{ subDir?, suppressLifelineAutoCreate? }`** (3rd param, optional). When
   `subDir` is set, the four per-bot state files (registry / message-log / poll-offset /
   attention) live under `{stateDir}/{subDir}/` via a new `botStateDir`. The PRIMARY bot
   (no `subDir`) gets `botStateDir === stateDir` → **paths are byte-for-byte unchanged**.
2. **`suppressLifelineAutoCreate`** — `start()` skips `ensureLifelineTopic()` when true, so a
   non-primary bot can't create a second Lifeline topic in the chat.
3. **Message-type extension** — `message.from.is_bot?: boolean` + `message.sender_chat?` added
   to `TelegramUpdate`. These are the structural inputs to the a2a user-spoof defense (a
   human typing an `[a2a:…]` marker has `is_bot:false` and no `sender_chat`).

## The seven questions

1. **Over-block.** N/A — no gate. The only behavior gate is `suppressLifelineAutoCreate`,
   default false (primary unaffected).
2. **Under-block.** The reviewer-flagged collision (two adapters sharing
   `telegram-poll-offset.json` → `poll()`'s cross-token detection fires continuously) is
   eliminated: non-primary state is namespaced. Test asserts the two adapters share NO
   state-file path.
3. **Level-of-abstraction fit.** The isolation is at construction (one place), not scattered
   per-callsite. `botStateDir` is the single source for per-bot paths.
4. **Signal vs authority.** N/A.
5. **Interactions — THE risk, and how it's bounded.** This file runs Echo's own (primary)
   Telegram — the channel to the user. The change is built so the primary path is
   **identical** (when `subDir` is undefined, `botStateDir === stateDir`). A dedicated test
   asserts the four primary paths are byte-for-byte the historical `{stateDir}/...` values,
   and the existing TelegramAdapter suites (71 tests across 5 files) pass unchanged — the
   regression guard for "did I break my own comms." The new code only branches when `subDir`
   is set, and nothing sets it yet (dark). Media/dashboard dirs still resolve off `stateDir`
   inline — NOT isolated — which is fine: the reviewer flagged only the four constructor
   state files, and the mentor bot (the only future `subDir` user) does no media/dashboard.
6. **External surfaces.** None. No routes, no config consumed yet. The Message-type fields
   are additive-optional (every existing reader ignores them).
7. **Rollback cost.** Trivial — revert restores the 2-param constructor; no data, no migration
   (the primary never wrote to a subDir).

## Testing

- `tests/unit/telegram-adapter-multi-instance.test.ts` (3 tests): **primary paths byte-for-byte
  unchanged** (the load-bearing safety assertion); subDir namespaces all four state files +
  shares no path with primary + creates the sub-dir; `suppressLifelineAutoCreate` recorded
  (false default for primary).
- Regression: existing Telegram suites (`TelegramAdapter`, `telegram-format-wireup`,
  `telegram-adapter`) + the PR-1 `AgentTelegramComms` suite — 71 tests, all green.
- `tsc --noEmit` clean.

## Migration parity

None — additive constructor option + additive optional Message fields. No agent-installed
file change, no config consumed yet. PR 2b wires `sendAgentMessage` + the recipient handler;
PR 3's config/migration is per the spec's §Migration parity.
