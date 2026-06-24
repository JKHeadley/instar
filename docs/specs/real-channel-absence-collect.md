---
title: Real-channel collectMessages — run the spurious-message absence proof over a live channel
slug: real-channel-absence-collect
eli16-overview: real-channel-absence-collect.eli16.md
status: draft
parent-principle: "Live-User-Channel Proof Before Done — a user-facing fix is not done until proven from the user's seat through the REAL channel. The absence assertion that guards the false-rate-limit fix could previously run only against a fake driver; this makes it executable over real Telegram/Slack so the proof is genuinely live, not simulated."
author: echo
created: 2026-06-24
review-convergence: "2026-06-24T22:13:53.304Z"
review-iterations: 3
review-completed-at: "2026-06-24T22:13:53.304Z"
review-report: "docs/specs/reports/real-channel-absence-collect-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 7
contested-then-cleared: 0
approved: true
approved-by: "echo (standing 8-hour autonomous-run pre-approval, 2026-06-24; design forks are mine to resolve)"
---

## Problem

PR #1262 added a `LiveTestHarness` ABSENCE assertion (`expect.noMessageMatching` over `absenceWindowMs`) and wired it into the ship gate, so a regression that reintroduces a spurious background message (e.g. the false "throttle should have cleared" nudge) is BLOCKED before deploy. But the production `RealChannelDriver` did NOT implement the optional `collectMessages` the absence assertion needs — so over a real Telegram/Slack channel the assertion was BLOCKED (driver-unsupported), and the proof could only run against a fake driver. The Live-User-Channel Proof standard wants it proven over the REAL channel.

## What this adds (additive, no production-runtime behavior change)

- **`SurfaceSender.collectMessages?(channelId, {windowMs, afterMessageId?})`** (optional) — collect EVERY agent-authored message after the marker within the window. Implemented on `TelegramLiveSender` (polls `getHistory`, agent-outbound only, deduped by messageId) and `SlackLiveSender` (polls `conversations.history`, agent bot-user only, deduped by ts). Polling across the window is load-bearing: a spurious nudge can land AFTER a legitimate reply, which a single read (`awaitReply`) would miss.
- **`RealChannelDriver.collectMessages(surface, channelId, opts)`** — delegates to the surface's sender. If that surface's sender has no `collectMessages`, it raises a typed `DriverCapabilityError`.
- **Harness mapping:** the absence path catches `DriverCapabilityError` → records **BLOCKED** (driver-unsupported on this surface), NOT FAIL. A real driver error remains a loud FAIL. This preserves the existing "unsupported → BLOCKED, never a false PASS" semantics now that `RealChannelDriver` always has the method.

## Absence-proof soundness (round-2 review hardening)

An ABSENCE proof's only failure direction that matters is the **false PASS** — reporting "no spurious message" when one existed. Multi-angle review surfaced four ways `collectMessages` could under-collect and silently false-PASS; all are closed structurally:

