# Side-Effects Review — Pinned messages in conversations

**Version / slug:** `conversation-pinned-messages`
**Date:** `2026-11-09`
**Author:** `echo`
**Second-pass reviewer:** `independent review subagent (spec review, 12 findings, all addressed in the spec and code before build)`

## Summary of the change

Conversations the iPhone app and the dashboard show (app conversations, Telegram topics, Slack conversations) gain multiple pinned messages, newest first, like Telegram. A pin is a new `pin` event kind in the app conversation store (`src/core/AppConversationStore.ts`: validator, `pins` index table, `pinRecord`/`pinState`/`pinCount`/`listPins`), so it replicates with the existing `appConversations` kind. Shared helpers live in `src/core/ConversationPins.ts`; routes in `src/server/mobilePinRoutes.ts` (GET/POST `…/pins` for app, Telegram and Slack), mounted in `AgentServer`. Pins ride on the three history reads (`mobileConversationRoutes.ts`, `routes.ts` Telegram messages, `mobileSlackRoutes.ts`) and the app events feed shows a `pin` event only when its message is held and readable. Telegram: `TelegramAdapter.pinTopicMessage` (pinChatMessage/unpinChatMessage, quiet), the `pinned_message` service message handed to the server (`onTopicMessagePinned`), a lifeline forward (`pinOnly` on `/internal/telegram-forward`, `handleForwardedPin`), unauthorized pins ignored quietly, `unpinChatMessage` added to the egress door's id-only list. Slack: `SlackAdapter.unpinMessage`, bridge `pin`. Access: device allowlist, browser routes, team tiers (guest read, member write) and exact `teamConversationTarget` mappings (POST = send, GET = read). Dashboard: pinned bar, All pins sheet, per-message menu (`chats.js`, `chats-model.js`, `console.css`). Off switch `mobilePairing.native.pins.enabled` (default on). Agent awareness: CapabilityIndex sentence and a CLAUDE.md line with a content-sniffed migration.

Tier 2 (touches a replicated store and the device access gate). Size: about 20 files, ~900 added lines including tests. Effort: one spec review round (12 findings, all folded in), one build pass.

## Decision-point inventory

- `teamConversationTarget` / `DEVICE_ALLOWLIST` / `TEAM_ROUTE_TIERS` / `BROWSER_ROUTES` — modify (add rows) — new routes declared with the existing access model; pin = `send`, list = `read`.
- Pin route handlers — add — deterministic input validation and the shared `deviceMayUse(…, op)` check; a write is device-only.
- TelegramAdapter update processing — modify — a `pinned_message` service message is handed over (authorized) or ignored (unauthorized) instead of falling through.
- `/internal/telegram-forward` — modify — a `pinOnly` body is accepted only from a lifeline-proven sender and answered without reaching the inbound pipeline.
- No block/allow decision on messages, sessions or delivery is added or changed.

---

## 1. Over-block

- A message from an app conversation that has not replicated to the answering machine yet cannot be pinned there (`404 unknown-message`); the dashboard shows the refusal and a retry on another poll works once it arrives. Acceptable: app conversations replicate within seconds.
- A Telegram pin from a standby machine answers `409 not-serving`, the same as a Telegram send from it.
- Pins by an anonymous Telegram admin are ignored (Telegram hides the person).

## 2. Under-block

- An unpin made inside Telegram is not seen (Telegram sends nothing); stated in the spec, release note and CLAUDE.md line.
- Pins made inside Slack are not read back.
- A machine on an older version drops pin events and never gets them back (precedent: `platform-media`, `transcript`).

## 3. Level-of-abstraction fit

Pins are conversation state, so they live in the conversation store that already replicates and already holds platform keys; no new store, no new replication kind. Access reuses the one shared check. The mirror is a best-effort side effect at the route, never the source of truth.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The only refusals are deterministic input/access checks on a write the person asked for (the same shape as every existing send/rename route). No brittle detector gains authority over messages or sessions.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The reduction (latest event wins) is an invariant needed for convergence; the access check is the existing one.

## 5. Interactions

