# Side-Effects Review — compact Needs-you line; project-title fallback for unnamed conversations

**Version / slug:** `needs-compact-and-name-fallback`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1 (display only). This answers Justin's 2026-11-20 iPhone screenshots, relayed by the Chief of Staff (handoff e810ee7c). (a) `dashboard/console/needs-strip.js`: the strip is now closed by default as one line (`compactLine(m)`: tone dot, "Needs you · N" or "N+", the first need's title on one line, a chevron). Opening it shows the existing full list, paging and could-not-check line, plus a "Hide" control. The open/closed state is remembered per tab, and `mountNeedsStrip({ open })` can set the starting state. The badge reads "N+" instead of "N+?" (an identical hunk is in #3546). The design matches the Instar app's build-120 line, agreed with the app rebuild session (topic 145973). (b) The new `src/server/conversationFallbackTitle.ts` provides `projectTitlesByTopic` and `topicDisplayName`. `AgentServer.ts` uses them for the app conversation list and conversation search: a Telegram topic with no verified name shows its Chief of Staff project title. `routes.ts` `GET /telegram/topics?scope=pool` adds a separate `fallbacks: [{topicId,title,source:'project'}]` for unresolved topics. `dashboard/console/topic-names.js` reads `fallbacks` and never lets one replace a verified name. One build pass, first commit attempt.

## Decision-point inventory

No decision-point surface. Display and name lookup only; no gate, no write.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Coverage: an unnamed topic that isn't a Chief of Staff project still has no name (the app chooses its own words for that case). Those heal as the agent speaks in them (#3546) or as the outage repair run restores names.

---

## 3. Level-of-abstraction fit

Right layer. The fallback is server-side, where every reader (app list, search, dashboard) gets it, through one helper. The strip's closed form is in the shared strip module the console already uses, and the app mirrors the same model.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority involved.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No decision point.

---

## 5. Interactions

- The fallback title is never written to the topic registry, so `captureTopicName` (including #3546's learn-from-send) still fills the real name, and the real name then wins.
- `fallbacks` is a new field; older consoles ignore it. `topics` still holds only verified names, so verified-name consumers are unaffected.
- The project title comes from `projectsSummary()`, which is in memory with no I/O. It is computed per list read; a failure means no fallback.
- The strip's `open: true` in tests keeps the paging tests exercising the open list; the new tests cover the closed default.

---

## 6. External surfaces

Dashboard layout of the Needs-you strip. The `title` of unnamed Telegram rows in `GET /mobile/conversations` and search. A new `fallbacks` field on the pool topic list.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The page's own content now starts right under a one-line strip, and the first need is readable in that line.
2. **Zero raw internals as primary content?** Yes. Unnamed conversations show a project title instead of a placeholder.
3. **Destructive actions de-emphasized?** Not touched.
4. **Plain language + phone width?** Verified at 390x844 and 1280x728: one 44px line, ellipsis for the first title, no horizontal scroll.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Project titles come from the Chief of Staff record, which already replicates to every machine. The pool topic list adds fallbacks after the pool merge on the reading machine. The strip's open state is per browser tab.

**Status surfaces:** none.

---

## 8. Rollback cost

Revert the commit. Nothing is stored.

---

## Conclusion

A safe display fix for both of Justin's complaints.

## Second-pass review (if required)

Not required.

## Evidence pointers

- `tests/unit/conversation-fallback-title.test.ts`: helper, console fallbacks, AgentServer/routes wiring.
- `tests/integration/telegram-issue-topics-route.test.ts`: the pool route returns `fallbacks` for an unresolved project topic, apart from `topics`.
- `tests/unit/console-needs-pages.test.ts`: closed line words, open/hide, loading/failed/zero cases; paging tests run open.
- Console unit suite 78 files / 1557 green; typecheck clean. Screenshots at 390x844 and 1280x728 through a proxy serving this branch.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
