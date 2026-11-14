# Side-effects review — the egress fold hold (outbound chokepoints)

**Version / slug:** `cb-fold-hold`
**Date:** 2026-11-10
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (Fable 5.2; see end)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §10 "Suppression carrier" (the fold hold: per-topic record keyed by (topic, foldId), independent of `monitoring.standDown`, never `dryRun`; primary check on the owner in `evaluateOutbound`, in `authorizeTelegramSessionSend` before the relay fork, and in the prepared-transport review; in-memory known-holds set rebuilt at boot; scoped fail direction under store faults), §9.3 (every carrier keyed by `foldId`, released only by the terminal transition), §14 "Probe/handoff suppression", maturation plan ("the fold hold refusing sends on Slack, app and single-machine topics"). Converged 6 rounds, approved 2026-11-09 17:22 PST. Phase 0 task 8, part a; stacked on slice 7 (FoldCoordinator).
**Tier:** 2 (a new refusal on the shared outbound funnel). Size: ~8 files, ~520 LOC incl. ~300 test LOC.

## Summary of the change

1. **`src/monitoring/FoldHoldStore.ts`** — the hold record `state/context-layers/<foldKey>/fold-hold.json` (0700/0600, atomic write): `write` (coordinator, at lock/prepare), `restamp` (lock renewal), `release` (only the named fold), `check` (the chokepoint verdict), `list`/`rebuild` (boot), `foldHoldCarrier` (so the coordinator's terminal transition and boot sweep release it). Verdict rules: no hold ⇒ allow; hold before its stamped expiry ⇒ refuse; past expiry ⇒ still refuse while its fold record is non-terminal or of unknown state, allow once provably terminal; store unreadable ⇒ refuse only if the last successful read for that conversation was held, while that fold's record is open, otherwise bounded by the lock TTL ceiling (30 min) from the first unreadable read; unreadable with no last-known hold ⇒ allow, audited `fold-hold-unreadable`. Every refusal and unreadable read is appended to `_fold-hold-audit.jsonl` (the per-fold refusal count, §10).
2. **`foldKeyForConversation(channel, conversation)`** — the channel-neutral key: a Telegram topic is its id (exactly the coordinator's `String(topicId)`, tested); any other conversation is `<channel>-<sha256 prefix>` of its NORMALISED identity (WhatsApp through `phoneToJid`, iMessage through `normalizeIdentifier`, so a phone and its JID or two spellings of one handle give one key; tested). A Slack hold is per channel (a thread fold holds the whole channel: over-holds, never under-holds). In Phase 0 the coordinator only folds Telegram topics (`hasRowSource`), so it writes no non-Telegram hold; the channel-neutral coordinator key arrives with the Phase 1 row writer. <!-- tracked: CMT-1536 (Phase 1: coordinator keys non-Telegram folds with foldKeyForConversation; agreement test per channel) -->
3. **Chokepoints (`src/server/routes.ts`)** — `foldHoldRefusal` runs FIRST in `evaluateOutbound` (every channel: Telegram by topic id, Slack/app/WhatsApp/iMessage by their conversation key) and FIRST in `authorizeTelegramSessionSend` (before the relay fork, so a send that would relay to the lease holder is held on the owner). The prepared-transport review already calls `evaluateOutbound`. Refusal: `409 { error: 'fold-hold', foldId, retryable: false }`.
4. **Recovery policy** — a redriven row refused `409 fold-hold` is retried at the normal backoff (it was a real reply queued before the fold; the relay never queues a refused live send), never escalated as a loss; bounded by MAX_ATTEMPTS like every retry.
5. **Wiring** — built at boot beside the FoldCoordinator, carrier registered BEFORE the boot sweep (a hold left by a crash is released with its record or as an orphan), known-holds rebuilt, passed through AgentServer to the routes; `FOLD_LOCK_TTL_CEILING_MS` (3× the base TTL) bounds a last-known hold.

**Phase 0 posture:** nothing writes a hold yet (the coordinator's step runner is Phase 2), so on every agent `check` finds no hold and every send is unchanged.

## Decision-point inventory

- **Added:** a deterministic refusal at the outbound funnel for a conversation under a fold hold. No judgment; fails toward containment only for a conversation with a known hold.

## 1. Over-block

- Every send for a held conversation is refused, including server-authored notices routed through `evaluateOutbound` (`messageKind: 'automated'`). Exempting by kind was rejected: a Slack client can set `metadata.messageKind`, so a probe turn could claim `automated`. In Phase 0 no hold exists; the Phase 2 runner must defer server notices for a held conversation rather than send them into the hold. <!-- tracked: CMT-1536 (Phase 2 runner defers server notices for a held conversation) -->
- A stale hold whose fold record is missing keeps refusing until the boot sweep releases it as an orphan carrier (containment wins over reachability for a conversation known to be mid-fold).

## 2. Under-block

- **A fold-turn send the relay QUEUED is not held.** `telegram-reply.sh` queues a send that got HTTP 000 or 5xx (server down mid-fold); after the boot sweep releases the hold, the delivery sentinel redrives it and it is delivered — and the `fold-hold → retry` branch lets a redrive during a hold wait it out. Unreachable in Phase 0 (no hold is ever written); Phase 2 must refuse rows first attempted inside a hold window before the runner writes any hold. <!-- tracked: CMT-1536 (Phase 2: relay/sentinel refuses rows first attempted inside a fold-hold window) -->
- On `/telegram/reply` the hold runs before the proxy and system-template branch, so those are held too; the other `refuseIfCredential` paths that bypass `evaluateOutbound` (attention items) carry no session-authored text, per §10's enumerated bypass list.
- iMessage's `validate-send` runs `evaluateOutbound` only when `text` is supplied; without it a token is issued and the send happens client-side (pre-existing). <!-- tracked: CMT-1536 (Phase 2: iMessage validate-send checks the fold hold without text) -->
- The relay-fork case (`telegram.willRelay() === true`, where only `authorizeTelegramSessionSend` stands) and the prepared-transport `review`/`authorizeDispatch` paths are not exercised by a test. <!-- tracked: CMT-1536 (Phase 0 task 11 verification suite: fold hold on the relay-fork and prepared-transport paths) -->
- The §10 watcher for sustained hold-store unreadability belongs to the sentinel (task 10); today an unreadable read and an expired hold with no readable record each file a DegradationReporter row. <!-- tracked: CMT-1536 (Phase 0 task 10: sentinel watches sustained fold-hold unreadability) -->
- Direct adapter calls (`telegram.sendToTopic` from internal deterministic senders) never pass the funnel; none is session-authored.
- The lease holder's defence-in-depth read of a REPLICATED hold is not built: holds are machine-local until the layer kind replicates them (slice 9). On a live pool no fold can begin (`owner-unknown`). <!-- tracked: CMT-1536 (Phase 0 task 9: replicated fold-hold kind; lease holder reads it) -->

## 3. Level-of-abstraction fit

The funnel is where every channel converges (`evaluateOutbound`) plus the one Telegram path that forks before it; the stand-down muzzle uses the same two places. The hold is a carrier of the fold record, not a parallel lifecycle.

## 4. Signal vs authority compliance

Blocking authority, but deterministic over a local record with no heuristic, scoped to a conversation with a known hold, and with a stated, bounded fail direction (§10). It never judges message content.

## 5. Interactions

- **Stand-down muzzle:** independent; the fold hold runs first, so a held conversation refuses `fold-hold` even where a stand-down entry exists.
- **Delivery-failure sentinel:** `fold-hold` is a retry, not `escalate` and not `finalize-standing-down`, so a pre-fold reply is neither dropped nor reported lost.
- **Relay script:** a refused (409) live send is terminal and not queued; a send that got 000/5xx IS queued and is the tracked under-block above.
- **FoldCoordinator:** the hold is listed and released by `foldId` with the other carriers.

- **Stale or malformed holds:** an expired hold whose record is missing or torn still refuses (containment) but reports `FoldHoldStore.check` to DegradationReporter on each refusal; a malformed hold file is offered to the boot sweep (fold id `_malformed`) and removed.

## 6. External surfaces

A new 409 body (`fold-hold`) on the reply routes, seen only by a session sending during a fold. No user-visible change in Phase 0.

## 7. Multi-machine posture

Machine-local by design in Phase 0: the hold is a local fact on the topic's owner, where the probe session's sends originate (§10 "primary check on the topic owner"). Replication for the lease holder's defence-in-depth read arrives with the layer kind (tracked above).

## 8. Rollback cost

Revert. State: none written in production (no hold is ever written in Phase 0); the audit file only appears once a refusal or unreadable read happens.

## Class-Closure Declaration

- `unbounded-self-action` — closure `n/a`: a check per send plus a once-per-boot rebuild; no timer, loop or retry of its own (the sentinel's retry of `fold-hold` is bounded by MAX_ATTEMPTS).

## Evidence

- `tests/unit/FoldHoldStore.test.ts` (14): no hold ⇒ allow; written hold refuses (0600/0700); per-topic isolation; release only by the named fold; stale hold sticky while the record is open or unknown, released once terminal; store unreadable with no last-known hold ⇒ allow + audit; unreadable after a held read ⇒ refuse while open, then bounded by the TTL ceiling; known-terminal ends a last-known hold at once; `rebuild()` restores the known set at boot; unsafe ids and a mislabelled hold file refused; the carrier lists and releases by fold; `foldKeyForConversation` (Telegram id, path-safe negative ids, hashed and channel-scoped other channels, no Slack/Telegram collision, refusals).
- `tests/unit/recovery-policy.test.ts` (+2): a redriven `409 fold-hold` retries at backoff; bounded at MAX_ATTEMPTS.
- `tests/integration/fold-hold-outbound-routes.test.ts` (5): real `createRoutes` over HTTP — Telegram reply refused 409 `fold-hold` with nothing sent and the refusal audited; another topic untouched; released hold ⇒ not refused; Slack reply refused by its channel-neutral key; a Slack hold never refuses the Telegram topic with the same digits.
- `tests/e2e/fold-hold-crash-lifecycle.test.ts` (3): a REAL child process begins a fold, writes the hold and dies mid-fold; a server-style boot (`buildFoldCoordinator` + `buildFoldHolds` + carrier before the sweep) then serves real HTTP: crash before the point of no return ⇒ hold released, reply not refused; past it ⇒ quarantined, reply refused 409 `fold-hold`, nothing sent. Plus the wiring check (server builds the hold, registers its carrier before the sweep, AgentServer passes it to the routes).
- 30 neighbouring unit files around the outbound funnel (outbound gates, dedup, advisory, credential wall, attention, delivery-failure sentinel, reply scripts) pass; `no-silent-fallbacks` at its 494 baseline; `tsc --noEmit` clean.

## Second-pass review

**Reviewer (independent subagent on Fable 5.2, 2026-11-10):** "Concern raised." BLOCKING: (1) a fold-turn send the relay queued on 000/5xx is redriven and delivered after the fold, and the comment/§5 claimed it could not be; (2) the non-Telegram key hashed the raw route parameter (WhatsApp phone vs JID, iMessage spellings), Slack threads were not addressed, and the coordinator does not use the key. MINOR: (3) the relay-fork and prepared-transport paths untested; (4) "not refused" tests did not prove a send went out; (5) an expired hold with a missing record refused silently; (6) a malformed hold was never cleaned up; (7) iMessage validate-send without text; (8) artifact/message inaccuracies and a comment inserted inside the stand-down rationale.

**Resolution:**
1. Tracked as a Phase 2 precondition (no hold is written in Phase 0) with the comment and §5 corrected.
2. Fixed: keys normalise WhatsApp and iMessage aliases (tests); the Telegram key is pinned equal to the coordinator's topic key (test); Slack per-channel over-hold stated; non-Telegram coordinator keying tracked to Phase 1.
3. Tracked to the verification suite.
4. Fixed — and it found a real gap in my own tests: with a bare route context the "not refused" reply was a 500 (no session manager stub), which the old assertions accepted. The tests now stub it and assert 200 and that the text reached `sendToTopic` (integration and e2e).
5. Fixed: reported via DegradationReporter on every such refusal (test).
6. Fixed: offered to the boot sweep and removed (test).
7. Tracked.
8. Fixed: claims corrected, "the sentinel watches this" removed from the degradation text, the fold-hold comment moved into its own block above the stand-down rationale.

**Reviewer re-check (same reviewer, after the fixes):** "Concern raised", one BLOCKING: (1) my new key normalisation called `phoneToJid`, which THROWS on a non-phone WhatsApp id; `foldHoldRefusal` runs on every send of every booted agent, so `POST /whatsapp/send/abc` would have become an unhandled rejection with no response — a live Phase-0 regression introduced by the fix. MINOR: (2) a stale "relay never queues it" claim remained in routes.ts; (3) a WhatsApp device-suffixed JID (`phone:3@…`) keyed separately; (4) the Telegram-agreement test pins a literal, not the boot wiring (negative ids diverge, covered by the Phase 1 tracking); (5) the stale-unresolved report fired on every refused send; (6) a malformed hold is released at boot even with an open fold on its topic (not a regression: a malformed hold gave no last-known hold before either).

**Resolution (this commit):** (1) `foldKeyForConversation` never throws — an id the normaliser rejects keys as its lower-cased raw form (tests for `abc` and `12`); (2) comment corrected; (3) the device part is stripped (test); (4) accepted as stated, the agreement for non-Telegram and negative ids is part of the tracked Phase 1 item; (5) reported once per fold per process (boot-wiring test: five refusals, one report); (6) accepted as stated.
