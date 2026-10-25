# Side-Effects Review — Attention hub signal filter

**Version / slug:** `attention-hub-signal`
**Date:** `2026-10-23`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Operator report (2026-10-23): the "🔔 Attention" Telegram topic is "basically useless due to all the noise" (52,303 messages; ~560 in the last week, mostly passkey-health upserts, worktree scans and machine-coherence episode lines). This change adds one admission policy (`src/messaging/attentionHubPolicy.ts`) applied at every path that posts into the hub: `TelegramAdapter.routeToAttentionHub` (all attention items in single-topic mode, incl. upserts), server.ts `notify()` when the hub is the destination (worktree monitor, quota, system review, degradation, reap fallback, …) plus the one direct `notificationBatcher.enqueue` (codex observer), and the two follow-up senders that post onto an item's topic (`machineCoherenceEffectsExecutor` append/resolve, `ropeSinkRouter` dedupe count). Hub posts are also shortened (title + body). CLAUDE.md template + migration updated. Tier 1 (reversible by config `attentionHubFilter: "all"` or revert). Size: 9 files changed, ~300 LOC incl. tests. Effort: no spec rounds (Tier 1), one review round (two defects found and fixed).

## Decision-point inventory

- `routeToAttentionHub` admission — add — withhold the Telegram post of non-admitted items (item still stored).
- `notify()` hub admission — add — withhold hub/Slack-attention notices whose category carries no user impact.
- coherence/rope follow-up lines — modify — skip when the parent item is withheld.
- upsert repost throttle — add — repost same item id at most once per 6 h unless priority rises.

---

## 1. Over-block

Items that need the user but come from an automated source not on the allow-list are withheld from Telegram. Concrete cases considered: `stale-owner-release` "your call: demote or wait" (HIGH) — withheld; its design is fail-closed (waiting is safe), and the agent can still raise it itself. `machine-coherence` escalations with a "reply fix it" prompt — withheld; the episode is self-healing infra and the agent can act on it. `permission-prompt-auto-resolver` "session wedged" — withheld. `telegram-origin` held-reply/browser-paused items — withheld; recovery is automatic and a held session reply already produces a fixed notice in the user's own topic. `system-review` readiness messages (e.g. "no auth token set — reply fix auth") — withheld. Quota SUMMARY ("weekly quota at N%") withheld; only IMMEDIATE (exhausted/critical) passes. All withheld items remain in GET /attention and the dashboard, and are listed in `logs/attention-hub-held.jsonl`. Any new source that needs the user can set `needsUser: true` or raise at URGENT.

## 2. Under-block

Agent-raised items (`source: "agent"`) always pass, so a job that posts routine status via POST /attention with `source: agent` still reaches the topic; mitigated by the new CLAUDE.md guidance. `feedback-triage:action-list` posts daily even when its content is FYI. Notices sent with an explicit non-hub topic id are untouched (by design — they go to the user's conversation). Deliberate exception: `CrossPlatformAlerts.alertOnTelegram` (WhatsApp channel health, low volume) still posts straight to the hub — a channel the user relies on being down is user impact.

## 3. Level-of-abstraction fit

Placed at the delivery chokepoints rather than in each of ~60 callers, so every current and future source is covered (Structure > Willpower). Per-source fixes (making passkey-health stop upserting) would leave the class open.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface on agent actions or user messages.

It is a routing decision for automated notices, not a block: nothing is dropped, every item is still stored, visible on the dashboard and API, and logged. The deterministic part is an allow-list over *source identity* (an enumerable domain: which internal producer raised it), not a content heuristic. The judgment path stays open: the agent (the smart authority) can always raise anything via `source: "agent"` and it passes.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point: the rule keys on producer identity and priority (enumerable), and the agent's own judgment bypasses it.

---

## 5. Interactions

- Shadowing: runs after the agent-health lane branch (lane items unaffected) and only in single-topic/hubOnly routing; per-item legacy mode unaffected. The notify() gate runs before the NotificationBatcher, so batcher rate limits/quiet hours still apply to admitted notices.
- Double-fire: none; held items return `null` topic, so callers that later append to `item.topicId` see none. Pre-existing items with a stored topicId are covered by `attentionHubAdmits()` recomputation.
- The machine-coherence `resolve` still closes item status (tested). Upsert `resolveAttention` paths go through `routeToAttentionHub` and are filtered the same way.
- Slack attention channel: the same notify() gate applies (was mirrored there).

## 6. External surfaces

Telegram: far fewer posts in the Attention topic; post format changes (no category/priority/source line). Slack attention channel: same reduction. Persistent state: new optional `hubHeld`/`needsUser` fields on attention items (additive), new append-only log `logs/attention-hub-held.jsonl` (one short line per withheld post). Operator-facing actions: none added.

## 6b. Operator-surface quality

No dashboard/approval-page file touched — not applicable. (Telegram post text is simplified to title + body.)

## 7. Multi-machine posture

Machine-local by design: each machine filters its own posts with the same deterministic policy, so every machine's hub behavior is identical; the held log is per-machine observability. No new user-facing notice is emitted (fewer, never more), no durable state strands on transfer, no URLs generated.

## 8. Rollback cost

Config flip `messaging[].config.attentionHubFilter: "all"` restores old behavior at next server start (adapter) — no release needed; or revert the commit. Additive optional fields need no cleanup.

## Conclusion

Clear to ship. The review led to two design additions: recomputing admission for follow-ups (so pre-existing items stop posting "back/healed" lines) and keeping the agent-raised path open so the filter never removes the agent's own judgment.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent
**Independent read of the artifact: concern → resolved**

- Reap fallback (`fallbackNotify`, category `session-reap`) was withheld while still reporting delivered — broke "every affected conversation is told". Fixed: `session-reap` admitted (interrupted user work is user impact); test added.
- Repost throttle hid a reopened item (new episode) and was recorded before the send, so a failed post blocked retries for 6 h. Fixed: reopening clears the throttle entry; the post time is recorded only after a successful send; two tests added.
- `CrossPlatformAlerts` direct hub send — recorded above as a deliberate exception.
- `POST /attention` with no `source` is treated as automated — the CLAUDE.md bullet now says `source: "agent"` is required.
- Reviewer confirmed: signal-vs-authority argument holds; migration idempotent and correctly escaped; follow-up recomputation correct.

## Evidence pointers

- Hub topic 48154 first-line counts 2026-10-16→23 (see release note Evidence).
- Targeted tests: 5 files, 59 tests pass.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect.

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `n/a` (negative declaration)
- **`reason`** — Adds no self-triggered action: the change only withholds posts the existing notify/attention paths already make (it can reduce, never increase, notify volume); the one new timing rule is a repost throttle that only suppresses.

## Integration / e2e follow-up

The full integration and e2e runs found three routing tests that assumed every alert posts to the hub. These tests check the single-hub topology, not filtering. The two items meant as "real escalations" are now marked agent-raised (`sourceContext: 'agent'`) or `needsUser: true`. The no-config fleet e2e now asserts the new default: only URGENT items post, all posts share the one hub, and held items stay in the store with no topic. Files changed: tests/integration/agent-health-lane.test.ts, tests/integration/notification-flood-burst-invariant.test.ts, tests/e2e/attention-topic-flood-guard-lifecycle.test.ts.
