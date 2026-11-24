# Side-Effects Review — the relationship index: what a conversation is connected to

**Version / slug:** `work-front-doors-stage2-relationship-index`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Work-front-doors stage 2, the relationship foundation (spec `docs/specs/work-front-doors.md` §4, CMT-2065). Tier 2, about 11 files / ~900 lines with tests.

- `src/core/RelationshipIndex.ts` (new, pure): `deriveNeighbourhood()` derives, on read, one conversation's neighbourhood from the authoritative stores: its project (graph effort first, else the Chief of Staff bound project or its tree ancestor), open cards in that project or made from the conversation with whose turn, related conversations (siblings in the same effort), the people on those cards, and open promises made there, joined on `originMachineId::id`. Each group carries `complete` and reasons. `renderNeighbourhoodBlock()` writes the labelled `<conversation-neighbourhood>` reference block under a byte ceiling, and `NeighbourhoodDeliveries` remembers which revision each running session last received.
- `src/server/neighbourhoodSources.ts` (new): the live adapter. It reads the graph read model through a new least-privileged `GraphViewer`, plus the work board, Chief of Staff, commitments (own plus replicas) and the team/phone permission check (`MobilePairingService.mayUse`, reused, not re-implemented).
- `src/server/conversationNeighbourhoodRoutes.ts` (new): `GET /conversation-neighbourhood` and `GET /conversation-neighbourhood/session-context`.
- Wiring:
  - `routes.ts` registers the routes and fills `ctx.neighbourhoodLate`.
  - `AgentServer.ts` keeps the graph read model via a new optional `onReadModel` callback in `ConversationGraphSurface.ts`, and passes a `neighbourhood` dep to the per-prompt route.
  - `promptContextRoutes.ts` adds a `neighbourhood` field.
  - `memorySessionGuard.ts` admits the two GET routes for session tokens; the route holds them to their own conversation.
  - `PostUpdateMigrator.ts` adds a session-start block, its compaction-recovery twin, and the per-prompt hook's parse/print of the new field.
- Config and registration:
  - Config type `relationshipIndex {enabled?, maxBlockBytes?}`.
  - Dev-gate registry entry.
  - CapabilityIndex entry.
  - Awareness entry `src/data/awareness/conversation-neighbourhood.md`.

Effort: one plan pass, unit tests found two real defects in the first draft (both fixed; see Conclusion), and 1 commit attempt so far. In line with the size.

## Decision-point inventory