- **Shadowing:** the Telegram pin route is registered with a digits-only topic id and calls `next()` otherwise; `/mobile/chat/:topicId` (send) has two segments and never matches `/pins`. Slack and app pin routes have distinct prefixes.
- **Double-fire:** our own `pinChatMessage` produces a service message to other clients, but Telegram does not deliver a bot's own actions to it; even if one arrived, `applyPin` writes nothing when the message is already pinned. A lifeline-forwarded pin and an adapter-seen pin cannot both happen (only one polls).
- **Races:** two machines pinning/unpinning the same app message concurrently converge by the (at, machineId, eventId) order; a writer stamps `at` after the current winner, so a slow clock cannot make a newer choice lose locally.
- **Feedback loops:** none; pins do not touch unread counts, activity, previews or delivery state (unit-tested).
- **Unread service / events feed:** the unread walk reads the `messages` table only; the events feed gained an explicit `pin` branch (held + readable only).

## 6. External surfaces

- **Telegram:** pins/unpins in the real topic when the operator pins from the app/dashboard (quiet, no notification). Needs the bot's pin right; refusal is reported, not fatal.
- **Slack:** pins.add/pins.remove when the bot has `pins:write`; refusal reported.
- **Persistent state:** new `pin` events in `app-conversations/*.jsonl` and a derived `pins` index table (created with `IF NOT EXISTS`).
- **Other agents/users:** none beyond the operator's own conversations.
- **Operator surface (Mobile-Complete):** every action (pin, unpin, view) is a tap in the dashboard and an app route; nothing needs a terminal.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes: the pinned bar sits directly under the conversation title; tapping it jumps to the message. Pinning is one tap on a message's "⋯" then "Pin".
2. **Zero raw internals?** Yes: the bar and list show the message text, "Pinned by <name>", "in Telegram", a short time. No ids, hashes or enums.
3. **Destructive actions de-emphasized?** Unpin is a quiet button beside each row in the All pins sheet, never above the primary content; the bar itself has no destructive control.
4. **Plain language + phone width?** Labels are "Pinned", "1 of 3", "All pins", "Pin", "Unpin"; refusals are full sentences ("Telegram did not let the agent pin this message. The pin is kept in the app."). The bar is one line with ellipsis and 44 px tap targets, `min-width: 0` so it never forces horizontal scroll at 390 px; verified in the jsdom page test and the CSS review.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated** through the `appConversations` replicated-store kind (pin events are app conversation events). Every machine reduces identically. Writes follow existing placement: app conversations anywhere; Telegram only on the machine serving Telegram; Slack only on the machine holding the conversation (Slack previews are built there at read time and never stored, so Slack text does not spread). No user-facing notices; no URLs; durable state never strands (it is on every machine). **Status surfaces:** none added or changed.

## 8. Rollback cost

`mobilePairing.native.pins.enabled: false` (live) hides pins and refuses writes. A code revert leaves inert `pin` events in the files (an older version refuses them at validation; an index rebuild logs one report per line). No migration. Platform pins made by the mirror stay pinned in Telegram/Slack until removed there.

## Conclusion

The independent review found three real holes (guest/read-grant could have pinned through an unmapped team target; a token could have written; lifeline-polling agents would never see Telegram pins) plus clock, index-rebuild, Slack-preview-spread and wording issues; all were fixed in the spec and the code before commit, with tests for each. Clear to ship.

## Second-pass review (if required)

**Reviewer:** independent review subagent (general-purpose, read-only, given the code not the conclusion)
**Independent read of the artifact: concur after fixes**

The reviewer's 12 findings were each addressed: exact team mappings (unit test), device-only writes (integration test), lifeline `pinOnly` forward, strict UTC `at` + max-after-winner stamping (unit test), write-side read checks and app-conversation membership (integration test), Slack previews at read time (integration test), `KNOWN` fields (unit test), index rebuild clears `pins` (unit test), anonymous/unauthorized pins ignored quietly, server time for Telegram pins, Slack `already_pinned`/`no_pin` as done, older-machine loss stated, the iPhone app screens stated as built in the app codebase against this contract (no iOS build from this change).

## Evidence pointers

- `tests/unit/conversation-pins.test.ts` — validator, reduction in every order, rebuild, not-a-message, cap, clock, wire round-trip, helpers, team mappings.
- `tests/integration/conversation-pins.test.ts` — app/Telegram/Slack routes over the real device-signed pipeline.
- `tests/e2e/conversation-pins-alive.test.ts` — production AgentServer boot: pin is 200, listed, on history, token-readable.
- `tests/unit/console-chats-model.test.ts`, `tests/unit/console-chats-page.test.ts` — dashboard bar, menu, list, signed pin call.
