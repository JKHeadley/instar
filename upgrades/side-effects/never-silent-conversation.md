# Side-Effects Review — Never-Silent Conversation (first version)

**Version / slug:** `never-silent-conversation`
**Date:** `2026-11-14`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2 (spec `docs/specs/never-silent-conversation.md`, converged in 6 rounds and approved; Justin answered its last open question on 2026-11-14 13:39 PST). Every inbound Telegram/Slack conversation message becomes a durable obligation (`src/monitoring/neverSilent/NeverSilentStore.ts`). An overdue sweep (`NeverSilentWatcher.ts`, every 15 s) finds each one still unanswered after `noticeAfterSeconds` (120), asks a judge that never runs on the stuck engine (`ConversationSilenceJudge.ts`: Jev, then a Codex or Claude referee on a different account), maps the verdict through a fixed table (`NeverSilentPolicy.ts`) and sends a fixed-template notice through a new internal producer that the quiet gate always delivers (`never-silent-notice` category). With actions on, an expired login moves the conversation to another account or engine and re-delivers the waiting message with a "say why it is late" line; a conversation whose engine the operator chose gets one notice with one "Move to …" button instead. Also: Codex sessions start with the agent's launch folder recorded as trusted (`ensureCodexProjectTrusted.ts`), and a judged login failure goes through the existing pool funnel so a signed-out account stops showing "active". Read surface `GET /never-silent/incidents`. Dev-gated (`monitoring.neverSilent.enabled`); `actions` and `frameworkFallback` default false. About 1,000 lines of source across 21 files plus 6 test files. Effort: 6 spec review rounds (before this session), 1 commit attempt so far.

## Decision-point inventory

