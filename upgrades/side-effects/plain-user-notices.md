# Side-Effects Review — Plain and Complete server notices

**Version / slug:** `plain-user-notices`
**Date:** `2026-11-03`
**Author:** `Echo`
**Tier:** 1 (a revert fully undoes it: wording, a test-time check, a build-time lint; no state, no migration of data)
**Second-pass reviewer:** see the end of this file

## Summary of the change

Justin (2026-11-03, topic 10000001507) flagged the forced-close move notice: `This conversation moved machines mid-task (drain bound (30000ms) reached — final turn may be partial). Work resumes on the new machine — the final turn before the move may be partial.` It pasted `SessionDrainRunner`'s internal reason in raw, said the same thing twice and did not name the machine. He asked for a standard covering every message.

1. **The notice.** `SessionDrainRunnerDeps.notifyInterrupted` drops its `detail` argument, so no reason text can cross that seam; the bound now goes in the `drain-completed-interrupted` audit row as `drainBoundMs`. The server wiring looks up the target's nickname (`meshIdMgr.getActiveMachines()`) and sends `movedMachinesMidStepNotice()`: "I moved this conversation to the Mac Studio before I'd finished my last step, so that step may be incomplete. The conversation carries on there. If that step matters, ask me to check it." Nothing reads `interrupted_mid_task` on the resuming side (`git grep` finds only the writer), so the notice does not promise a check. An id or missing name reads "another machine" (Rule 7). **Still sent when the session announced the move itself**: that note is optional and written before the cut, so this is the only record that the step was cut off.
2. **Restart notices.** `🔄 Session restarting — message queued.` → `SESSION_RESTARTING_NOTICE`. `respawnSessionForTopic` takes a new `quietAfterRespawn` option. The two callers that already told the person a restart is under way for their message set it: the dead-session path ("restarting" notice) and the context-exhausted path ("conversation got too long"). The reply then confirms the restart, and a second note would be lifecycle narration (Near-Silent Notifications). Every other caller, including the queue-drain respawn and the SessionRefresh respawner, whose waiting text may be an internal prompt, still confirms once with `SESSION_BACK_NOTICE`, which is true for all of them.
3. **Pinned-profile note** → `PROFILE_REAPPLY_NOTICE` (the `[#seq]` stamp is kept: it defeats the relay's duplicate window).
4. **Mechanism.** `src/messaging/userNotices.ts` (catalog), `src/messaging/plainNoticeCheck.ts` (deterministic check, test-time only), `src/data/plain-notice-terms.json` (one term list for the check and the lint), `scripts/lint-plain-user-notices.mjs` + frozen baseline (in `npm run lint`).
5. **Standard.** Rule 8 in `docs/UX-AND-AGENT-AGENCY-STANDARD.md`, plus one bullet in the generated CLAUDE.md's Agent-as-Interface block (a core heading, regenerated on every update by the reference layout, so existing agents get it).

Choice of rewrites was measured, not guessed: automation-provenance rows in Echo's `telegram-messages.jsonl`, 2026-10-30 → 11-03. Heavier 30-day offenders (background-shutdown, passkey health) had already gone quiet after earlier fixes; the sibling-owned SessionMonitor/PresenceProxy texts (topics 10000001496, 10000001309) were left alone. The rest are tracked as fb-d1c2f259-243.

## Decision-point inventory

- `isSystemOrProxyMessage` — modify — reads the catalog's exact texts and prefixes instead of its own literals; old wordings kept.
- Post-respawn notice — modify — suppressed only for the two callers that announced the restart first (`quietAfterRespawn`).
- Build gate — add — `lint-plain-user-notices` (dev-time ratchet, no runtime authority), registered in `REQUIRED_LINTS` (`tests/unit/lint-chain-completeness.test.ts`) so a merge cannot drop it.

**unbounded-self-action: n/a.** No self-triggered action is added or changed. Every respawn and notify call site keeps its trigger; the change rewords existing notices and suppresses one post-respawn notice for two callers.

## 1. Over-block

The lint can flag a legitimate interpolation named `reason`/`detail` that already holds plain text. The waiver `@plain-notice-ok: <why>` covers it, and the baseline grandfathers today's 12 hits. The test-time check could flag a catalog wording that is fine ("null" as an English word); the term list is small and deliberate. Nothing at runtime can be blocked.

## 2. Under-block

The lint only sees text built inline at a send call; text built in a variable elsewhere is missed (stated in the script header). The catalog covers only notices moved into it. The too-vague side has only a word floor; "enough information" beyond that is review judgment. Most of the 75 server.ts send lines build text elsewhere, so coverage grows as notices move into the catalog (fb-d1c2f259-243).

The per-file count ratchet lets a fixed hit be swapped for a new one in the same file. That is a known limit of the pattern, and lowering the baseline (`--update`) after each fix closes the room. Text returned as a command reply, not sent through a send call (`/route` and `/local-model` replies still say "Session respawned."; `topicProfileWriteSurface.ts`), is not seen by the lint. Those are listed for the follow-up.

## 3. Level-of-abstraction fit

The send path is the wrong place: these are deterministic alarms that must not wait on a model (*The Operator Channel Is Sacred*). Build/test time is the right layer for fixed strings. The tone gate stays the authority for session-written text; this does not parallel it.

## 4. Signal vs authority compliance

`findPlainNoticeProblems` is a brittle signal used only in tests. The lint is a dev-time ratchet with a waiver and a baseline, the same pattern as `lint-no-direct-destructive` and `lint-no-wholefile-sync-read`. Neither holds runtime authority over any message. Compliant with `docs/signal-vs-authority.md`.

## 5. Interactions

- `isSystemOrProxyMessage` feeds CompactionSentinel recovery, the PresenceProxy race guard and PromiseBeacon. If a reworded notice were missed, it would count as an agent reply and could suppress a recovery. Covered: the classifier reads the catalog and the test asserts every new and legacy wording. The moved-machines notice is now also classified as a system message (before, it counted as a reply), which is the correct reading.
- Sibling branches touch PresenceProxy, SessionMonitor and SlackAdapter; this change touches none of their lines.
- `TopicProfileOrchestrator` tests matched the old wording; updated.

## 6. External surfaces

User-visible wording changes in four notices, and one notice is no longer sent. Every agent gets these on update. No API, config or state shape changes; `notifyInterrupted` is an internal seam with one implementation.

## 7. Multi-machine posture

The move notice runs on the source machine (the drain owner) and names the target from the mesh identity registry, which is replicated to every machine, so there is no machine-local assumption. A missing nickname reads "another machine". The notice is sent once by the one drain owner (one voice). The catalog and lint are code, so no state is involved.

## 8. Rollback cost

Revert the commit. No data, config or migration to undo.

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, Opus 5.5), given the diff and this artifact with no conclusions.

Not required by Phase 5's list in the strict sense (no block/allow decision on messaging), but the classifier and the dropped post-respawn notice touch session-lifecycle messaging, so an independent reviewer subagent read the diff and this artifact.

**Result: concur, with four findings, all addressed.**
1. *Two respawn callers passing a message had no prior notice* (the queue-drain respawn, and the SessionRefresh respawner, where the waiting text can be an internal prompt that never gets a reply). The first version silenced the post-respawn note for any caller with a message. Fixed: the `quietAfterRespawn` option is set only by the two callers that announce first, and every other caller still confirms.
2. *The lint missed `${err instanceof Error ? err.message : String(err)}` and `${(err as Error).message}`*, the most common forms. Fixed: any expression reading an error's message or stringifying an error is flagged, case-insensitively. A test case was added, and the baseline was re-frozen at 12.
3. *The count ratchet allows swaps within a file.* Accepted as a known limit and stated under Under-block.
4. *Old wording remains in command replies* not visible to the lint. Listed for the follow-up.
The reviewer confirmed the classifier change is correct (the moved-machines notice previously counted as a reply), `meshIdMgr` is in scope at the wiring point, and the term file resolves in a published package (`src/data` is in `files`).
