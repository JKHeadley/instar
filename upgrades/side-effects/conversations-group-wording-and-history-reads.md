# Side-Effects Review — Conversations says "group", and owner history reads stop failing on a busy lease holder

**Version / slug:** `conversations-group-wording-and-history-reads`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see the end of this file)`

## Summary of the change

Two parts, one PR (Tier 1: a revert fully undoes both).

1. **Wording.** The owner chose "group" as the user-facing word for what the code calls an effort (Telegram, 2026-11-17 15:34). The dashboard Conversations pages now say "Your groups", "Suggested groups", "Create group", "Rename group", "Group name", "Open group", "No groups yet. Your conversations are in All.", "Forget group name", and so on (`dashboard/console/conversations.js`, `conversation-effort-actions.js`, `conversation-suggestions.js`, `conversation-pending.js`, `conversation-erasure.js`). The agent-facing awareness text (`src/messaging/shared/conversationGraphChat.ts`) says "group" and tells the agent to call them groups to the user, with "effort" only the internal name. Existing agents on the old full CLAUDE.md layout get the old phrases rewritten by an idempotent step in `PostUpdateMigrator.migrateClaudeMd` (the two sections are install-if-missing, so their text would otherwise never change); agents on the reference layout get it from the regenerated canonical document. Routes, data names, the `effort` kind, CSS classes and file names are unchanged. The Telegram `/conversations` and Slack `!conversations` pointer text never said "effort", so it is unchanged.
2. **History reads.** `GET /conversation-graph/nodes/:ref/messages` gated on `runtime.isReady()`, which needs a write-readiness proof from the last 60 seconds and is zeroed while the background pass re-earns it. On the live Studio (lease holder) 25 of 30 owner history reads over three minutes answered 503 `conversation-graph-off` while the node reads themselves answered 200, so the dashboard showed "The original history could not be loaded." The history route now gates on a new `runtime.privateReadsServable()` = `alive() && privateCustodyAllowed()`, the same gate the owner's read view (`readView`) already requires before it can resolve the very source this route reads (`src/server/ConversationGraphReplicationRuntime.ts`, `ConversationGraphSurface.ts`, comment in `conversationGraphHistoryRoutes.ts`).

## Decision-point inventory

- Owner history route readiness (`ConversationGraphSurface` → `createConversationGraphHistoryRoutes.ready`) — **modify** — from the 60 s write-readiness proof to the private-serving custody check the read view uses. Owner proof (`verifyOwner`, checked before and after the fetch), source resolution through the authorized projection, the holder URL guard and the final re-checks are unchanged.
- Wording: no decision point.

---

## 1. Over-block

The old gate over-blocked: owner history reads were refused whenever the lease holder's background pass was running or more than 60 s past its last proof, which on a busy machine was most of the time. The new gate answers 503 only when the runtime is closed or private serving is withheld (the read view is refused then too, so the page shows no source to read); before the first verification the route answers 404 `conversation-unavailable` from source resolution, as before. No new over-block.

## 2. Under-block

The route still serves only when the owner proof holds and the source resolves through the authorized projection, both re-checked after the fetch. What the new gate no longer requires is a fresh write-readiness proof. That proof is about admitting graph writes (mutations, actuation, peer delegation); the history route writes nothing to the graph and returns the source platform's own messages, which the same agent already serves to a plain bearer caller at `/telegram/topics/:id/messages`, `/mobile/chat/slack/...` and `/mobile/chat/app/...`. A handover in progress: `privateCustodyAllowed()` is the check the runtime uses to withhold private data while custody moves (`peerFrontier.assertPrivateServing`, held imports settled), and it is re-evaluated at each of the route's re-checks. Not identified: a case where the read view may show a source but its history should be withheld.

## 3. Level-of-abstraction fit

Right layer: the route already delegated readiness to the runtime; it now asks the runtime the question that matches a read. No parallel check is added. The wording change is presentation only.

## 4. Signal vs authority compliance

No brittle check is added and none gains blocking authority. The history gate keeps the runtime as the single authority and narrows which of its answers applies. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

- `isReady()` callers (mutation admission, delegation, queued owner intents, projection) are untouched; only the history route moved off it.
- The dashboard history panel (`conversations.js` `historyRegion`) now gets 200 where it got 503; its "could not be loaded" path still covers 502 `source-history-unavailable` (a slow pool read; the Studio showed two of those at 12-16 s, see §6).
- The wording migration runs after the install-if-missing steps for the same two sections, so a brand-new append gets the current text and the replace step finds nothing. Idempotent: no new phrase contains an old phrase.
- No overlap with the parallel phone-suggestion work (different files: it adds mobile routes and the "make this group a project" action).

## 6. External surfaces

- Owner-visible: new words on the Conversations pages; history now loads where it was refused.
- Agent-visible: the awareness paragraph changes on every agent at update.
- Still open, not fixed here (triaged, reported to Echo): the "Syncing with another machine. Some original history is unavailable." line on the Studio comes from the read view's `replica-lag` + `evidence-missing` (source-inventory coverage). The coverage detail is not exposed by any route, so which producer is missing or stale could not be read from outside. Related evidence: the Studio log holds 98 `graph-peer-replayed` refusals; the peer client resends the same signed request (same `requestId`) to the next endpoint after a first endpoint times out at 5 s or answers non-OK, and the receiver correctly refuses it as a replay, so a slow first attempt is never retried successfully. That is a graph-protocol change and is reported for its own spec.
- Timing: the history gate no longer depends on background-pass timing.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes, unchanged layout: the Overview still opens on "Your groups" with "Create group" and the suggestions link where "Your efforts" and "Create effort" were; only words changed. The history panel now shows the messages the owner opened the conversation to read instead of "could not be loaded".
2. **Zero raw internals as primary content?** Yes. The change removes an internal word ("effort", the code's name) from every headline, button, label and status line the owner sees; no identifiers are added.
3. **Destructive actions de-emphasized?** Unchanged: "Forget group name" keeps its existing quiet placement in the More sheet with its confirmation; no ordering or styling changed.
4. **Plain language + phone width?** Yes. "Group" is the owner's own word (2026-11-17), shorter than "effort" in every string, and "No groups yet. Your conversations are in All." is shorter than the line it replaces, so no layout can wrap more than before. No element, class or style changed; not re-rendered at 390 px for this wording-only change (the existing DOM tests cover the rendered text).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

History reads: proxied-on-read as before (Telegram `scope=pool`, Slack to its holder, app `scope=pool`); the gate is per machine and now matches that machine's own read view. Wording: machine-local presentation; every machine gets the same text from its own build. Awareness text: per agent, rewritten on each machine's update.

## 8. Rollback cost

Revert the PR and release. No data, config or state is written; the migration only rewrites three phrases in CLAUDE.md and a revert's migrator would not restore them (the old build's install-if-missing steps see the headings and leave the new words), which is harmless.

## Proportion

Tier 1. 13 files, about 120 lines changed (most of them one-word string swaps). One spec round (none, Tier 1), one commit attempt planned.

## Second-pass review

Concur with the review.

- Traced the gates in `ConversationGraphReplicationRuntime.ts`: `privateReadsServable()` (l.495) is exactly the precondition `readView()` (l.547) and `retainedProjection()` (l.501) already enforce, and `resolveSource` can only return a source when `model.node()` → `source.readiness()` → `runtime.readView()` succeeds (`conversationGraphRead.ts:153`, `ConversationGraphReadSource.ts:36`). So before the change, the route's effective gate was `readView ∧ isReady`; it is now `readView` alone. Nothing new becomes resolvable. The route still re-checks both the gate and a fresh `resolveSource` after the fetch (`conversationGraphHistoryRoutes.ts`, post-fetch block).
- Closed runtime: `close()` sets `stopped` (l.894), so `alive()` fails. Handover or member loss in owned-machine mode: `privateCustodyAllowed` (l.262) requires `peerFrontier.assertPrivateServing` and held imports settled. In non-owned mode, `positiveCustodyAllowed` was also a no-op (l.260), so the only thing dropped there is the 60 s freshness and lease-epoch match, which are write-admission concerns.
- Before boot catch-up: `retainedProjection` throws while `lastVerifiedAt===0` with no retained snapshot, so `node()` fails and the route answers 404 `conversation-unavailable`, not a leak. Small inaccuracy: §1 says the new gate refuses only when closed or custody is withheld, but before first verification the refusal comes as a 404 from source resolution, not a 503. This is cosmetic.
- Non-owner viewer: `verifyOwner` requires a live `X-Instar-Operator-Session` owner proof (`conversationGraphViewer.ts:16`). A plain bearer gets 403 before the gate, and the bearer-reachable Telegram/Slack/app message routes already serve this content to a bearer caller, so the graph gate was never the confidentiality boundary. The remote Slack holder path is unchanged: it uses the allowlisted peer and the URL guard, and the retained (older) view can at most name a previous holder that is still one of our own pool machines.