- `Is this inbound message still owed an answer?` — add — obligation state from logged rows (agent row answers; standby lines, lifecycle notices and Instar's own notices do not).
- `Why is it silent?` — add — ConversationSilenceJudge (LLM, closed class enum; `undetermined` is the conservative default).
- `What may be done about it?` — add — deterministic table behind floors (confidence floor, truncated input caps at tell, per-action switches, replay boundary, pinned ⇒ ask, breaker).
- `Is a never-silent notice held quiet?` — modify — NotificationSelectivityGate: new `never-silent-floor` deliver rule for the internal `never-silent-notice` category when it names its inbound message.
- `Pool account status` — pass-through — a judged `engine-login` at or above the floor calls the existing `QuotaPoller.observeCliLoginExpired` (its own corroboration rules unchanged).
- `Codex launch` — modify — append-only trust entry for the agent's own launch folder before an interactive Codex spawn.

---

## 1. Over-block

No block/allow surface on messages: nothing is refused, held or rewritten. The only new "decision" with a user-visible effect is sending a notice. Possible extra notice: a genuinely slow session that took more than two minutes and produced no standby line gets one "not answered yet, still working" line — the same consequence the standby tier already has. An agent that replies only through a path that does not log a row (none known) would be noticed falsely; every reply route logs.

## 2. Under-block

- "Answered" is any delivered agent message after the inbound, so "on it" followed by a dead session closes the obligation (chosen over a wording list, which would send false notices on short real answers). The existing standby/stall paths still watch that case.
- Moves and the ask are Telegram-only; Slack conversations get notices only. App conversations are not tracked in this version. <!-- tracked: CMT-1781 -->
- Actions are off by default, so on the fleet the first version tells but does not repair. That is deliberate until the judge is measured (§3.7). <!-- tracked: CMT-1781 -->

## 3. Level-of-abstraction fit

The judge is the authority for the silence class; the old wording classifiers are passed to it as labelled hints only (Justin 2026-11-13 10:40: no string arrays). Actions reuse the existing funnels (pool observation, quota-aware swap, topic-profile store, the same respawn path as `/route`) rather than adding new ones. Telling uses Instar's deterministic origin path, not the stuck session or any LLM.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

The only authority added (moving a conversation) is held by the LLM judge's verdict inside deterministic floors that can only refuse (confidence, truncation, replay boundary, pin, breaker, switches). The brittle detectors (elapsed time, wording classifiers) only open judgment or feed it hints; elapsed time alone never authorizes an action. The selectivity-gate rule is structural (internal producer + named inbound id), not text-based.

## 4b. Judgment-point check (Judgment Within Floors standard)

The notice deadline (120 s) is a static timer, but it only decides *when to look and tell*, never what to do; it is the PresenceProxy tier-2 point already tuned for "a person is waiting" and is a live config value. The class→action table is enumerable over a closed class set and declared in spec §7 with floors and an arbiter. No new static heuristic decides a competing-signals question.

## 5. Interactions

- PresenceProxy: a delivered standby (🔭) line counts as the waiting notice, so the person is not told twice. PresenceProxy is unchanged.
- CMT-1008 InteractiveLoginExpiredRecovery and UsageWallRescue may also react to the same session. This version serializes per conversation inside the watcher; the shared cross-producer lease is Phase 2 (§3.3). <!-- tracked: CMT-1781 --> A same-engine swap goes through the same `onQuotaPressure` funnel with its in-flight gate, so two producers cannot both swap.
- Topic profile: the move writes `system:never-silent` with `shiftPrevious`, so the operator's undo still works; restore only happens if the profile still carries that principal.
- Telegram callback dispatch: new `ns:` prefix, owner-only, ahead of `rs:`; no existing prefix overlaps.
- `sendToTopicDelivered` gains an optional `inlineButtons`; absent ⇒ byte-identical params.

## 6. External surfaces

User-visible: new notices in conversations (fixed wording, no internal terms), and one inline button on the pinned ask. Engine moves restart a conversation's session (the same restart a `/route` switch does). Judge calls send scrubbed, e-mail-masked screen text to Jev (TypeSafe) or a Codex/Claude account the agent already uses; never the stuck one. New route `GET /never-silent/incidents` (auth-gated; never serves the waiting text). New CLAUDE.md section reaches existing agents through `migrateClaudeMd` and Codex/Gemini shadows.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer, approval page or grant form is touched. The one operator-facing control is the Telegram button: one tap, says what it does ("Move to Codex"), answers the tap with a plain line, is idempotent and owner-only.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Obligations, incidents and judging: machine-local by design — they are recorded from the rows the owning machine's adapter logs, and that machine runs the sweep. On topic transfer the new owner records new messages itself. Known edge: an obligation opened on the old owner just before a transfer stays open there and that machine may send one waiting notice for it; the new owner's reply is not seen there. That is one extra line, never silence. <!-- tracked: CMT-1781 -->
- Notices: one-voice — sent only by the machine whose adapter logged the inbound row (the owner).
- `/never-silent/incidents`: this machine's view; no pool merge in this version.
- Pool status change goes through the existing pool funnel, which already replicates.
- **Status surfaces:** `GET /never-silent/incidents` (new). No change to `/health` or `/capabilities` beyond the CapabilityIndex entry.

## 8. Rollback cost

Config: `monitoring.neverSilent.enabled: false` (live) stops everything; byte-identical behaviour with it off. Code revert is clean: one JSON state file (`state/never-silent.json`) and one log (`logs/never-silent.jsonl`) are left behind and inert. A move already applied leaves a `system:never-silent` framework pin, undone with the existing topic-profile clear/undo. The Codex trust entries are harmless to keep. No data migration.

## Engine-neutral by construction (2.0 Rule 30)

The first push added 17 framework-id literals and failed the framework-name ratchet. Engine specifics now live behind two adapter-tree tables in `src/providers/adapters/engineSessionHooks.ts` (`PROJECT_TRUST_SEEDERS` for the Codex folder trust, `ENGINE_LOGIN_READERS` for Claude Code's `auth status`), display names live in `FRAMEWORK_DISPLAY_NAMES` in `src/core/frameworkFacts.ts`, and the referee and the fallback engine are chosen from whichever engines the account pool has signed-in accounts for (`refereeFor(framework)` builds one provider per engine). The never-silent code adds no framework-id literals; the ratchet reads the baseline count unchanged.

## Local Verify rounds

- Head 74391f71b7: failed in 56 s on the framework-name ratchet (main's own regression from PR 3147, fixed by PR 3182, plus 17 literals of this change; see the section above).
- Head 29ac333096: unit lane 67,078 passed, 4 failed. Three were this change and are fixed: the route file was missing from the discoverability test's mounted-router list; the judge's attribution label was unregistered (now `sentinel` in `componentCategories`, with an `LLM-ROUTING-REGISTRY.md` row); the `monitoring.neverSilent` ConfigDefaults block shifted the dark-gate lint's hand-authored line map, and the block is removed because every key defaults in code and `enabled` is dev-gated. The fourth, `tests/unit/telegram-origin/store-worker-recovery.test.ts`, passes locally and this change does not touch it.

## Conclusion

Ship dark on the fleet, live on development agents with actions off; the live proof turns actions on only on a throwaway agent. Actions graduate per class after the judge measurement (CMT-1781).

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, fresh context), three rounds on 2026-11-14
**Independent read of the artifact: concur** (round 3)

Round 1 raised nine defects; all were fixed before commit: move-back needed proof of a working login (`loginCheck: ok`) and a 6-hour flap guard; the move back keeps who chose the engine; a failed restart undoes the move and nothing is written without a session; Slack keyed so a reply can be matched; judge calls back off (60 s doubling to 10 min); the whole judge input is scrubbed; "still working" wording for slow sessions; protected sessions never move and the sweep and a tap share one lock per conversation; the Codex trust write skips any folder already mentioned. Round 2 raised three: Slack threads (now top-level Slack messages only, Slack never gets a button), the move back applies at the next restart (the notice says so) and restores a pin under a `system:never-silent:restored-pin:` label instead of the operator's name, and a tap answers at once and moves in the background. Round 3 raised one more (a queued tap could move a conversation that answered meanwhile; fixed with a test) and one known limit (a Slack reply in another thread can count as the answer; recorded in §5a, tracked CMT-1781). Final reply: "Concur with the review".

## Evidence pointers

- Live proof 2026-11-14 on a throwaway agent (`/private/tmp/ns-proof-agent`, port 4071) in a real Telegram test group with the spare test bot; one Claude pool account pointed at an empty (signed-out) home while still "active", one signed-in Codex account. Unpinned topic: judged `engine-login` 0.99/1.0 by the Codex referee, moved to Codex automatically with one notice, and Codex answered both waiting messages: "Late because the Claude sign-in ran out. A2: 12 + 30 = 42. A3: 9 × 9 = 81." Pinned topic: one notice with a "Move to Codex" button, nothing moved; the tap answered "Moving this conversation to Codex. It will answer here shortly." and Codex replied "Late because the Claude sign-in ran out. Mars." Transcripts: `.instar/lanes/never-silent-tg/evidence-A.txt`, `evidence-B.txt`; log `logs/never-silent.jsonl` on the throwaway. Found during the proof and fixed: resumed scrollback was read as "actions since the message" (judge now told to judge after the last prompt). Found and filed (not this change): a tier-1 standby line falsely said a reply was sent (feedback fb-139dfa00-f1f).
- The pool rule did not move the rig's account to needs-reauth: `observeCliLoginExpired` marks only when the stored credential reads, and the rig's empty home has none (Inspec's expired credential does read). The watcher now logs the pool's answer as `pool-observed`.

- Unit: `tests/unit/neverSilent-{policy,watcher,judge,floors}.test.ts` (52 tests), `tests/unit/notification-selectivity.test.ts` (never-silent floor), registry tests.
- Integration: `tests/integration/never-silent-routes.test.ts`. E2E: `tests/e2e/never-silent-alive.test.ts`.
- Incident: Inspec 2026-11-13, spec §1; Phase 0 result in spec §5.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action` (this change adds a self-triggered controller: the never-silent sweep can swap an account, restart a conversation on another engine and send notices on its own).
- **`closure`** — `guard`.
- **`guardEvidence`** — enforcement `ratchet`, citation `tests/unit/self-action-convergence.test.ts`, controller `never-silent-conversation-recovery` in `src/testing/selfActionRegistry.ts`. How caught: under a conversation that never answers while every account looks healthy and every move succeeds, the real `decideNeverSilentAction` plus the per-incident `swapTried` flag, the `triedFrameworks` breaker and per-revision notice dedupe settle at one swap, one engine move and at most three notices; moving back needs an idle conversation and a passing sign-in check; judge calls back off from 60 s doubling to 10 minutes.