- **Truncation → BLOCKED, never PASS.** A history read is bounded (`HISTORY_LIMIT = 100`). Slack passes `oldest: after`, so a full page (or a `response_metadata.next_cursor`) means ≥100 messages exist AFTER the marker → genuinely truncated → `AbsenceUnverifiableError` → **BLOCKED**. Telegram's `getTopicHistory` returns the most-recent 100 of the topic's WHOLE lifetime (a tail, not marker-bounded), so a full page is truncation ONLY when its **oldest entry is still after the marker** (the marker scrolled off the page → post-marker messages may be unread). If the oldest in-page entry is ≤ the marker, the marker is in-page and the read is complete even on a long-lived demo topic with >100 lifetime messages — so a reused demo topic is not wrongly blocked. Either way the direction is safe: an unprovable read BLOCKS, never false-PASSes.
- **Edit-laundering → every version kept.** A messageId's text could be edited from the spurious nudge to benign text mid-window. The collector keeps ALL distinct text VERSIONS per id (`Map<id, Set<string>>`) and returns one entry per (id, version), so an edit cannot launder a nudge out — any version that ever matched is still matched.
- **Slack identity (`bot_id`) → matched.** A background nudge on Slack may be posted by the app with only a `bot_id` and no `user` field. Matching `user === agentBotUserId` alone would skip it (false PASS). The sender matches `user` OR an injected `agentBotId`. (Applied to `awaitReply` too, for parity.)
- **Failed read → BLOCKED.** Slack `ok === false` (auth revoked / not_in_channel) throws `AbsenceUnverifiableError` — an absence proof must never green over a read that returned nothing because it FAILED. (Symmetric with `send`'s existing `!ts` guard.)

Two safety + cost bounds: `windowMs` is clamped to `MAX_WINDOW_MS = 300_000` (caps real-API poll count), and an absence scenario reading a channel's whole history is **demo-only** — the harness's §5.3 pre-flight now refuses any `absenceWindowMs != null` scenario on a non-demo channel REGARDLESS of its `safe` tag (so a `safe` tag cannot make it poll a live operator channel's content into the harness/logs).

`absenceWindowMs: 0` is a deterministic SINGLE read (used by unit tests with scripted history); a real live-drive run must pass a realistic window ≥ the throttle-resume cadence or the polling advantage is nil — enforced at the future live-drive route, noted here.

**Known limits (honest scope of the proof).** This proves the absence of an *observable, durable* message in the channel's history. A message that is **deleted** before any poll observes it, or a Slack **ephemeral** message (never in `conversations.history`), is outside what a history-poll can see — the proof does not claim to catch those classes (they are not the spurious-nudge class this guards: the throttle nudge is a durable agent post). Ordering/inclusion is by **platform order after the marker** (Telegram `messageId`, Slack `ts`), not wall-clock; the harness/runner and the platform share no synchronized clock, so `windowMs` bounds POLL DURATION, not a delivery-time interval — a message is included iff it is observed in history strictly after the marker during the polling window. These are inherent to a history-polling proof; a send-tap/event-stream corroborator is the future upgrade if an ephemeral/auto-deleted nudge class ever appears.

## Decision points

- **Collect agent-authored messages only** (not user-inbound). The class the absence assertion guards against is a spurious message the AGENT sends; `awaitReply` already filters to agent-outbound, so `collectMessages` is consistent. The prompt is excluded by `afterMessageId`; a hypothetical user message in the window is not "a background message the agent sent".
- **No responder-machine attribution per collected message.** The absence check reads TEXT only; resolving the responder machine per message would cost one placement read each for zero benefit. Returned as `ReplyResult` with `responderMachineId` undefined.
- **DriverCapabilityError → BLOCKED, not FAIL.** An absence assertion the driver genuinely cannot make on a surface is unverifiable (BLOCKED), not a failure. Only a real send/read error is a FAIL. `DriverCapabilityError` is raised ONLY by the capability layer (`RealChannelDriver`, missing method); senders raise `AbsenceUnverifiableError` for an incomplete/failed read; both map to BLOCKED, while a plain `Error` stays a FAIL — so a real transport bug is never silently downgraded.
- **Polling, not streaming.** Collection polls the existing history readers (`getTopicHistory`, `conversations.history`) the harness already uses for `awaitReply`, rather than opening a streaming socket. Rationale: consistency with the existing driver architecture and zero new transport/credential surface; the windows are short and bounded, so poll volume is small. Streaming is a possible future optimization, not needed for the capability.

## Signal vs authority

Every element is test-harness infrastructure or a bounded no-op. `collectMessages` is read-only history polling; `DriverCapabilityError` is a typed signal the harness maps to a verdict. Nothing here holds blocking authority over a user or changes any production runtime path — it only makes the existing prevention proof executable over the real channel.

## Out of scope (future)

- A dedicated live-drive HTTP route (`/live-test/rate-limit-false-positive`) that runs this over the real demo channels on demand — additive polish, not required for the capability.
- The user-SIDE autonomous drive (a logged-in Telegram-web account via the Playwright profile registry, or an MTProto userbot) — Telegram's bot-can't-see-bot limit means a fully-autonomous user sender needs a real user/userbot. The deterministic gate is what blocks the regression; the live drive is corroboration when a real user/userbot is available.

## Frontloaded Decisions

- **D1 — collect agent-authored only.** Matches `awaitReply` semantics and the bug class. *Cheap-to-change-after:* the filter is one line per sender.
- **D2 — DriverCapabilityError → BLOCKED.** Preserves the spec's "unsupported → BLOCKED" intent for real drivers. Reversible: the mapping is one catch clause.
- **D3 — Slack collect included alongside Telegram.** The senders are mirror-shaped; doing both keeps surface parity rather than leaving Slack a latent gap.
- **D4 — Truncated/paginated/failed read → BLOCKED (AbsenceUnverifiableError), never PASS.** Completeness is the whole value of an absence proof; an unprovable read must block, not green. The Telegram check is marker-bounded (a full page is truncation only when its oldest entry is still after the marker — so a reused demo topic isn't wrongly blocked); Slack is `oldest`-bounded natively. *Cheap-to-change-after:* the guard is a per-poll page-bound check; this is test-harness infra behind no published interface and ships nothing dark/irreversible.
- **D5 — Keep all text versions per id (anti edit-laundering).** *Cheap-to-change-after:* the `seen` map type + the flatMap return; internal to the collector.
- **D6 — Slack agent identity = user id OR injected bot_id.** Closes the false-PASS where a background nudge carries only `bot_id`. *Cheap-to-change-after:* additive optional dep; unset → byte-identical prior behavior.
- **D7 — Absence scenarios are demo-channel-only (§5.3), even when tagged `safe`.** A whole-history read must never touch a live operator channel. *Cheap-to-change-after:* one predicate in the existing pre-flight; internal harness behavior.
- **D8 — `windowMs` clamped to 300s.** Caps real-API poll count. *Cheap-to-change-after:* one constant.

## Open questions

*(none)*