- Neighbourhood audience filter (`deriveNeighbourhood` `visible`) — **add**. Not a judgment decision: a permission invariant (a neighbour is shown only when every current reader of the conversation may read it, via each store's existing check). It blocks no message and no action.
- Graph read model `mayView` — **pass-through**. A new viewer is supplied; the read model's own filter (applied before any path, count or child) is unchanged. The owner-proof `conversationGraphViewer.ts` is not touched.
- Session-token scoping on the new routes — **add**. A hard invariant at the API edge: a session reads only its own conversation.
- Tone gate / outbound — **not touched**. The block is inbound context, not an outbound message.

---

## 1. Over-block

Over-block is limited to the information the read returns; nothing a person sends is blocked.

- A conversation a team member also reads hides the project's name, and hides any card or sibling conversation the member cannot read. The agent in that conversation is therefore told less than the owner knows. This is the spec's deliberate least-privileged posture (§4.3, hierarchy v3 decision 8).
- While team access is on but its record is unreadable, has a gap, or the puller is refusing, the read returns `audience: unresolved` and shows nothing. The block says so ("could not be confirmed... Do not assume there are none"), and it clears once the team record is current.
- An MSP phone that may read every Telegram topic makes every Telegram conversation "shared". Project names are then hidden in Telegram topics for any agent with an active MSP phone. This is accepted: it is the honest audience.
- With memory privacy on, a conversation whose session audience is another person (`person:`) or a shared place (`place:`) is shared. Anyone memory privacy says may read it is stood in for by one reader who can read that conversation only. Project names, cards and sibling conversations are then left out; promises made in that very conversation stay. An audience of `none` (or no running session to ask, with privacy on) is unresolved and shows nothing. With memory privacy off, every session already holds the owner's reach, so the block hides nothing it could not read (`reachOfAudienceKey`).

## 2. Under-block

- The audience is resolved from THIS machine's replicas of the team record. A grant made on another machine that has not arrived yet is not counted, so the agent may briefly show a neighbour the new reader cannot see. The window equals the team-record replication lag, which already bounds every other team read (phones, documents). The read never widens what a person can see: the agent sees it, not the member.
- App, card and Slack conversations get no block automatically. The per-prompt and compaction hooks are keyed on the Telegram topic, so a session there reads the route on demand; the awareness entry says so. Promises are linked to Telegram topics only, so in those conversations the promises group says "promises are only linked to Telegram topics" instead of reading as none.
- A promise is matched by its topic only. One the owner created in a shared topic as its delivery target shows in that topic, which is where it was promised.
- Slack conversations have no graph ref here (`cosConversationRef` returns null), so a Slack conversation gets no graph siblings. The read reports `conversation graph` normally; Slack placements are not counted as missing data. No false data is shown.

## 3. Level-of-abstraction fit

- The index is a derived projection, so it sits beside the stores rather than inside any of them. It reuses each store's own read and permission paths: the graph read model with a scoped viewer, `WorkBoardService.view`, `ChiefOfStaffLoop.projectsOverview/tree`, `CommitmentTracker.getActive` plus replicas, and `MobilePairingService.mayUse`.
- Context delivery rides two existing seams: the per-prompt prompt-context route (the first prompt of a session, and again on change) and compaction recovery. It adds no new delivery path. The plain session-start hook is deliberately not used: its output is not fitted to the hook limit (second-pass finding 5).
- Deviation from the plan's wording: the spec says "a derived index on each machine". This build derives on read with no persisted index, because each read is one pass over data the stores already hold in memory: a card fold, a union read, an in-memory graph projection. The source versions are recorded in every response, so a later persisted index would be a drop-in. No stored data means nothing to rebuild or evict, which makes the rebuild-and-eviction rules of §4.2 vacuous rather than violated.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The read filters what it reports by permission, which is a hard invariant (the "When this principle does NOT apply" case: typing/permission validation at the system edge). It makes no judgment about message meaning or intent, and blocks nothing.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The ceilings (cards 50, related 30, commitments 30, people 20, block 1,800 bytes) are declared floors. Reaching one pages the group and labels it `cut at N …`, and the block tells the session to read the full route. The block ceiling derives from Claude Code's 9,000-character hook output, which the block shares with the topic history: one fifth by default, configurable, never above half. The 15-minute "another machine's copy is old" label on commitments is a reporting threshold, not a decision.

## 5. Interactions

- **Shadowing:** none. The new routes have their own prefix. The per-prompt route only adds a field: `briefing`, `messages` and the delta computation are unchanged, except that the delta is fitted to its usual budget minus the block. The field is added after the fold-suppression early return, so a suppressed prompt carries nothing.
- **Hook budget (second-pass findings 3 and 5):**
  - The per-prompt hook trims its whole output to 9,000 characters, and the delta is recorded as delivered when it is sent. The server therefore attaches the block only when the rendered briefing, history and block together fit in 8,400 characters (the rest is the hook's headers and footer). The delta is fitted to `7,500 − block`.
  - When the whole block does not fit, a one-line pointer goes instead (about 230 characters, `neighbourhoodPointer`). It says the connections changed and names the route to read, and it is recorded as delivered.
  - Adopted from the second pass's residual note: about 18% of this agent's prompts run above 6,600 characters, so a busy topic would otherwise wait for room.
  - When not even the pointer fits, nothing is recorded, and it is offered again on the next prompt (integration test). So neither the block nor a message is lost to the trim.
  - Plain session start is not used, because its output is not fitted.
  - The compaction-recovery twin is not fitted either. It sits beside the existing topic-operator twin, and the block's 1,800-byte default (floor 600, cap 4,500) keeps it small.
- **Double-fire:** none per session. The first prompt delivers the block and records it; compaction recovery re-fetches directly, which is intended because the earlier delivery is gone from context.
- **Freshness (finding 4):** the revision is a digest of the content a reader sees: project, card, related, people, promises, audience and gaps. A late peer record, a status that changes with time, a tree move, an edited promise, a rename or a grant change all reach running sessions. A source version that moves with no visible change does not churn them.
- **Cost:** a read reduces the graph (twice: the node and its effort). The per-prompt path reuses one conversation's result for 5 seconds, holding at most 500 conversations. The graph read model keeps a paging snapshot for any first page that has a next page, in a store bounded at 1,000 shared with the owner's own reads. A new `remember: false` option on `ConversationGraphReadModel.node()` lets the neighbourhood's one-shot reads skip storing one, so frequent prompts can never evict an owner's "show more" snapshot. The default stays `true`, so every existing caller is unchanged.
- **Races:** none. It is read-only. `NeighbourhoodDeliveries` is a bounded in-memory map in one process.
- **Feedback loops:** none. The block is never written back into any store.

## 6. External surfaces

- **Other agents:** none. No peer route, and no data sent anywhere.
- **Install base:**
  - Dev-gated: live on a development agent, 503 on the fleet.
  - Hooks are always overwritten on update. On a fleet agent the per-prompt route returns `neighbourhood: ''` and the compaction fetch gets 503 and prints nothing (`curl -sf`), so nothing is visible.
- **Persistent state:** none.
- **Timing:** each hook fetch is bounded by `--max-time 4` (compaction twin: `--connect-timeout 1`), fail-open.
- **Operator surface:** no operator-facing actions. This is the agent's read; the screens keep their own routes.

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard or approval file is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Unified by derivation**, as spec §4.5 declares. Every machine derives the neighbourhood from its own replicas of the authoritative stores. No link is reachable only by asking a peer:

- the graph is replicated (WS graph runtime);
- the work board is replicated and reports `behind()`;
- the Chief of Staff union is replicated;
- commitments are own plus replicas, carrying `stalenessMs`.

Each source's "this machine is behind" signal is inherited and shown (the cards group's `behind`, the graph's `partialReasons`, commitment staleness), never a false zero.

- **User-facing notices:** none.
- **Durable state:** none, so nothing strands on a topic transfer. A conversation that moves machines is re-derived there.
- **URLs:** none generated.
- **Status surfaces:** a new `/capabilities` entry (`conversationNeighbourhood`) states the endpoints. Its answer is this machine's configuration: dev-gated per machine, and a machine with the flag off answers 503.

## 8. Rollback cost

- **Code:** pure code plus one config type. Revert and ship a patch.
- **Hooks:** they regenerate on the next update. A reverted server answers 404, which the hooks' `curl -sf` turns into silence.
- **Off switch without a release:** `relationshipIndex.enabled: false`, read live. The routes answer 503 and the hooks inject nothing.
- **State:** none to clean up.

## Conclusion

The review confirmed the change is read-only and dark on the fleet. Two defects found by the unit tests during the build were fixed before this review:

1. A project conversation a reader could not read was announced as "a project whose name is not shown". That leaks that it exists. It is now omitted entirely, along with its cards.
2. The block-fitting pass measured a shorter placeholder than the real "Cut to fit" line, so a cut block could overrun and fall back to "everything cut". It now reserves the longest possible cut line.

Two deviations are recorded:

- The index is derived on read rather than persisted (§3 above).
- The Registry First table row was not added. A row under a core heading needs its own instructions migration, and the awareness entry already reaches every agent with the same trigger. The route is also in the capability index.

The second-pass review raised seven findings, and each one was addressed in this change:

- **1 (HIGH), readers beyond the team record:** memory-privacy readers now count, via `privacyReach` and `reachOfAudienceKey`. A session token brings its own audience; for the bearer, the conversation's running session says, and with privacy on and no session to ask, the read is unresolved.
- **2, a removed card's title:** redacted cards are dropped in the adapter.
- **3, messages lost in delta mode:** the block is attached only when it fits, the delta is fitted to its budget minus the block, and a delivery is recorded only when the block is really sent.
- **4, a revision blind to content:** it is now a digest of the content.
- **5, session start not fitted:** the plain session-start injection was removed; the first prompt carries the block.
- **6 (LOW):** the minimum block is now 600 bytes and the fallback can never exceed the ceiling; per-prompt reuse is 5 seconds; app and Slack promises are labelled; the app-conversation limitation and topic-only promise matching are stated in §2. The read model kept after a graph runtime closes is replaced when the surface mounts the next runtime (the default surface remounts on runtime change).
- **7, artifact accuracy:** §2 and §5 were corrected.

The Conclusion's fix list now has nine items: the two above, plus these seven.

Clear to ship once the second pass concurs on the revision.

---

## Second-pass review (if required)

**Reviewer:** independent second-pass subagent
**Independent read of the artifact: concur** (re-review of the current diff, after the round-1 findings were addressed)

The first-round verdict was a concern, with one HIGH, four MEDIUM and four LOW findings. Each one is resolved in the current code:

- **1, other people who read the conversation:**
  - `reachOfAudienceKey` maps MemoryPrivacy's `audienceKey` forms correctly: `owner:`/`open`/`system` → owner, `person:`/`place:` → shared, `none` or anything unrecognised → unknown.
  - `conversationFor` derives the key from the session token's own audience. For the bearer, the running session's `memoryAudience` is used (`routes.ts`).
  - The stand-in reader can read only that one conversation (`mayRead` in `neighbourhoodSources.ts`), so project names, siblings and other cards drop out of a shared conversation.
  - With privacy on and no session to ask, the read is unresolved, which is the strict direction.
- **2, a removed card's title:** redacted cards are dropped in the adapter (`neighbourhoodSources.ts` `cards()`), so the `isCard` line can no longer see one.
- **3, lost messages in delta mode:**
  - The delta is fitted to `7,500 − block`.
  - The block is attached only when the rendered output plus the block is at most 8,400 characters.
  - `commit()` runs only when the block is really attached. On a withheld prompt nothing is marked, so the block is offered again on the next prompt.
- **4, freshness:** the revision is now a digest of what the reader is shown: project, isCard, the four groups, audience and gaps.
- **5, session start:** the plain session-start injection is removed. The first prompt, whose output is fitted, delivers the block.
- **LOW findings:**
  - A ceiling below 600 now falls back to the default.
  - The minimal envelope is returned only if it fits, else ''. I re-ran my earlier repro: 1,800 is honoured.
  - The 5-second reuse cache is bounded at 500.
  - App and Slack promises are labelled.
- **`remember:false`:** it does not change existing callers. `page()` defaults to `remember = true`. `nodeUnscoped` passes `q.remember !== false`, so an absent option keeps today's behaviour. The only callers that pass it are the two in `neighbourhoodSources.ts`. `ConversationGraphSurface.ts:111` (`{}`) and `conversationGraphRoutes.ts:82` (`{ cursor }`) are unchanged, and `roots` and `destinations` don't pass it.
- **Tests I ran:** unit 58 (relationship-index and conversation-graph-read) and integration 12, all passing.

Residual notes, none blocking:

- **A large prompt can keep the block from being delivered.** In full mode (the default when the delta is off), the block is attached only when briefing, history and block fit in 8,400 characters. On this agent's live delta-shadow log, the p90 full output is 7,219 characters, and 18% of prompts are above 6,600. In those prompts a 1,800-byte block is held back.
  - It is retried on the next prompt, so most sessions still get it. A topic whose briefing and history always run large would get it only from the compaction twin.
  - **Suggestion:** when the full output is the obstacle, attach a one-line pointer to the route instead, or say this in §5.
- **One comment is slightly off.** The compaction twin says "This output is not fitted". On the session-start compaction-source path, `compaction-recovery.sh` output does go through `fit-recovery-output.mjs`. It is unfitted only when Claude Code runs the hook directly.
- **A stale graph model can remain.** `graphReadModel` is replaced when a new runtime mounts, but nothing clears it if the graph surface stops without a remount. A read would then use the old model. It is read-only and its staleness shows in its revision, so this is low.
- **Privacy off counts as owner reach.** This is recorded in §1 as a deliberate posture: the session already holds the bearer.

---

## Evidence pointers

- Unit: `tests/unit/relationship-index.test.ts`, 28 tests. They cover:
  - project resolution: self, tree at any depth, graph wins;
  - cards and whose turn, card conversations, and the commitments `origin::id` join;
  - staleness and `behind`;
  - the least-privileged audience on both sides: a shared audience hides names and unreadable cards, an unreadable project is omitted entirely, efforts are never viewable for a shared audience, a throwing check fails closed, and an unresolved audience shows nothing;
  - sources off, unreadable or not ready are named;
  - ceilings, the revision digest, block fit and "Cut to fit", envelope neutralisation, and the bounded delivery memory.
- Integration: `tests/integration/conversation-neighbourhood-routes.test.ts`, 8 tests through the real route, real derive and real live adapter:
  - the bearer read, 400 and 503;
  - a session reads its own conversation only (another is 403, a placeless one is 403);
  - a phone is refused;
  - a team member narrows the view;
  - the session-context block;
  - rule 117: a changed block rides the prompt once per session, and a new card reaches two running sessions.
- E2E: `tests/e2e/conversation-neighbourhood-alive.test.ts`, 7 tests:
  - through the real AgentServer, a dev agent answers 200, session-context answers, the prompt route carries the field, and no bearer gets 401;
  - a fleet agent answers 503;
  - the generated session-start, compaction-recovery and per-prompt hooks fetch or print the block;
  - the dev-gate entry and the awareness entry exist.
- Regression sweep:
  - unit hook/parity suites (session-context-compaction-parity, recovery-output-fit, session-start-source-routing, telegram-topic-context-session-clock and others): 10,808 passed;
  - integration conversation-graph-surface, context-budget-delta-hook and conversation-graph-suggestions: 15 passed;
  - capabilities-discoverability: 210 passed;
  - devGatedFeatures-wiring and machine-coherence-manifest: 344 passed;
  - awareness-entry-registry: 45 passed;
  - memory-session guard, policy and safety: 69 passed;
  - `tsc --noEmit` clean;
  - generated hooks pass `bash -n`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect: not applicable. This is a new feature, not a fix, and it adds no self-triggered controller.
