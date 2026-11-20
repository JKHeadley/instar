# Side-Effects Review — dashboard names, not IDs (2026-11-20 live audit)

**Version / slug:** `console-names-not-ids-audit-2026-11-20`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1 (small, reversible), 18 files (~150 changed lines incl. tests). These fixes come from a live audit of every console page at 1280x728 and 390x844 (topic 127504, the dashboard-makeover project). Console: `work-model.js` (Needs-you work rows cut at a word boundary up to 140 chars instead of a raw `.slice(0, 80)`; `machineWords` for behind/changed-on notes), `work.js`, `documents.js` (topic name instead of "Telegram topic N"), `notifications.js` (notice text through the existing `plainReferenceText` with pool topic and machine names; full text kept on hover), `display-identity.js` (drop the doubled "(name unresolved)"), `costs.js` + `usage-model.js` + `usage.js` (machine nicknames in the machine comparison AND the "Where the tokens went" breakdown rows and breadcrumbs, conversation names there too; no "Conversation <id>" fallback — the breakdown was caught by a pre-merge re-audit of all five branches combined), `needs-strip.js` (badge "12+" instead of "12+?"). Server: `routes.ts` adds `machineName` (pool nickname) to the work-board `behind` answer; `workBoardViews.ts` carries `mayHaveChangedOnName`. Telegram: `TelegramAdapter.learnTopicNameFromSent` reads `reply_to_message.forum_topic_created.name` from each successful `sendMessage` answer and calls the existing `captureTopicName(id, name, false)` only when no name is known. Effort: one build pass, no spec review rounds (Tier 1), first commit attempt.

## Decision-point inventory

No decision-point surface. Nothing is gated, blocked, filtered or routed differently. The adapter change only fills a display-name cache through the existing capture rule, which never replaces a known name except on a rename event.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Coverage limits: a topic whose name is unknown stays unnamed until the agent sends into it, or the operator posts or renames it. A name learned from a send is the creation name; if the topic was renamed earlier and the rename event was lost, the creation name shows until the next rename. That is the same limit the inbound path (`msg.reply_to_message.forum_topic_created.name`) already has, and it is better than "Conversation name unavailable".

---

## 3. Level-of-abstraction fit

Right layer. Display wording lives in the console models that already own it, and they reuse the existing `verifiedDisplayName` and `plainReferenceText` helpers instead of adding new ID filters. The machine nickname is attached server-side, where the pool registry lives (`ctx.machinePoolRegistry.getCapacity(id).nickname`, the same lookup the placement route uses). Name learning sits in `apiCall`, the one funnel every Telegram API answer returns through, and delegates to the existing `captureTopicName`.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority is added or changed. This is display text plus a name cache.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point. The 140-character cut is a display bound, not a judgment.

---

## 5. Interactions

- `captureTopicName` saves the topic registry (`saveRegistry`) once per newly learned name. Repeated sends to a named topic return early (`getTopicName` is non-null) and write nothing, so there is no write storm.
- `learnTopicNameFromSent` runs after the egress door and the quiet-receipt check, only on a real Telegram result. It is wrapped in try/catch, so a malformed answer can never fail a send that already succeeded.
- The rename handler (`topicRenamedHandler`) fires only on true renames; the learn call passes `isEditEvent=false`, so it never fires it.
- The work-board `behind` object gains an optional field. Older consoles ignore it, and newer consoles talking to older servers fall back to "another of your machines".
- Documents, Notifications and Costs each add one pool read (`/telegram/topics?scope=pool`, `/pool`) that the console already makes elsewhere. A failure there only means the plain fallback words.

---

## 6. External surfaces

User-visible wording on five console pages and the Needs-you badge. There's no new route, config key or outbound message. The Telegram change sends nothing new.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes, unchanged. The Needs-you rows now keep the action words ("needs your OK") that the cut used to drop.
2. **Zero raw internals as primary content?** This change is that fix: machine IDs (Work board notes, Costs), topic IDs (Documents, Notifications), hex refs and `(name unresolved)` (Notifications) are replaced by names or plain words. Raw notice text stays available only on hover.
3. **Destructive actions de-emphasized?** No destructive action touched.
4. **Plain language + phone width?** Yes. The audit ran at 390x844 and 1280x728 with no horizontal scroll on any page. The re-audit after release is part of the same run.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- Topic names: the learned name is written to this machine's topic registry, the same machine-local store as every other capture path. Other machines read it through the existing pool-merged `/telegram/topics?scope=pool`, which every changed console page uses. Proxied-on-read, no new replication.
- Machine nicknames: read from the pool registry, which is already replicated. The console pages read `/pool`.
- Work-board `behind`: machine-local by design (it describes this machine's lag behind a peer).

**Status surfaces:** none added or changed.

---

## 8. Rollback cost

Revert the commit. Names learned meanwhile stay in the registry and are correct; nothing needs cleaning up.

---

## Conclusion

A safe, reversible wording fix that meets the makeover's names-not-IDs goal on the pages the audit flagged, plus a free self-heal for lost conversation names. No gate is touched.

## Second-pass review (if required)

Not required: no outbound or inbound block/allow, no session lifecycle, no gate, sentinel or watchdog.

## Evidence pointers

- `tests/unit/console-work-model.test.ts`: needRowTitle whole-word cut; behind/changed-on notes use the nickname and never print `m_…`.
- `tests/unit/console-documents.test.ts`: topic name or "A Telegram conversation", never the topic id.
- `tests/unit/console-live-check-fixes.test.ts`: notice text drops topic/machine ids and the doubled "(name unresolved)".
- `tests/unit/console-usage.test.ts`: machine row without a name never shows its id.
- `tests/unit/console-front-doors.test.ts`: "2+"/"0+" badge.
- `tests/unit/topic-names-through-lifeline.test.ts`: name learned from a sent message; a known name is never replaced; malformed answers learn nothing; wiring pinned in `apiCall`.
- Full console suite: 78 files / 1558 tests green; `tsc --noEmit` clean.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
