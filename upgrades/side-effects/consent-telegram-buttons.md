# Side-effects review — Telegram consent buttons (PR 6 of tunnel-failure-resilience chain)

**Scope (PR 6 of the chain):** Wire the consent state machine (PR 5)
to a real Telegram inline-button UX. When Tier-1 is exhausted and a
Tier-2 relay is available, the owner gets a DM with two buttons —
"Yes, use a backup" / "No, keep waiting" — and tapping one drives
`grantConsent` / `declineConsent` on the manager. Spec
`specs/dev-infrastructure/tunnel-failure-resilience.md` Part 3.

**Files touched:**
- `src/messaging/TelegramAdapter.ts` — adds `setTunnelConsentHandler`
  (handler injection), `sendOwnerConsentPrompt(text, nonce)` (DM with
  inline buttons carrying `tc:g:<nonce>` / `tc:d:<nonce>`), and a new
  `tc:`-prefixed early-return branch in `processCallbackQuery` that
  enforces the owner-principal check, validates the nonce shape, calls
  the injected handler, and clears the keyboard. `editMessageWithRetry`
  gains an optional `chatId` param (defaults to `config.chatId`) so the
  keyboard-clear edit can target the owner's private DM rather than the
  group — without disturbing the existing prompt-gate callers.
- `src/tunnel/TunnelManager.ts` — `attachTelegram` captures the adapter
  ref, registers the grant/decline handler, and passes
  `suppressConsentDM: true` to the notifier; `requestConsent` sends the
  button prompt (degrading to plain-text `sendToOwnerDM` when an adapter
  lacks button support). Adds `consentPromptText`. The
  `TunnelMessagingAdapter` interface gains two optional methods.
- `src/tunnel/TunnelNotifier.ts` — adds `suppressConsentDM` option so
  the manager-sent button prompt isn't duplicated by the notifier's
  plain-text owner-DM.
- `tests/unit/tunnel-consent-telegram.test.ts` — NEW. 10 tests: 6 on
  the manager↔adapter seam (handler registration, button prompt carries
  the live nonce, no double-send, grant→relay-active, decline→exhausted
  +cooldown, stale-nonce no-op) and 4 on the adapter-side callback gate
  (owner grant/decline, NON-owner rejection, malformed `tc:` data).

**Over-block:** None. The `tc:` prefix is unique in the codebase (a grep
for `callback_data:` literals returns only PR 6's two buttons), the
regex is strict (`^tc:([gd]):([0-9a-f]{32})$`), and any non-`tc:`
callback falls through unchanged to the existing prompt-gate handler
below. Malformed `tc:` data is answered with "Invalid consent button"
and consumed, never forwarded.

**Under-block:** One edge worth naming. The owner gate is
`if (owner && query.from.id !== owner) reject`. When **no** owner is
configured (`ownerUserId` and `promptGate.ownerId` both unset), the gate
is skipped. This is benign by construction: with no owner there is no DM
target, so `sendOwnerConsentPrompt` returns null and **no button is ever
sent** — there is nothing to click. Even a hand-crafted callback can't
activate a relay, because `grantConsent` requires a single-use CSPRNG
nonce that matches the live pending-consent record (cleared-before-start
so a replay loses). Security is layered: owner-principal check **and**
nonce match. The adapter regex is only a low-level validator (signal);
the manager's `grantConsent` holds the blocking authority.

**Level-of-abstraction fit:** Clean. The adapter owns the Telegram
protocol (parse, owner check, answer toast, keyboard clear); the manager
owns the tunnel-state transition via the injected handler. The adapter
never imports tunnel types and the manager never imports Telegram types
(the duck-typed `TunnelMessagingAdapter` interface is the seam).

**Interactions:**
- `query.data` is guarded (`if (!query.data) return`) immediately above
  the `tc:` block, so `.startsWith` can't throw.
- The path is reached both by the poll loop and by
  `handleForwardedCallback` — the Lifeline forwards callbacks in
  send-only mode, which is exactly the tunnel-down scenario this feature
  exists for.
- `suppressConsentDM` prevents a double owner-DM (button prompt from the
  manager + plain-text prompt from the notifier).
- No HTTP surface in this PR, so the Tier-2/Tier-3 "feature is alive"
  HTTP tests are N/A. Wiring is verified two ways: the unit test asserts
  `attachTelegram` registers the handler, and the production call site
  exists at `src/commands/server.ts` (`tunnel.attachTelegram(telegram, …)`).

**Rollback cost:** Low. Purely additive; `suppressConsentDM` defaults
false (back-compat for existing notifier callers). No config schema,
migration, or persistent state. Revert = drop the three method additions
+ the `tc:` block + the `attachTelegram` handler-registration lines.
