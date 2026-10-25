# Side-Effects Review — Worktree notices on change; automated sends skip intent extraction

**Version / slug:** `worktree-monitor-dedupe`
**Date:** `2026-09-30`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Two small changes, both driven by offline measurements on 29 Sep traffic
(docs/research/jev/field-notes/2026-09-30-idea1-intent-skip.md and
2026-09-30-idea4-notification-tiering.md, in the agent home). (1)
`src/monitoring/WorktreeMonitor.ts`: each notice kind (`session` = post-session
unmerged/orphan notice, `stale` = periodic stale-worktree notice) keeps a
fingerprint of the item set it last announced, persisted in
`state/worktree-monitor/announced.json`. A notice is sent only when the set
differs, or when `reminderIntervalMs` (default 24h) has passed. An empty set
clears the fingerprint, and a failed send is not recorded. (2)
`src/core/TopicIntentCapture.ts`: `captureTurn` returns `skipped-automation`
for `provenance === 'automation'` before any LLM call, counted under
`prefilter_skipped`. `src/commands/server.ts` forwards `entry.provenance` from
`onMessageLogged` into the loop. `src/scaffold/templates.ts` and
`src/core/PostUpdateMigrator.ts` add a short "Worktree Notices" CLAUDE.md
section (template, add-if-absent migration, and framework-shadow marker).

## Decision-point inventory

- `WorktreeMonitor.onSessionComplete` / `periodicScan`: whether to send a notice — **modify**. It was "any finding → send". It is now "finding set changed, or 24h since last announcement → send".
- `captureTurn` pre-filter: whether a turn reaches the extractor LLM — **modify**. It adds a structural skip for `automation` provenance.
- `migrateClaudeMd`: whether to add the section — **add**. It is content-sniffed on the heading.

---

## 1. Over-block

- Worktree: a finding whose *details* change while the branch set does not (for example, more commits on the same unmerged branch) is not re-announced until the daily reminder. This is intentional. The branch was already flagged, and commit-count churn was part of the spam.
- Intent: an automated message that carries a real decision (the idea-1 note found a few, such as "framework switch deferred until the build is idle") is no longer extracted directly. Mitigation: TopicSummarizer builds the rolling summary from every message regardless of provenance (`getMessagesSinceSummary` has no provenance filter), and that summary is passed to the next conversational extraction as context. Justin's own messages are stamped `user` and are never skipped.

---

## 2. Under-block

- A set that flaps (a branch that keeps being created and deleted) re-announces on each change. That is correct, since each flap is a real change, but it is not rate-limited beyond that.
- Automated sends that reach the log without a provenance stamp (legacy rows, any path that does not stamp) are still extracted. This fails open on purpose.
- Other LLM consumers of the same messages (Usher, ArcCheck) are unchanged. They are outside this change.

---

## 3. Level-of-abstraction fit

The dedupe sits at the source, the monitor that decides to speak, rather than in NotificationBatcher, because only the monitor knows the item set. The intent skip uses the existing structural provenance authority, stamped at the send seam (`/telegram/reply` derives it from messageKind/isSystemTemplate/proxy, and `sendToTopic` defaults to `automation`), rather than re-deriving automation from text.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Neither change blocks a user or agent action. The monitor chooses whether to emit its own informational notice. The capture loop chooses whether to spend an LLM call on a best-effort background extraction, and it was already fail-open and never on the delivery path.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Has the flagged set changed since the last announcement" is an enumerable set comparison. "Is this message automation-provenance" reads an existing structural stamp and does not weigh competing live signals.

---

## 5. Interactions

- **Shadowing:** the provenance skip runs before `isSubstantiveTurn`. Both skips count as `prefilter_skipped`, and the new status `skipped-automation` distinguishes them for callers. User turns still bump the turn counter first, because the provenance check comes after `bumpTurn`, and automation is never `fromUser`.
- **Double-fire:** the post-session and periodic notices keep separate fingerprints, as they did before. The dedupe cannot suppress one because of the other.
- **Races:** `onSessionComplete` and `periodicScan` can overlap. The worst case is one duplicate notice in the overlap window: both see "due" before either records. The state write is synchronous and last-writer-wins, and both write the same fingerprint.
- **Feedback loops:** this removes one. Worktree notices fed the extractor, which filed "unmerged branches" facts into the intent store on every notice.

---

## 6. External surfaces

- Telegram: far fewer worktree notices in the attention/system topic (replay of 29 Sep notices: 549 → 11).
- Persistent state: a new small file `state/worktree-monitor/announced.json`, holding at most two entries.
- CLAUDE.md: a new "Worktree Notices" section for new and existing agents, plus the Codex/Gemini shadow marker.
- Operator surface: no operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** The worktree monitor scans the local git checkout. Worktrees are per-machine filesystem state, so the announced-set memory belongs with the scan that produced it. Two machines with different worktrees correctly announce their own findings. This change does not alter the existing notice routing, including one-voice gating. It only reduces how often the notice fires. The intent skip is a pure function of each logged row, so its behaviour is identical on every machine.

---

## 8. Rollback cost

Pure code change. Revert and ship a patch. `announced.json` is ignored by older code and harmless to leave. After rollback, the old behaviour (a notice every session) returns immediately. The CLAUDE.md section would stay on migrated agents but describes behaviour that would no longer hold. A rollback should drop it with a follow-up migration.

---

## Conclusion

Both changes are deterministic and reduce volume. They were measured on real 29 Sep data before building. The review added two design points: a failed send is not recorded (otherwise one Telegram outage would suppress the finding for a day), and an empty set clears the fingerprint (so a finding that resolves and later returns is announced). Clear to ship.

---

## Second-pass review (if required)

Not required (Tier 1).

---

## Evidence pointers

- Unit: `tests/unit/worktree-monitor.test.ts` (announce on change only: 8 cases), `tests/unit/TopicIntentCapture.test.ts` (automation skipped; agent/user/unstamped captured), `tests/unit/PostUpdateMigrator-worktreeNotices.test.ts`.
- Integration: `tests/integration/worktree-monitor-announce-routes.test.ts`, `tests/integration/topic-intent-capture-automation-skip.test.ts`.
- E2E: `tests/e2e/worktree-monitor-announce-lifecycle.test.ts` (10 sessions → 1 notice; restart; changed set), `tests/e2e/topic-intent-capture-lifecycle.test.ts`.
- Wrong-side proof: with the new logic disabled, all new integration/e2e assertions fail (8 failures).
- Real-shape replay (read-only, live telegram-messages.jsonl, 29 Sep): 743 rows → 130 extractor calls; automation skipped (e.g. ids 115564, 115575, 115608), agent captured (115622, 115667), user captured (115774, 115822).

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`**: `unbounded-self-action`
- **`closure`**: `n/a`
- **Reason**: this change adds a settling brake to an existing self-triggered notify. It does not add a new action. Under a sustained, unchanged finding, the notice rate falls from one per session or scan (unbounded; 549 a day observed) to at most one per `reminderIntervalMs` (24h) per notice kind. A change in the set re-arms it once. `tests/e2e/worktree-monitor-announce-lifecycle.test.ts` proves 10 sessions → 1 notice.
