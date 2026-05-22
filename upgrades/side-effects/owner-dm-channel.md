# Side-effects review — owner-DM channel + notifier sink wiring (PR 3 of tunnel-failure-resilience chain)

**Scope (PR 3 of the chain):** Add the owner-DM messaging surface and
wire it into the tunnel manager's two-channel notifier. Spec
`specs/dev-infrastructure/tunnel-failure-resilience.md` is converged
+ approved on main. Public API: `TelegramAdapter.getOwnerUserId()` and
`TelegramAdapter.sendToOwnerDM(text)` are new; `TunnelManager.attachTelegram()`
is new; the notifier now substitutes live URL + PIN credentials into
owner-DM messages via a `credentialProvider` callback.

**Files touched:**
- `src/messaging/TelegramAdapter.ts` — adds `ownerUserId?: number` to
  `TelegramConfig`; adds `getOwnerUserId()` accessor (falls back to
  `promptGate?.ownerId` for back-compat); adds `sendToOwnerDM(text)`
  which posts to the owner's private bot chat via `sendMessage` with
  `chat_id: ownerUserId`. The DM send is fire-and-forget: failure paths
  ("no owner configured", "owner hasn't messaged the bot", network
  error) log-not-throw and return `null` so callers can degrade
  gracefully.
- `src/tunnel/TunnelNotifier.ts` — adds `credentialProvider?: () =>
  CredentialSnapshot` to `TunnelNotifierOptions`. The four owner-DM
  message variants (recovered, restored, consent prompt, relay
  activated) now compose real English text with the credentials
  substituted at compose time. The four group-channel variants
  continue to carry status text only — credentials NEVER appear in
  group messages.
- `src/tunnel/TunnelManager.ts` — new `attachTelegram(adapter,
  dashboardPin)` method builds a notifier sink from a duck-typed
  `TunnelMessagingAdapter` (group → Dashboard topic with Lifeline
  fallback; owner DM → `sendToOwnerDM`) and a credentialProvider that
  returns `{ url: this.url, pin: dashboardPin() }`. Holds the notifier
  in a mutable field so callers can wire it AFTER tunnel construction
  (the messaging adapter is constructed later in server.ts).
- `src/commands/server.ts` — calls `tunnel.attachTelegram(telegram,
  () => liveConfig.get(...) || config.dashboardPin)` after the
  Dashboard topic is ensured. The wire is non-fatal: if attachTelegram
  throws, the catch around `ensureDashboardTopic` already swallows it.
- `tests/unit/tunnel-notifier.test.ts` — replaces the placeholder
  assertions with real-credential assertions: a DM with a credential
  provider contains the URL + PIN; a DM without a provider renders a
  graceful "link not available yet" placeholder; group messages NEVER
  contain credentials.
- `tests/unit/tunnel-manager-rewrite.test.ts` — 3 new tests for
  `attachTelegram`: Dashboard-topic routing, Lifeline fallback when
  Dashboard isn't ensured, owner-DM credential snapshot includes the
  live URL and current PIN.

**Under-block**: None. The owner-DM channel adds NEW capability;
existing behavior is unchanged when no `ownerUserId` is configured
(`sendToOwnerDM` logs a warning and returns null; the notifier's DM
sink call is a no-op). Existing Telegram group flows are untouched.

**Over-block**: None — but note the existing
`config.promptGate?.ownerId` continues to serve as a back-compat
fallback when `ownerUserId` isn't set explicitly. Operators who used
`promptGate.ownerId` to mark their session-prompt owner will see that
same user receiving the tunnel-DM messages, which is consistent with
the spec's "owner principal" intent. New deployments should set
`ownerUserId` explicitly.

**Level-of-abstraction fit**:
- TunnelManager remains the single owner of the lifecycle; the
  notifier sink is a thin pass-through to the messaging adapter.
- The `TunnelMessagingAdapter` duck-typed interface keeps the tunnel
  module from importing `TelegramAdapter` directly — preserves the
  layered architecture (tunnel does not depend on messaging type).
- Credential substitution happens in the notifier's composer methods.
  The notifier never holds credentials in its own state; it calls
  the provider at compose time so the credentials are always fresh.

