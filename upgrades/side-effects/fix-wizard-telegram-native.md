# Side-effects review — Telegram-native wizard + add-user cwd + choice echo

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER on three counts.
- `add-user` action passed `-d` to a CLI that doesn't accept it →
  silent profile-creation failure.
- Choice prompts silently accepted text input without echoing what
  got resolved → user couldn't tell whether their input was
  understood.
- Telegram action spawned `codex exec` (non-interactive) and then
  marked the channel configured even though no token was captured.

After: precisely targeted.
- `add-user` uses cwd consistently with how `instar user add`
  actually resolves project context.
- Choice prompts echo `→ {label}` after validation passes (no-op for
  text prompts).
- Telegram action is instar-native readline + Telegram Bot API; only
  marks the channel configured when the config write succeeds.

No over-block: the Claude wizard path is untouched, WhatsApp + Slack
flows are unchanged, the state machine's flow is unchanged.

## 2. Level-of-abstraction fit

Three small, scoped changes inside the existing codex-driver module:

- One spawn-options edit on the `add-user` action (drop `-d`, add
  cwd). Same pattern applied prophylactically to `start-server`
  and `install-autostart` for consistency.
- One helper function `echoChoice(state, answer)` called from the
  existing `renderNarrativeState` retry loop. Pure render concern,
  no state-machine API change.
- `runTelegramSetup` rewritten as a 100-line instar-native flow
  plus three small private helpers (`telegramGetMe`,
  `telegramGetUpdates`, `writeTelegramConfig`). Replaces a 50-line
  codex-spawn helper. Net code size grew by ~150 LOC for a more
  reliable result.

No new module, no new abstraction. The driver remains the single
home for codex-cli wizard implementation.

## 3. Signal vs Authority compliance

- The Telegram API's `getMe` response is the AUTHORITY for "is this
  a valid bot token." Pre-fix, the wizard never validated.
- The Telegram API's `getUpdates` response is the AUTHORITY for
  "what chat IDs has this bot seen." We extract from there rather
  than inventing.
- The wizard's `choice` resolver remains the AUTHORITY for "what
  did the user mean by their text input." Echo just surfaces the
  AUTHORITY's decision to the user.
- The `add-user` cwd change makes process-directory the SIGNAL the
  CLI was always reading; the prior `-d` flag was a wrong-signal
  attempt that the CLI rejected outright.

## 4. Interactions with adjacent systems

- **State machine `setup-telegram-agentic` action**: name unchanged
  (still describes the user-visible intent). Implementation moved
  from codex-spawn to instar-native. Downstream consumers
  (`send-greeting` action, future Telegram-dependent steps) see the
  same `{ telegramConfigured: boolean }` return shape.
- **`writeTelegramConfig`**: writes the exact messaging schema the
  agent server already consumes (`type/enabled/config.token/chatId/
  pollIntervalMs/stallTimeoutMinutes`). No change to consumers.
- **`renderNarrativeState`**: gains one `echoChoice(state, answer)`
  call after the validator accepts. Wraps the existing return path,
  doesn't change it.
- **`add-user` action**: cwd change is invisible to the CLI; same
  outcome via the correct flag set.
- **Existing v1.2.14 validators + spinner**: untouched.
- **Claude wizard path**: untouched.

## 5. Rollback cost

Low-medium. `runTelegramSetup` is fully replaced (not patched), so
revert restores the broken codex-spawn version. The other two fixes
are small enough to revert independently if needed.

## 6. Backwards compatibility / drift surface

Fully backwards-compatible.

- Codex-runtime users: get a working Telegram setup. Previously
  got broken silent-success.
- Claude-runtime users: zero change.
- Existing `instar add telegram` CLI command (the post-setup
  fallback): unchanged. If the wizard skips Telegram, the user can
  still run `instar add telegram` later — and the `writeTelegram
  Config` helper writes the EXACT same schema, so the two flows
  produce identical config.
- No config schema change. No agent-installed-files change. No
  `PostUpdateMigrator` work.

## 7. Authorization / Trust posture

No new authority. `fetch` calls to api.telegram.org happen with the
user's bot token (which they paste into the wizard). The wizard
runs in-process, same trust level as everything else in setup.

## Outcome

Ship. Closes three real-user bugs surfaced on the v1.2.14 install
test. Replaces the broken codex-spawn Telegram setup with an
instar-native flow that's robust across all environments
(Playwright available or not, Codex behavior aside). Echo and
add-user fixes are small companions that round out the v1.2.15
delivery.
