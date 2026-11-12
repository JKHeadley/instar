# Side-Effects Review — a standby without the Telegram login keeps a reply when the holder is unreachable

**Version / slug:** `standby-durable-forward-without-token`
**Date:** `2026-11-11`
**Author:** `Echo`
**Spec:** `docs/specs/standby-durable-forward-without-token.md` (6 review rounds plus one verification round; see the convergence report; r7 cut down after the overlap with native-conversation-base, removals only)
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

On 2026-11-11 the M5 lost two replies at 05:04Z and about 20:23Z. The M5 is a standby with no bot token. While the Studio (the lease holder) was unreachable, the M5 took the direct relay (`relayOriginBot`). That path fails at its first `capabilities` read before anything is prepared, and still answered `409 held` with "do not resend", even though nothing was held anywhere.

**Cut down on 2026-11-11 (r7).** This change overlapped the native-conversation-base effort (topic 141876, PRs #3086 and #3092). With Justin's approval it now carries only the piece no other work covers: a token-less machine holds and retries a reply instead of dropping it. The old §3 (overtaken-review interplay, `forwardedHeld` stamp, cross-machine skew), §6 (`not-sent` outcome and script wording) and §7 (outcome-route chain walk) were removed and their code reverted to main: native-conversation-base slice 3a removes the overtaken review, and slice 3b owns outcome reporting. PR #3082 is closed in favour of 3a. This change must land after, or together with, slice 3a.

This change does four things:

1. **§1–2: token-less machines take the durable forward**, behind the dev-gated `telegramOrigin.tokenlessDurableForward.enabled`. Each attempt reads the holder's `capabilities` first and seals with the live account. If the holder is unreachable, the reply is sealed with the existing `unresolved-tokenless-source` placeholder and held durably. Recovery re-seals a placeholder row to the live account through the existing single-transaction supersede, under a deterministic id `<root>~r<hop>-<plan8>`. A concrete seal that no longer matches the holder's bot is never re-sealed: it is retained, and an attention item is raised.
2. **§4: a `self` lease on a token-less machine never becomes a local send.** At request time the reply is held. In recovery the row is retained without the `local-sent` marker.
3. **§8–9: lost-reply bookkeeping.** Recovery follows supersede chains to the delivered copy. Notice-class sends are never held, and a hub post that found the holder unreachable is re-posted when the holder answers. The custody line says the reply is kept on this machine only. Reachable peers record metadata-only debt, which closes only on the origin's report or the owner's gone record.
4. **§10: rollout evidence.** The holder records the standby's evidence (a command-level `forwardContext`) in `logs/feature-evidence.jsonl`, and a `feature-ladders.json` entry graduates the gate.

Tier 2: about 20 source and test files and roughly 900 lines. The spec took 6 review rounds plus 1 verification round. ⚠ That is heavy relative to the core fix (save the reply instead of dropping it). Most of the growth answers multi-machine, maturation and observability standards, plus edge cases in the existing held-reply review.

## Decision-point inventory

- **Outbound route on a token-less machine** (durable forward vs direct relay): a new branch, gated, deterministic.
- **Recovery** (`recoverForwardedHold`): three new branches. A self route with no transport retains. A placeholder seal is re-sealed to the live account. A concrete seal that differs from the live account is retained and reported.
- **Outbound branch:** notice-class sends bypass the durable forward.
- **Reply route body:** unchanged except the optional `custody` field on a token-less hold.

## 1. Over-block

Until native-conversation-base slice 3a lands, the overtaken review on main can still retire a reply this change held, if a newer message reached the topic; that is why this change lands after 3a. A concrete-account mismatch holds the reply until the deadline instead of sending it. That is intentional (§2): resending under another bot is irreversible.

## 2. Under-block

- A standby lost for good during a partition that also cuts it off from every peer loses its held rows. No machine can be told; this is a named risk in §9, and today's behavior is the same loss with no record.
- The idle evidence check runs every 60 s only while something is owed.
- Within one 5 s tick, a probe failure is memoised per holder, so one dead holder costs one timeout per tick.

## 3. Level-of-abstraction fit

The change reuses the existing durable forward, ladder, supersede, receipt reconciliation and expiry rather than adding a queue. The new pieces sit where their facts live:

- the account comes from the holder's own answer;
- evidence goes where the ladder review runs.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md`. There is no new blocking authority, and no LLM in the loop:

- The seal is a routing hint. The holder still refuses any account that is not its own (`origin-plan-invalid`) before taking custody.
- `forwardContext` and the debt notes are signals that never change how a command is handled.
- The concrete-mismatch retain removes authority: the holder's answer can no longer cause a send under another bot.

## 4b. Judgment-point check

The rollout graduation is a judgment-candidate with a floor and an arbiter (the recurring maturation review). Everything else is deterministic on recorded facts.

## 5. Interactions

- **native-conversation-base slice 3a (prerequisite):** removes the overtaken review, so a held reply is never cancelled by a newer message. Both changes edit the supersede path in `recoverForwardedHold`; whichever lands second rebases.
- **native-conversation-base slice 3b (PR #3092):** owns the outcome route and the caller-facing wording of a relay failure. This change leaves both as on main.
- **Machines with a token:** behavior is unchanged. No probe runs, no new arguments are passed (the existing `telegram-origin-forward-on-standby` tests pass unchanged), and `self` still sends locally.
- **The adapter's `holderForwardPolicy`** is ignored on token-less adapters (`TelegramAdapter` ~913), so wiring it is inert there.
- **Attention hub posts** now carry `kindMetadata.noticeClass`. The holder's gate receives it across the relay hop; unknown keys are ignored.

## 6. External surfaces

New user-visible strings:

- the script's custody line;
- the `account-changed` attention item.

New status field: `peerHeldDebt`. New state files under `.instar/state/`: the evidence outbox, the seen ids, the debt store and the notified ledger.

New wire fields, all ignored by old versions:

- `forwardContext` on mesh `capabilities` and `submit`;
- `tokenlessHold` on `evidence`;
- `evidenceAck` and `outcomesAck` on answers;
- `custody` on the 409 body.

The script template hash is updated, and the prior hash is registered for `migrateScripts`.

## 6b. Operator-Surface Quality

No dashboard JS changes. The new attention item and the `peerHeldDebt` list use existing surfaces. The item copy is plain: "Held replies sealed for bot A are waiting: the sending machine now uses bot B. They expire unless the original bot returns."

## 7. Multi-machine posture

- **Held rows:** machine-local on the authoring standby (existing posture). They are re-forwarded to whichever machine holds the lease.
- **Account id:** proxied-on-read (live `capabilities`), with no cache.
- **Debt:** replicated as metadata-only notes to reachable peers.
- **Evidence:** carried to the holder.

Mixed versions are covered in the spec table:

- a new standby with an old holder works, with no evidence recorded;
- an old standby with a new holder behaves as today.

## 8. Rollback cost

The gentle back-out is to turn the gate dark. Recovery stays wired, so held rows drain. Do the full revert only once `GET /telegram/origins/status` shows zero token-less held rows. The new state files are inert on older builds. No migration.

## Evidence pointers

- `tests/unit/telegram-origin/tokenless-durable-forward.test.ts` (28 tests) covers:
  - the healthy-pool single read;
  - an outage hold with the placeholder (the 2026-11-11 loss);
  - a `self` lease that is never sent locally;
  - placeholder re-seal under a derived id;
  - a concrete-account change retained and reported;
  - a holder change that keeps the concrete seal;
  - a lease flap delivering once;
  - `relayNothingPrepared` on relay pre-prepare failures (reporting only);
  - the recovery chain walk (two hops, missing, cycle);
  - the notice-class set and the reachable hook.
- `tests/unit/telegram-origin/tokenless-forward-evidence.test.ts`: the outbox, the sanitizer cap and the recorder's dedupe.
- `tests/unit/telegram-origin/tokenless-held-debt.test.ts`: debt lifecycle, origin-only closure, gone closure, the ledger, and the mesh `capabilities` outcomes and acks.
- `tests/integration/telegram-origin-tokenless-forward.test.ts`: over the REAL signed mesh and real origin stores. A token-less standby holds a reply with the placeholder seal while the holder refuses connections, then re-seals it to the live account (`123`) under `<root>~r1-<plan8>` and delivers it exactly once when the holder answers. The first id resolves through the chain to an accepted row. On a healthy pool, it is delivered on the first attempt with no hold.
- `tests/unit/telegram-reply-held-outcome.test.ts`: the script's custody line.
- r7 cut-down re-run: see the PR body for the counts after the removals.
- Full unit suite before the cut (2026-11-11 14:14 PST): 3590 test files passed. Two ratchets failed because of this change, and both are now fixed:
  - `no-silent-fallbacks`: the deliberate fallbacks are now marked.
  - `topic-ref-ratchet`: the attention item now uses `topicRef`.
  
  Three desktop files (`MacDesktopHostCapture`, `MacDesktopHostIdentity`, `desktop-displays`) fail with `SourceTreeGuardError` because of this worktree's location. They fail identically on an unrelated branch's worktree, so they are environmental, not this change.
- Wider runs: unit `telegram origin devGated PostUpdateMigrator attention` 3382 passed / 1 skipped (375 files); integration `telegram origin` 297 passed / 5 skipped (47 files); `tsc --noEmit` clean.
- Ladder: the `MaturationLadder` and `feature-ladders-coverage` tests pass with the new entry.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent, 2026-11-11
**Independent read of the artifact: concur (after one iteration)**

**First pass: concern raised.** There was one real defect and two minor issues:

1. A `not-sent` attention hub post returned the row as if it had been delivered, so callers such as the JobScheduler promotion catch-up and the job-coverage alert stopped retrying.
2. `repostPendingHubPosts` had no in-flight guard.
3. `resealed` counted any `~r` id, so it also counted holder-change supersedes.

**Fixes.** The `not-sent` post is still recorded for re-post, and the error is now rethrown. A `repostingHubPosts` guard with try/finally makes sure only one re-post runs at a time. `resealed` now comes only from `onResealed` when a placeholder seal was replaced. The id set is capped at 500.

**Second pass: concur.** One leftover is accepted. The re-seal id set lives in memory, so a re-sealed copy that is first submitted after a restart is not counted toward the evidence metric. That can only lower the count. It never affects delivery.

**Verified in the first pass:**
- The outcome-unknown receipt check still runs before any route, probe or re-seal.
- Successor ids are stable, so a retried supersede reuses the same id.
- A concrete seal is never re-sealed, and a placeholder successor is refused.
- Every new branch is gated on `tokenless` / `!hasUsableBotToken`.
- `forwardContext` changes no answer or authority.
- The debt note is written only for the sender's own records.
- There is no notice loop.
- tsc exit 0; 146 tests passed at that point.

## Second pass on the r7 cut-down (2026-11-11)

**Reviewer:** independent reviewer subagent (fresh context), 2026-11-11, reviewing the staged r7 diff against `origin/main`.
**First read: do not concur.** Nothing from the removed §3, §6 or §7 was left behind (`QueuedReplySupersession.ts` matches main), and tsc and 754 related tests passed. The findings were about the kept sections:

1. **High (§8).** The ordinary hub post (`createAttentionItem` → `routeToAttentionHub`) carried no notice class. On a token-less machine with the gate live, these posts went through the durable forward: the held-reply item, the account-changed item and the held-expiry report. That allowed a loop (expiry item → held row → expiry). Re-posts were queued only on the `Confirmed` path.
2. **Medium (§2).** There was no single reachability check per pass: each row probed after its own pool-history review. A failed probe advanced the row's ladder even though no attempt had reached the holder.
3. **Medium (§10).** Each retry of a failed expiry report minted a fresh random evidence id, so a single expiry was counted several times.
4. **Low.** Some named audit outcomes were never written; the account-changed item was re-raised every tick; the re-post list lived only in memory; gone-machine closure was a side effect of a getter and had no loss reporter; re-posts had no logical-send key.

**Fixes:**
1. Every hub post is now notice-class. `routeToAttentionHub(item, noticeClass = 'attention-hub-post')` and the agent-health lane both send with `kindMetadata.noticeClass`. The held-expiry report passes `noticeClass: 'held-expiry-report'` through `createAttentionItem(..., { noticeClass })`, and the holder-routed delay notice passes `held-forward-notice`. On both the injected-topic path and the self-healed path, a relay failure before anything was prepared (`relayNothingPrepared`) now queues the item for re-post instead of self-healing the hub topic. Regression test: `tests/unit/telegram-origin/tokenless-hub-post-notice-class.test.ts`. It checks that an expiry report sent while the holder is unreachable is notice-class (so the server sends it by the direct relay, never as a hold), that the re-post survives an adapter restart, and that it is posted exactly once when the holder answers.
2. A new runtime option, `forwardTickReachable`, is read once per pass on the first forwarded row, in both `runForwardLadder` and `recoverHeld`. It runs before the recovery reservation and before the pool-history review. When it answers `false`, every forwarded row in that pass is skipped with no write, and no ladder is advanced. On a token-less machine the server wires it to one capabilities read of the lease holder (`retained-holder-unreachable-tick` audit row, with `gateLive`). That pass's rows reuse the answer through `recoveryProbe`, so a healthy pass also reads only once. Inside `recoverForwardedHold`, a failed probe re-holds the row with its ladder unchanged. Tests: the new integration case in `tests/integration/telegram-origin-tokenless-forward.test.ts` (one check per pass, no per-row recovery, ladder unchanged, delivered once when the holder returns), plus a ladder assertion in the unit suite.
3. `StandbyEvidenceOutbox.add(kind, key)` derives the id from `kind` and the operation id (sha-256, 24 hex characters), and skips an id that is already pending. Expiry evidence passes `row.operationId`, so each retry carries the same id, and the holder's seen-id file counts it once. Test: `tests/unit/telegram-origin/tokenless-evidence-dedupe.test.ts`.
4. Low-severity items:
   - **Fixed:** the `notice-not-held` audit row (with `gateLive`) on the direct relay.
   - **Fixed:** `retained-holder-unreachable-tick` (fix 2).
   - **Fixed:** the account-changed item now gathers each new topic into one item per (sealed, live) pair and is not re-raised for a topic it already lists.
   - **Fixed:** the re-post list is now persisted (`state/pending-hub-reposts.json`, atomic write) and reloaded after a restart. A re-post now uses the configured hub topic when the item has none.
   - **Fixed:** gone-machine closure is wired once, after the team switch applier, with a loss reporter. Each closed entry raises one HIGH attention item, "A reply was lost with a removed machine", instead of being silently deleted.

**Known gaps, recorded instead of inventing mechanism:**
- **`reseal-orphan-intent` audit.** A crash between `prepare` and `supersede` leaves an intent record that nothing admits, so it can never be dispatched. Finding such records needs a scan of intent records that have no admission. That is a store-level design change, so it waits for the slice that owns the store. The safety property it reports on, that an orphan intent can never be sent, holds without the scan.
- **`attention-repost:<itemId>` logical-send key.** A logical-send scope exists only inside the origin service's automation-credential flow, and the adapter's re-post cannot set one without new plumbing through `relayOriginBot`. Until then, a re-post whose response was lost relies on the holder's content dedupe (`duplicate-content` ends the re-post), as it did before.
- **Double capabilities read on a live direct relay.** `relayOriginBot` does not accept a capabilities answer it was handed. This costs one extra read when the holder is reachable, and never a wrong send.
- **Account-changed topic memory is in-memory.** After a restart, the first tick for each affected topic upserts the same item once. This is visible as at most one repeat, and changes no delivery.

**Second read:** CONCUR (same reviewer, 2026-11-11). The three main fixes are confirmed in the staged diff, with no new path that loses a reply, sends one twice, or sends under the wrong bot. Typecheck passes, and 77 related test files (1,172 tests) pass. The declared gaps were judged acceptable. Low, non-blocking notes from the second read:
- **Loss-item wording:** the gone-machine loss item said "It was never sent", but the true state is unknown. Fixed: it now says the reply may not have reached the user, and it omits a missing topic id.
- **Loss record order:** the debt entry is deleted before its attention item is confirmed, so a failed item post loses the record. Accepted for this change and recorded here.
- **Delay-notice metadata:** `held-forward-notice` now sends kind metadata to the holder's gate, a small behaviour change on the holder, and believed harmless.

## Class-Closure Declaration

**Class:** `unbounded-self-action`. **Closure:** guard, enforced by the ratchet `tests/unit/self-action-convergence.test.ts`.

This change adds four self-triggered notices on a machine without the Telegram login. Each one is registered in `src/testing/selfActionRegistry.ts` and marked at its emit site. Each model calls the same pure brake the production code uses (`src/messaging/telegram-origin/TokenlessNoticeBrakes.ts`, `TokenlessHeldDebt.closeGoneEntries`):

- **`tokenless-hub-repost`** (`TelegramAdapter.repostPendingHubPostsOnce`): re-posts an attention hub post that found the sending machine unreachable. Before the registration this path had no brake. It ran on every answer from the holder, so a holder that kept answering while every re-post failed would have retried each item about once a minute indefinitely. `hubRepostDecision` now backs off 1 min, 5 min, 30 min, then every 2 h. After `HUB_REPOST_MAX_ATTEMPTS` (8) failures it drops the item from the re-post list; the item stays open on the dashboard. The attempt counts are persisted with the list in `state/pending-hub-reposts.json`, so a restart keeps the backoff. Proven bound: 8 attempts per item, at 1x and 2x the horizon and across restarts.
- **`tokenless-account-changed-notice`** (server `onAccountChanged`): one item per (sealed, live) bot pair, raised again only when a new topic joins it (`noteAccountChangedTopic`). Bound: one per pair per topic. The topic list is held in memory, so a restart can raise the same fixed-id item once more per topic.
- **`held-forward-expiry-report`** (server `onHeldForwardExpired`, driven by `refreshHeldForward`): reported only while the row's durable `expiryReportedAt` marker is null (`heldExpiryReportDue`). Bound: once per expired row.
- **`held-debt-loss-notice`** (`AgentServer` gone-machine loss reporter): each debt entry is reported and then deleted (`closeGoneEntries`). Bound: once per entry.

The once-per-pass reachability probe (`forwardTickReachable`) is a read, not an emit. It is bounded by the recovery tick and skips rows without advancing their ladder.