**Signal vs authority**: Compliant. The credentialProvider returns a
SIGNAL (current URL + PIN); the notifier remains the AUTHORITY for
deciding when an owner-DM message goes out and what it says. The
sink is the routing layer (executes the send); the messaging adapter
is the platform layer. No new authority introduced at the wrong
layer.

**Interactions**:
- `TunnelManager` constructed in server.ts BEFORE telegram, so the
  manager initially has no notifier. The wire-up happens AFTER
  telegram + Dashboard topic are ready (one-shot call to
  `attachTelegram`). Until then, transitions go through the lifecycle
  but no user-facing messages fire — preserving the boot-time
  ordering established in PR 2.
- The credentialProvider closes over `this._legacyState.url` and
  the dashboardPin accessor; both are read at each compose, so a
  PIN rotation (PR 5) will be visible to subsequent messages without
  re-attaching.
- `sendToOwnerDM` failure modes are absorbed inside the adapter — the
  sink wrapper never throws into the notifier path. Preserves the
  fire-and-forget invariant.

**External surfaces**:
- New config field: `messaging.config.ownerUserId` (number). Optional.
  Falls back to `messaging.config.promptGate.ownerId`. Documented in
  the spec.
- No new API endpoint. No new CLI command.
- `TelegramAdapter.sendToOwnerDM(text)` is a new public method but
  intended for in-process callers only (the tunnel manager is the
  first caller; future PRs may add more).

**Migration parity**:
- No agent-installed file change in this PR. Existing agents pick up
  the new behavior the moment they update — the `ownerUserId` field
  remains optional with the documented fallback.
- A future PR in the chain (the ConfigDefaults / migration PR) will
  add a ConfigDefaults entry for `ownerUserId` and a CLAUDE.md
  template note so the agent surfaces the new capability
  conversationally. For now the manager's behavior degrades
  gracefully when the field is absent.

**Rollback cost**: Trivial. Revert four source files + the test
updates. The two new public methods (`getOwnerUserId`,
`sendToOwnerDM`, `attachTelegram`) become unused; the
`TunnelMessagingAdapter` interface becomes dead code. Nothing else
breaks.

**Tests**:
- 19/19 `tests/unit/tunnel-manager-rewrite.test.ts` (3 new for
  `attachTelegram`).
- 13/13 `tests/unit/tunnel-notifier.test.ts` (placeholder assertions
  replaced with credential assertions; 1 new "no-credential
  gracefully renders 'link not available'" test).
- 32/32 `tests/unit/tunnel-lifecycle.test.ts` (no change).
- 10/10 `tests/unit/tunnel-providers.test.ts` (no change).
- `tsc --noEmit` clean. `npm run lint` clean.

**Decision-point inventory**:
1. Owner principal modeled as `ownerUserId` separate from
   `authorizedUserIds` (vs. reusing the broader set) — the GPT
   external review specifically flagged that consent / credential
   exposure decisions must NOT trust the broader authorized-users
   set. A separate single-principal field is the structural fix.
2. `sendToOwnerDM` returns null on failure (vs. throwing) — preserves
   the fire-and-forget contract callers expect for outbound
   messaging. The bot can't initiate a DM until the user has messaged
   the bot first, so an early "forbidden" response is expected during
   onboarding; treating it as fatal would block tunnel notifications
   indefinitely.
3. `attachTelegram` is a post-construction method (vs. constructor
   parameter) — the messaging adapter is constructed later than the
   tunnel manager in server.ts. Putting the sink in the constructor
   would require restructuring boot order. The post-attach pattern
   keeps the existing boot sequence and is testable.
4. `TunnelMessagingAdapter` duck-typed interface (vs. direct
   `TelegramAdapter` import) — keeps the tunnel module from depending
   on the messaging layer's concrete types; future PRs can add Slack
   / iMessage variants without modifying tunnel/.
5. credentialProvider returns a snapshot (vs. holding the URL/PIN as
   notifier state) — the notifier composes messages over time; a
   stale PIN cached in notifier state would leak after rotation. The
   provider pattern keeps credential freshness in one place.
