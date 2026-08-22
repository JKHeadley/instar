---
title: "Cross-Machine Conversation History Coherence"
slug: "cross-machine-conversation-history-coherence"
author: "echo"
eli16-overview: "docs/specs/cross-machine-conversation-history-coherence.eli16.md"
review-convergence: "PENDING — rev-4g convergence VOIDED 2026-08-21 by operator directive (topic 52222): OD1 single-machine survivability + OD2 rejection of the machine-local posture overturn the core decision; Q9 withdrawn as posed. A rev-5 pass is owed. Do NOT drive /instar-dev from this file."
approved: false
---

# Cross-Machine Conversation History Coherence — Spec

**Status:** rev 4g (draft, pre-convergence). 4g = all six round-6 internals folded: the per-epoch high-water moves OFF `topic-placement` (closed field list; 2026-06-30 shape) into a `history-index` row written by the poller with origin ≠ asserter and defined as the first inbound under e+1; `evictedWatermark` replaces the resident-minimum horizon; pull throttle never starves an empty or upgraded peer; row carries no `machineId`; `relay-echo` is index-only; a real weekly follow-up job is installed for CMT-048–051; CMT-051 registered. 4f = round-6 externals folded: §6.7 single-writer-at-the-seat alternative (decided at Phase B, ACT-091), poller-emitted high-water record, automation rows out of the resident set, signal-only PreToolUse guard in Phase A, steady-state sentence, Appendix A moved to its own file. Gate: 0. Round-6 internals pending. 4d = round-5 external findings folded: FD44 membership-set index (supersedes the agent-reply-only shape; retires S1 for multi-machine), FD45 epoch-stamped clock-free ownership check, FD46 single capability resolver, §0.1 implementation checklist with Phase A/B/C build order, §6.6. Round-5 internals pending. 4c = all nine round-4 reviews folded (≈60 findings, ≈20 design-class, concentrated in FD43/S5 and in my own editing residue); gate at ONE finding = Q9 (operator's). §3.1.1–3.1.5 restored from a mis-cut appendix; S5 requires the conversational relay script to stamp `messageKind:'reply'` (it never did — tooth D); rung-1 terminal made structural; ownership cross-check origin≠asserter + time-bounded; replica rotation named a foundation defect (ACT-089); CMT-050 for the L2 enforce decision. Rev 4 deletes the S4 scaffolding (FD42), declares the dependency on `inbound-message-recording-gap.md`, and adds §0 — the one section a builder builds from. Review archaeology remains inline below §0 and in Appendix A; the contract is §0.
**Author:** Echo
**Driving incident:** 2026-08-21, topic 52075 (`echo-deepseek-harness`)
**Constitution ties:** "Know Your Principal" (identity of a turn's author), "A Dark Feature Guards Nothing", honest degradation, Registry First.

---

## 0. Normative build contract (rev 4d — BUILD FROM THIS SECTION; everything below is evidence, rationale and archaeology)

### 0.1 Implementation checklist (self-contained — artifacts, gates, APIs, tests, build order; the prose after it is rationale)

**Build order (round 5 — the two specs named each other as prerequisites, a deadlock until sequenced):**
- **Phase A (this spec, ships first, always-on):** the shared formatter + honest block (Layer 1), the fourteen-surface conversion, the forward ratchet, the per-message `?block=1` path with its visible fallback, `GET /conversation-history/block`, the `emergencyDisable` hatch. Needs nothing from the write spec.
- **Phase B (write spec `inbound-message-recording-gap.md`, converge + ship):** each machine records every inbound turn at the injection seam. Independent of Phase A's code; unblocks Phase C's completeness.
- **Phase C (this spec, dark → enforce on soak; CONDITIONAL on the Phase-B choice in §6.7):** the membership-set index (FD44) + Layer 2 merged read + `?scope=pool`; enforce flips are CMT-049 (journal), CMT-050 (historyMerge) and CMT-051 (`stateSync.historyIndex` dryRun→false), the operator's.

**Artifacts:** `src/core/ConversationHistoryBlock.ts` (pure formatter, FD35 contract); `history-index` journal kind (FD44) carrying two row provenances — held-row membership `{topicId, messageId, provenance, placementEpoch}` and the poller's per-epoch high-water `{topicId, epoch, highWater, provenance:'placement'}` (FD45) with `DEFAULT_RETENTION {4 MiB, rotateKeep 4}`, dual registry, dev-gate entry + STORES list + receive advert, per-kind replica prune; resident `Map<topicId, Map<origin, sorted messageId[]>>` (256 cap per pair); three rewritten hook literals; `telegram-topic-context.sh` added to `installHooks()`; CLAUDE.md section; release-note fragment.
**Gates / flags:** Layer 1 none (emergency-disable only); `multiMachine.stateSync.historyIndex` `{enabled omitted, dryRun:true}`; `multiMachine.historyMerge` `{enabled omitted, dryRun:true}`; one **capability resolver** (FD46) backs `capability.*` and `GET /conversation-history/capability`.
**APIs:** `GET /conversation-history/block` (always 200 after auth), `GET /conversation-history/merge` (`{layer2:'off'}` when dark), `GET /conversation-history/capability`, `GET /telegram/topics/:id/messages?block=1` → `{block, hedged, messages}`, `?scope=pool` (503 when dark).
**Tests (all tiers):** §7 — negative controls for every verdict; positive control that a stock conversational reply shows as held-elsewhere; the flag-product test (no combination yields an unhedged claim); `headerEarned ⇒ verdicts.length===0`; both 52075 fixture shapes; FD45's stale-owner case (an epoch-3 row with `messageId > highWater(4)` ⇒ unverified) and its inverse; a missing high-water row ⇒ unverified; equivalence tests for the two retained hook templates plus the telegram deletion; feature-alive on `/conversation-history/block`; a SECOND 52075 fixture asserting the FD44 path lists 52134 from the set-difference when the index is live. **Re-surfacing CMT-048/049/050 (round 6 corrected):** enabling the `commitment-checkin-reminder` job would do NOTHING for them — its pass selects only commitments with `checkInAt`, which no write path sets. The real cadence (round 6 gate: a due date with an event-driven re-surface is not a cadence): a dedicated scheduled job on the authoring agent, `cmt-52222-followups` (weekly, Fridays 12:00 local, haiku) — INSTALLED 2026-08-21, not planned — reads CMT-048/049/050/051 and posts their status into topic 52222 until every one is delivered, then disables itself; the overdue `GET /commitments` read at session start is the secondary path. No dependency on `checkInAt`.
**Operator:** Q9 (ratification incl. retention/access terms) — the only item parked on the operator.

*Vocabulary used here: FD = a Frontloaded Decision (resolved so the build never stops to ask); DP = a classified Decision Point; P20 = the "verify the state, not its symbol" standard; INV = an invariant on the injected block's wording; S1/S5 = the two gap signals that survive (S4 was deleted).*

**Dependency.** This is the READ half of a pair. The WRITE half — each machine records every inbound turn it is shown, at the injection seam — is `docs/specs/inbound-message-recording-gap.md` (FD42; its orphaned ACT-1216 is re-registered here as ACT-085). Where that is not enabled, a machine's log is incomplete for its own ownership span and Layer 1's hedge is what ships.

**Layer 1 — honesty floor. Always on, no enable flag; `monitoring.conversationHistoryBlock.emergencyDisable` only, with a guardManifest row (FD28).**
- One pure, synchronous formatter, `src/core/ConversationHistoryBlock.ts`, contract in FD35 (`ConversationHistoryBlockInput` — rows, summary, `capability`, `contributions`, `signals`, `truncated` — → `ConversationHistoryBlockResult`). Rows are `MergedHistoryRow` (`contentOrigin`, `privacyScope`, opaque `ownerKey`, no authority fields); the CONSUMER type `OperatorHistoryRow` is branded so peer rows cannot reach the standing-authorization resolver (FD35, measured by tsc).
- **Fourteen emitting surfaces exist; v1 converts thirteen** (six TS builders, `TopicMemory.formatContextForSession` + `formatContextForUser`, `formatInlineHistory`, the three always-overwrite hook literals — telegram-topic-context, compaction-recovery, session-start — and iMessage `NativeBackend.ts:336`; `slack-channel-context.sh` struck per FD8). A behaviour-keyed forward ratchet with a seed corpus of every current header fails CI on a fifteenth (FD38).
- The block states scope (machine, count, span, contributors) and lists gaps in up to two groups: **`LATER REPLY ELSEWHERE`** (S5 evidence — renamed in rev 4b because the evidence is "a later agent reply exists after this turn with no intervening user turn", which is causal enough to act on and not enough to assert "answered") and **`NO LOCAL ANSWER, UNVERIFIED`** (S1). Capped at 5 + an aggregate line. **Listing rule (rev 4b):** with `peerCount > 0`, S1-only gaps ARE listed, INCLUDING the trailing run — the incident's own 52134 is the trailing turn, and excluding it would unflag the spec's regression fixture; with `peerCount === 0` the cross-machine hedge list is empty and a `GENUINELY UNANSWERED` group carries the address-this imperative (FD29) — **predicate (round 4, D5): the trailing run, i.e. the contiguous newest user turns with no following non-automation agent row, INCLUDING the triggering message** (excluding it would make the group always empty); wording *"Address these if they need an answer."* Resets only on a non-automation agent row — strictly more often than the deleted hook, which reset on any non-user row; fixture: user turn → automation notice → user turn ⇒ both listed.
- **On prose-as-enforcement (round-4d gate, *Structure beats Willpower*; the clean-door reviewer said the same):** the INV wording is a SIGNAL to the reading model, not a guarantee — stated, not implied away. The durable fix is **data completeness**, not instruction policing: the write-side recording (FD42) plus the S5 index make the block *correct*, so the imperatives have less to do; INV-1 is recorded as unenforced (CMT-048) and INV-1a's rung-1 terminal rides the existing rung-floor machinery rather than new prose. The block text is kept minimal; tests target data correctness first and wording second.
- **Block size (round 5):** scope line + gap list + ONE verify-first sentence + the scope paragraph — nothing else. The imperatives are a signal; the data is the fix. DP7's closed set is the minimum: answer normally; name the uncertainty when it bears on the answer; verify-before-acting (structural rung-1 terminal); the single-machine address-this line.
- **Honesty about INV-1a's status (round 6):** DP7 is `invariant` about what the block CARRIES (a fixed template); the BEHAVIOUR INV-1a asks for (verify before re-performing an action) is ADVISORY wording measured by tests until the structural PreToolUse guard (ACT-090) exists — the highest-cost failure mode is mitigated by prose plus the structural rung-1 commitment record, and the spec says so rather than calling the behaviour an invariant.
- Behavioural invariants, closed imperative set, DP7: never instruct silence (INV-1); verify-before-acting, unconditional on every listed turn, with a rung-1 approval terminal for unverifiable+irreversible (INV-1a); never instruct a hand-back (INV-2); never name an unavailable recovery — block, CLAUDE.md, or skill (INV-3). INV-1 is MEASURED not CERTIFIED — CMT-048.
- Summary: **qualify-in-place, universal; suppression removed** (FD6, DP5). `TopicMemory` header uses `COUNT(*)` (§3.1.6d). No-gap header earned only per DP6b (`userTurnsInWindow > 0`, trailing run excluded from the PREDICATE only). Unmeasurable ⇒ hedge; "no gaps detected" forbidden on truncated input (FD30).
- Audit row per gap-bearing spawn, ids and counts only (FD7/FD32). Read surface `GET /conversation-history/block`, always 200 AFTER successful Bearer auth while L1 is live — 401/403 otherwise (`journalAvailable`, `suppressedByFD29`, `indexEmitsDropped`, …).

**Scope of what the index proves (round 6):** FD44 delivers GAP DISCOVERY — "a peer provably holds rows this machine does not" — exactly and classification-free. It does NOT deliver complete transcript reconstruction: until Phase B (the write half) lands, the answering machine still never logs the inbound turn it answers, so no membership set can prove owner-span completeness. Discovery is Phase C; completeness needs Phase B. **S5 — the only causally-tied signal. Evidence = the membership-set `history-index` (FD44): one row `{topicId, messageId, provenance, placementEpoch}` per row each origin holds, both directions. A turn is LATER REPLY ELSEWHERE when a peer's set contains a `provenance:'agent'` row for this topic with a greater `messageId`, no intervening user turn, absent from the rendered rows, from an origin whose `placementEpoch` matches a non-self placement record AND whose `messageId ≤` the poller's `history-index` high-water row for epoch+1 (or the epoch is current) — the clock-free stale-owner bound (FD45). Rows a peer holds that this machine does not are the exact gap list; S1 survives only for the single-machine case.** Two routes — the replicated index when BOTH `coherenceJournal.replication.enabled` and `stateSync.historyIndex` are on (a local, zero-network READ of peer-asserted data; dry-run first per §9) or Layer 2's digest under L2-enforce; neither live ⇒ the group is absent, the block says so, **and S1 SURVIVES** — S1 is retired only where the index resolves `'local'` or `'via-l2'`, never on a machine where it is `'unavailable'` (the fleet), so the 52075 regression fixture (peers present, index dark) still flags 52134 (round 5 — the first FD44 wording would have re-opened the FD29 composition failure). Signal, never authority (FD39).

**FD43 index:** resident lookup structure (round 4 — "O(1)" implied one that was never defined): `Map<topicId, Map<originMachineId, sorted messageId[]>>`, holding only `user` and `agent` rows (automation rows stay in the file but are EXCLUDED from the resident set — round 6: at a 90%-automation mix a 256-row cap was ≈26 replies, so the exact gap list was available on quiet topics and evicted on active ones, the inverse of where splits matter), capped per (topic, origin) at the 256 most recent such rows (round 5 — "covers any 30-row window" was false in the unit that matters: the window is 30 LOCAL rows, and a peer serving the topic for days puts far more than 256 rows inside that span; stored as a growable `Int32Array` per pair (messageIds are SMIs) — ≤1 KB per filled pair, so an 8 MB global LRU holds ≈8,000 pairs (round 6: at the rev-4e ~24 B/row the same bound evicted ~55% of a 1,000-topic × 3-origin agent); `indexResidentPairs` and `indexLruEvictions` on `GET /conversation-history/block` make an LRU-evicted topic a COUNTED S1 downgrade, never an invisible one; a per-origin resident-topic share cap (no origin may hold more than 40% of the LRU) stops one buggy origin emitting across thousands of topicIds from blinding the index pool-wide (Tier-1: a 5,000-topic flood from one origin does not evict another origin's topic)), maintained incrementally from the applier's apply hook, warmed at boot by a streamed 64 KiB-chunk scan of EVERY replica OFF the request path (measured: 20.8 MB / 42,000 rows in 36 ms, loop delay max 1.1 ms) with `indexWarmMs` and `indexWarmState: warming|ready|failed` on the read surface; while warming — which coincides with the boot respawn burst — `capability.historyIndex` resolves `'unavailable'` and the block says "index warming" rather than computing a coverage timestamp it cannot. New `JournalKind` `history-index` + `DEFAULT_RETENTION {4 MiB, rotateKeep 4}` + dual registry + `multiMachine.stateSync.historyIndex` + receive-side schema mirror + `ReplicatedKindBounds` cap in one PR; `recordKey = topicId:messageId` (compaction is a no-op on a per-row key — no exemption exists or is needed); best-effort, never blocks a send; relay-echo dedupe with the answering machine winning; an old peer IGNORES the unknown kind (forward-compat); the sender bounds its re-offer; ~500 KB/day per origin at this machine's mix (FD44 — every held row, both directions). Posture: replicated. At-rest: activity metadata on every pooled machine — folded into Q9.

**Layer 2 — merged read. Gate `multiMachine.historyMerge` (the `DEV_GATED_FEATURES` `configPath`), `enabled` OMITTED from defaults, `dryRun:true` first (§8).** Spawn-scoped single-flight; 1,500 ms/peer, 2,500 ms total, 30 rows/peer, 2,000-char clamp, 512 KiB merged, hostile-response caps per `routes.ts:8150`. **Concurrency (rev 4b — the rev-4 "one reserved slot per spawn" was arithmetically impossible against a 4-slot cap):** global cap 4, priority FIFO where each spawn's FIRST peer fetch queues ahead of any spawn's second, bounded queue; **deadline eviction at dequeue AND at enqueue** (round 5: dequeue-only let a bounded queue fill with expired entries in the slow-peer case, refusing a fresh spawn's FIRST fetch — the one the priority rule protects; a queued fetch whose spawn's 2,500 ms deadline has passed is swept on either event, counted as `peersSkippedForBudget`, never dispatched). Queue bound: 64 entries; overflow ⇒ `peersSkippedForBudget`; per-peer timeout = `min(1500 ms, remainingDeadline)` so a slot is never held past its consumer's hedge. Coverage, stated honestly (round 4 arithmetic with the 750 ms `restart-all` stagger): with healthy peers (50–300 ms) four slots sustain far more than the ~2.7 fetches/s a 20×2 burst produces and the cap is never hit — full coverage; when peer latency approaches the 1.5 s timeout the rule degrades to one peer per spawn (second fetches starve by construction). The restart-all soak records peer p95 latency beside `peersSkippedForBudget` so the two cases are distinguishable. **Formal target + backpressure (round 5):** ≥1 peer contribution per spawn within the deadline for ≥95% of spawns when peer p95 latency ≤500 ms; when the queue depth exceeds 2× the slot count the fan-out sheds new second-fetches FIRST (backpressure), never first-fetches; below target the block hedges and the soak fails the enforce criterion — a stated target, not counters after the fact. Peer URLs allowlisted before any token is attached (plain fetch per the guard header; a 3xx is `unreachable`); a rejected URL is a visible `url-rejected` contribution (§5). **Privacy + which store the merge reads (rev 4b; amended round 4 — lessons F3: the write half's essential write is JSONL, its `TopicMemory` write is a sheddable `setImmediate` secondary, and it adds an `inbound_messages` table — so a merge reading TopicMemory ONLY would lose exactly the rows recorded under load):** the fan-out serves OUTBOUND rows from `TopicMemory` (scope established) and INBOUND rows from `TopicMemory.messages` (which already carries `from_user`, `telegram_user_id`, `user_id` — round 5: the write half's `inbound_messages` table exists nowhere in `src/` yet and is unioned in only when Phase B lands; scope = `telegram_user_id`; a NULL uid ⇒ `private`, excluded (FD29 fail-safe); `body_captured=0` ⇒ rendered as "row held on <machine>, body not captured" — a membership fact, never a dropped turn) (scoped by `telegram_user_id`; that spec's normative artifact is `docs/specs/generated/inbound-message-recording-gap.contract.md`); JSONL-only peer rows are not merged and surface as a visible `scope-unavailable` contribution state. Peer rows never written locally (FD5). Read surface `GET /conversation-history/merge` → `{ layer2:'off' }` when dark.

**Withdrawal rule under Layer 2 (round 4 — D4; §0 never said when a merged reply clears a gap):** a listed turn is WITHDRAWN from every group when the merged row set contains a `provenance:'agent'` row of ANY origin with a greater `messageId` and no intervening user turn — the reply is visible, so no warning is owed. DP6b's header predicate reads "agent row in the RENDERED set" (local-only when L2 is off). This is the single named exception to FD11 (evidence otherwise only moves a turn between groups); Tier-1: a merged block containing the peer's reply directly below 52134 lists nothing for 52134 and earns the header.

**Layer 3 — `?scope=pool` on `/telegram/topics/:id/messages`**, per-row `machineId`, same privacy rule, rate-limited. **Dark behaviour (rev 4b — §9/INV-3 said 503, §0 said otherwise):** 503 when the L2 gate resolves off; INV-3 therefore requires every surface that names it to state that condition.

**Per-message hook path (`?block=1`).** All three hook literals render the server block (local rows + the replicated index when local; Layer 2 never on this path; ≤5 ms synchronous-section budget measured by `hrtime`, hedged 200 on overrun); their own detectors and the MUST-address imperative are deleted; fetch `--max-time 1 --connect-timeout 1`; on a 200 without `block`, any non-200, or timeout → local rendering WITHOUT the imperative, PREPENDED with `[server history block unavailable (<reason>) — this machine's local view only]` so the weaker path is visible (No Silent Degradation — round-4c gate); only if that fails → one honest `[history block unavailable: <reason>]` line, exit 0 — never empty output (FD36). `telegram-topic-context.sh` added to `installHooks()` and its template deleted with dependents dispositioned; the other two templates are equivalence-pinned, not deleted (§8).

**How this reaches EXISTING agents (Migration Parity, restated here so it cannot be missed):** every deployed hook is written from the migrator literal by `migrateHooks()` on every update tick (always-overwrite, never install-if-missing), so the three rewritten hooks and the deleted local detectors land on every existing agent at its next update; template deletion changes nothing on a deployed disk; the `history-index` kind, its dev-gate entry and the `emergencyDisable` guard row ride the same update; `installHooks()` changes are for fresh agents only (§8 has the per-file rows and dependents).

**What is load-bearing and what is dark — stated so "A Dark Feature Guards Nothing" is answered rather than tripped:** the ALWAYS-ON guard is Layer 1 ALONE (honest scope, listed gaps, INV-1/2/3) — it needs nothing from any other phase. The write-side recording spec (FD42, Phase B) is a COMPLETENESS improvement that lands after Phase A ships; it is never counted as part of the always-on guard (round-5 gate: naming it so while sequencing it later left Phase A's guard resting on an absent dependency). Layer 2 — the merged read that would fulfil the session-pool drain-barrier promise (§1.7) — ships dark and dry-run, so **that promise is NOT claimed delivered by this spec**; its enforce flip is a dated, owned graduation on the §3.2.1 soak counters — registered as CMT-050 (owner agent, `blockedOn:user-authorization`, actionClass `config-flag-graduation:multiMachine.historyMerge`, due 2026-09-04), the same shape as CMT-049 for the journal, and until it lands the transfer path's CONTINUATION is honest-but-incomplete by design, never silently incomplete.

**Shipped fleet behaviour, stated plainly (round 6):** with replication dark everywhere, Phase A lists the triggering message of every multi-machine cold start as `NO LOCAL ANSWER, UNVERIFIED`. That is the STEADY STATE of the shipped fleet, not a degraded mode — honest scope plus a hedged list is what every agent gets until Phase B/C.

**Recorded acceptance (round 6 gate, *Structure beats Willpower*): INV-1a's verify-before-acting behaviour is ADVISORY in Phase A — owner Echo, accepted risk expiring 2026-09-18 (ACT-090's due date), reason: a PreToolUse guard with BLOCKING authority is a new gate that needs its own converged spec and cannot be smuggled into this one; the structural rung-1 commitment record (typed, gate-invisible) is the Phase-A floor for the irreversible case.** **Phase A also ships a SIGNAL-ONLY PreToolUse guard** (round 6): a hook that reads the block's machine-readable `verdicts` and logs a would-block when a side-effecting Bash/MCP call follows a listed action turn — no blocking authority (that is ACT-090's own spec), but INV-1a's single defence stops being prose alone from day one.

**Tests (§7, all three tiers):** the negative controls are mandatory — the assertions whose false pass is silent.

**Durable commitments:** FD40 → CMT-048, FD27 → CMT-049, L2 enforce → CMT-050, index-consumer enforce → CMT-051 (beacon-enrolled, `nextUpdateDueAt` 2026-09-04 — the API's re-surface field; `checkInAt` is not accepted on a commitment). Re-surface path on THIS agent, verified (round 5): `promiseBeacon.userOutputEnabled` is false, the `commitment-checkin-reminder` job is installed but `enabled:false` + dryRun, and NO `commitment-check` job file exists here — so today NOTHING fires at the due date. What re-surfaces them is `GET /commitments` (overdue) read at this topic's session start and the per-session commitment context block; the three dated promises re-surface via the overdue `GET /commitments` read at session start; no job enable is claimed (the reminder pass keys on `checkInAt`, which no write path sets).

**Operator decisions:** Q9 — ratification that conversation content stays machine-local (§6.1), extended to the FD44 `history-index` (message ids of BOTH directions + placement epochs; user-activity metadata, never text) — is the only decision that blocks the BUILD. Two graduations (CMT-049 journal, CMT-050 historyMerge) await authorization AFTER their soaks; they do not block Phase A.

## 1. Problem

A conversation's transcript is **split across machines**, and no machine holds the whole thing. A session that resumes a conversation on a machine that holds only half the transcript reads that half as if it were the whole conversation, because the context block it is handed **declares completeness it cannot substantiate**.

The result is a class of failure the agent cannot detect from inside: it re-answers questions that were already answered, or answers with the earlier exchange missing from its reasoning, and does so confidently.

### 1.1 Why the transcript is split

The two halves of a conversation are recorded by different processes:

- **Inbound** is recorded by whichever machine polls Telegram — the serving-lease holder.
- **Outbound** is recorded by whichever machine actually answers — the topic owner.

For any topic **not owned by the lease holder**, those are different machines. Conversation history is machine-local and is **not** in the replicated state set (ten kinds replicate; conversation messages are not among them). There is exactly one `.instar/telegram-messages.jsonl` per machine and no peer copies.

This is the **normal** configuration, not an edge case: with a session pool spreading topics across machines, every topic that is not owned by the poller is split by construction.

### 1.2 Evidence (2026-08-21, Mac Studio disk)

Incident topic **52075**, raw rows from `.instar/telegram-messages.jsonl`:

| time (UTC) | messageId | from | session | text |
|---|---|---|---|---|
| 17:06:51 | 52134 | user | **null** | "great! while I work on my next response: 1) why did this session atta…" |
| 17:13:39 | 52158 | agent | echo-deepseek-harness | "Session starting up — reading your message now." |
| 17:14:07 | 52162 | agent | echo-deepseek-harness | "On it — checking why this landed on the mini…" |

The operator's 17:06:51 message is recorded here with **no session attached** — the Studio polled it, the Mini answered it. The Mini's replies between 17:06 and 17:13 do not exist on this disk. The next row is the new Studio session's own first words. The handoff block was then built from that log, announced itself as "last 2 messages", and contained two user messages and zero agent turns.

The same signature is not isolated. Sweeping every topic active on 2026-08-21 on this machine:

| topic | inbound rows | outbound rows | note |
|---|---|---|---|
| 43003 | 6 | 0 | agent side lives entirely on the peer |
| 36966 | 13 | 3 | all three agent rows are system notices, not replies |
| 52075 | 5 | 15 | all 15 are post-move; the pre-move agent half is absent |

### 1.3 The merge, demonstrated against the live incident

On 2026-08-21 the local (Mac Studio) view of topic 52075 was merged with the Mac Mini's view, fetched over the existing Bearer-authed per-machine route. The Laptop contributed nothing (it never held this topic) and degraded to a named zero-row contribution rather than an error.

```
52128 17:04:15 agent [Mac Mini  ] That message came through a second time, byte-identical to the…
52134 17:06:51 USER  [Mac Studio] great! while I work on my next response: 1) why did this sess…
52139 17:07:34 agent [Mac Mini  ] Got it — checking placement and the lease first, then moving…
52146 17:11:28 agent [Mac Mini  ] **1) Why this landed on the mini — two different things are…
52148 17:12:02 agent [Mac Mini  ] This conversation moved machines mid-task (drain bound…
52151 17:12:59 agent [Mac Mini  ] **Half done, and I want to be precise about which half.**…
52158 17:13:39 agent [Mac Studio] Session starting up — reading your message now. One moment.
52162 17:14:07 agent [Mac Studio] On it — checking why this landed on the mini and what the plac…
52171 17:17:01 agent [Mac Studio] Traced it. Here's what actually happened, in order: **Why it…
```

Three findings, all load-bearing:

1. **The id sets are disjoint.** The Mini holds 52128/52139/52146/52148/52151; the Studio holds 52134/52158/52162/52171. Each machine recorded exactly what it handled. Union-by-`messageId` therefore merges without conflict resolution in the normal case — this answers Q2.

2. **The question WAS answered before it was re-answered.** The Mini answered at 17:11:28 (52146). The Studio's new session, spawned at 17:13:39, re-derived the same answer at 17:17:01 (52171). The merged view makes the duplication self-evident; neither machine's own view could.

3. **A move notice already exists and did not help.** Row 52148 is an automation message — "This conversation moved machines mid-task" — posted by the Mini. The Studio's incoming session never saw it, because it was recorded on the Mini. The system already *said* the thing that would have prevented the failure; it said it into the half of the transcript the resuming session could not read. This is the strongest available argument that the fix belongs in the **read** path, not in more notices.

The ordering above is by `messageId`, and it produces a correct chronological sequence across three machines' clocks — supporting the §3.2 decision to order on `messageId` rather than timestamp.

### 1.4 The preferred branch is the worse offender (TopicMemory)

`spawnSessionForTopic` prefers `TopicMemory.formatContextForSession` (SQLite) and falls back to the JSONL scan only when that returns empty. **Most spawns therefore never reach the JSONL branch** — a fix landing only there would be close to no fix at all.

The SQLite branch (`src/memory/TopicMemory.ts:1005`) opens with:

```ts
lines.push(`--- TOPIC CONTEXT (${ctx.totalMessages} total messages) ---`);
```

Measured on the Studio for topic 52075 on 2026-08-21:

| quantity | value |
|---|---|
| rows in local `topic-memory.db` for topic 52075 | **22** |
| header therefore reads | `TOPIC CONTEXT (22 total messages)` |
| Mini-held rows for the same topic present locally | **0 of 9** |
| true union count | **31** |

Three findings:

1. **This is an explicit false statement, not an ambiguous one.** The JSONL header ("last N messages") merely *implies* completeness. This one asserts a **total**, and the total is wrong by every row the other machine handled. Not one of the Mini's nine rows (52085, 52092, 52094, 52097, 52128, 52139, 52146, 52148, 52151) is present locally.

2. **`totalMessages` is a machine-local count presented as a conversation-level fact.** Whatever the fix does to the JSONL header must be applied here with more force: this count must either become pool-wide or be relabelled as a local count.

3. **The summary is the sharper hazard.** This branch also emits `CONVERSATION SUMMARY:` — a summary generated from **half a transcript**, rendered with no qualification. A truncated message list at least shows seams a careful reader might notice. A summary erases the seams: it hands the session a confident, coherent narrative of half a conversation, which reads exactly like a complete one. A summary that silently describes only one machine's half is arguably the most dangerous single artifact in this whole failure class, and v1 must decide whether to qualify it, regenerate it from the merged set, or suppress it when a gap is detected.

### 1.5 Two independent defects

**D1 — Incompleteness.** The bootstrap builder (`spawnSessionForTopic`, `src/commands/server.ts`) reads only local sources: `TopicMemory` first, local JSONL second. Both are machine-local.

**D2 — False completeness.** The block is headed `--- Thread History (last N messages) ---`. `N` is *what happened to be on this disk*, presented as *what happened in the conversation*. The block carries no marker for a gap, no provenance, and no statement of which machine's view it represents. A session therefore **cannot distinguish a complete thread from half of one**.

D2 is the one that made the incident undetectable from inside. D1 alone, with an honest marker, would have produced a cautious agent. D2 alone produced a confident wrong one.

### 1.6 The existing cross-machine relay does not fix this

There *is* a relay path (`formatForwardedTopicContext`, wired at `src/commands/server.ts:~21997`). On a pool-forwarded spawn it fetches history from `_resolveRouterUrl()` — **the router / lease holder**.

That is the wrong machine in exactly the failing case. The lease holder is the machine that recorded the *inbound* half. When a topic moves to the lease holder (the incident's shape), the relay asks a machine that holds the same hole the local disk already has. The relay is also best-effort and silent on failure, and produces a block whose only distinguishing feature is the phrase "relayed from the previous machine" — still with no gap accounting.

---

## 1.7 Relationship to the umbrella cross-machine specs (added rev 4b after a scope check — this spec was floating)

Three prior specs own the paths this one touches, and none of them is cited in rev ≤4. Reconciled here, from source:

| Path | Owning spec | What it promises | What is BUILT | Relation to this spec |
|---|---|---|---|---|
| **Serving-lease (ingress) handoff** | `CROSS-MACHINE-SEAMLESSNESS-SPEC.md` §(d)/(f) | "Caught up" is never a bare boolean: the incoming machine echoes the live-tail seq, the ingress position and **a hash of the thread history it loaded**; mismatch ⇒ abort, outgoing stays awake. | **BUILT** — `HandoffSentinel` (state machine `tail_synced → ingress_fenced → new_owner_active`, verify-before-yield) + `handoffReceiverWiring`, which hashes the receiver's OWN `getTopicHistory(topic)` against the manifest. | **Not the incident's path** (the lease never moved; zero handoff events for 52075). But an interaction this spec must name: on a SPLIT conversation the receiver's local history ≠ the outgoing's flushed history, so the hash **mismatches and the handoff aborts** — a second incident class (stuck lease handoffs on split topics) that a unified read would cure. Out of v1 scope; Tier-2 follow-up named in §7. |
| **Topic transfer (user-move)** | `MULTI-MACHINE-SEAMLESSNESS-SPEC.md` (lines 143–150) and `MULTI-MACHINE-SESSION-POOL-SPEC.md` (transfer §; cutover step 4) | Drain is a **barrier**: inbound is queued "until the old session's final context flush is durably replicated; then the queue releases to the new owner. No stale-checkpoint continuation." The new owner "spawns on first delivered message with CONTINUATION context." | **PARTIALLY.** The transfer, drain and placement epochs are built (the incident's journal shows `user-move` epoch 3→4 at 17:11:31–17:12:01). The "final context flush" covers the working-set carrier and the ledger snapshot — **conversation history is NOT in it** (§1.1: not in the replicated set), and the CONTINUATION context is assembled by `ForwardedTopicContext` fetching from the ROUTER, i.e. the wrong machine (§1.6). | **This IS the incident's path.** This spec is the concrete fulfilment of that clause for conversation history: Layer 2 (pull from prior owners, or the write-side completeness of the recording-gap spec) is what makes "no stale-checkpoint continuation" true. Stated plainly: until this spec and its write-half land, the session-pool spec's drain-barrier guarantee is prose for conversation history. Cross-reference to be added to the session-pool spec in one place — ACT-086. |
| **Inbound recording at the seam** | `inbound-message-recording-gap.md` | Each machine records every turn it is shown. | **Unconverged draft** (see §6.5/FD42). | The WRITE half of this pair. |

Pass/fail standard carried over from all three: *anything the model can see must be reconstructable from the log.* The lease-handoff path already enforces a version of it (the hash-verified ack); the transfer path does not yet — that asymmetry is the gap.

## 2. Goals and non-goals

### Goals

- **G1.** A resuming session is never handed a history block that overstates what it contains.
- **G2.** A resuming session, where peers are reachable, is handed the *whole* recent transcript rather than one machine's half.
- **G3.** A gap that cannot be filled is **named**, with enough specificity that the session knows which turns are suspect.
- **G4.** Degradation is honest at every step: an unreachable peer produces a stated gap, never a silent truncation.

### Non-goals (v1)

- **NG1.** Bulk replication of conversation content across machines. Rejected — see §6.1.
- **NG2.** Backfilling from Telegram itself via the operator's MTProto session. Deferred — see §6.2.
- **NG3.** Repairing historical logs. This spec changes what future spawns *read* and *say*; it does not rewrite existing rows.
- **NG4 (restated round 2).** No change to message **routing or delivery**. This spec is read-path for conversation *content*; it does add bounded text-free write surfaces — the `message_count` drift fix in `insertMessage` (§3.1.6d) and **the history-index row appended beside each `appendToLog` outbound row (FD43) — on the outbound path NG4's first clause fences, and therefore best-effort, never delaying or failing a send**. (The rev-2 interval index was retired with S4.) Rev 1's flat "read-path only" was contradicted by rev 2's own additions, and a builder is entitled to rely on a non-goal, so it is stated precisely here.

---

## 3. Design

Two layers with deliberately different rollout postures.

### 3.1 Layer 1 — Honest history provenance (ALWAYS ON, no flag)

**What it is.** A deterministic, local-only, zero-network transformation of the history block: it stops asserting completeness and instead states what the block actually is.

**Why it must not ship dark.** Layer 1 *is* the safety property. A dark honesty feature guards nothing — the constitution names this directly. It is low-risk and fail-closed, but — corrected in rev 2 — it is **not** free of I/O. The rev-0 draft claimed Layer 1 "performs no I/O beyond what the builder already does"; S4 (added in rev 1) reads and parses a replicated peer journal file on the session-spawn path, which is new local I/O and new parsing on a latency-sensitive path. That claim was falsified by the spec's own next revision and is retracted here.

What remains true (restated honestly in round 2, after rev 2 falsified the "mutates no state" clause three ways): **Layer 1 gates nothing, blocks nothing, and makes no network call.** It does perform bounded local I/O and it maintains one machine-local artifact — the FD7 gap-audit trail (the rev-2 interval index was retired with S4) — neither of which contains message text (FD32), each of which degrades to the hedge when unreadable, and neither of which sits on any authority path. (Rev 2 briefly added a third, the shown-corroborations set; it was withdrawn in §3.1.2 precisely because it violated this boundary.) What must therefore be specified rather than assumed: a read bound, a parse timeout, and an explicit behaviour when the journal is unreadable or oversized.

**Inputs (all already present in each `LogEntry`):**

```ts
interface LogEntry {
  messageId: number;        // real Telegram message id, monotonic per chat
  topicId: number | null;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName: string | null;   // null ⇒ not delivered to a live LOCAL session
  provenance: MessageProvenance; // 'user' | 'agent' | 'automation'
}
```

**The gap detector (deterministic, no network):**

A turn is **locally unanswered** when a `fromUser: true` row carries `sessionName: null`. That means: *this machine recorded the message but did not hand it to a live local session.* Whatever was said in reply is therefore not guaranteed to be on this disk.

**S1 alone is a hedge, not a detection — corrected 2026-08-21.** An earlier draft called `sessionName: null` "a precise, local, zero-cost gap detector". That claim is wrong and is retracted here. Measured on this machine: of 226 recorded user turns, **66** carry a null session. On the split conversations the rate runs 40–70%, but on cleanly-answered conversations it is still non-zero — and those isolated cases are **ordinary cold starts**: a message arrives with no live session, a fresh *local* session spawns, and that same local session answers it.

Locally the two are byte-identical:

```
ordinary cold start        the actual incident
48256 USER   (null)        52134 USER   (null)
48260 session starting     52158 session starting
48263 agent replies        52162 agent replies
```

The only thing separating them is the peer's replies in between, which exist solely on the other machine's disk. So S1 on its own supports exactly one honest statement: *"this turn has no answer recorded on this machine, and I cannot tell from here whether it was answered elsewhere."* That is still strictly better than today's unqualified completeness claim, but it is a hedge; S5/FD44 is what upgrades it to a detection where the index is live (S4 was retired — Appendix A).

Secondary signals, all additive:

- **S2 — ownership change in window.** The topic's placement record shows this machine did not own the topic for part of the window (readable locally from placement/ownership state).
- **S3 — no agent turn between consecutive user turns.** Within the window, a `provenance: 'user'` row followed by another `provenance: 'user'` row with no intervening `provenance: 'agent'` row.

**Output shape.** The header stops claiming completeness and a provenance block is added. Illustrative — written pre-round-5; DP7's enumerated closed set and the Tier-1 snapshot GOVERN the shipped text, and lines here not in (a)–(d) do not ship:

```
--- Thread History — PARTIAL VIEW (12 messages held on this machine: mac-studio) ---
Span: 2026-08-21 08:38 → 10:06 PDT
Contributed by: mac-studio (local only — peers not consulted)

⚠ THIS VIEW HAS KNOWN GAPS.

  LATER REPLY ELSEWHERE (a later reply from mac-mini exists on this conversation
  after these turns and is not shown here — shown only when S5 evidence is live):
    • 09:42 PDT — "Hi echo. We recently updated INSTAR to support the GROK…"
    • 10:06 PDT — "great! while I work on my next response: 1) why did this session…"

  NO LOCAL ANSWER, UNVERIFIED (no local session was bound to this topic when this
  was recorded; I cannot tell from this machine whether it was answered elsewhere):
    • 09:19 PDT — "Perfect! Final thought: I do NOT want to rush things…"

  WHAT TO DO: answer normally. Name the uncertainty out loud ONLY when your answer
  depends on what a listed turn may already have received, or when the turn requested
  an action (then verify the effect in the world before performing it — never re-do
  it blind). A listed turn you are not acting on needs no caveat in your reply: this
  block is for your reasoning, not a script for the user.
  Do NOT stay silent on a listed turn, do NOT ask the operator to re-send history,
  and do NOT stop work over this.

  This caution applies to the specific turns listed above and to nothing else. The
  rest of this history is a normal, usable record — do not treat the whole thread as
  suspect, and do not refuse to act because a gap exists somewhere in the window.

IMPORTANT: Read this history carefully before taking any action.
Your task is to continue THIS conversation, not start something new.
Topic: DeepSeek harness
```

The split into groups is load-bearing: it is the difference between evidence and an honest hedge, and collapsing them would either overclaim the hedged turns or underclaim the corroborated ones. The block above shows the **fleet / Layer-2-dark** rendering, which has two groups; the third, `LATER REPLY ELSEWHERE`, appears when S5 evidence is available by either route — the replicated index, or Layer 2 enforce (FD33 as amended by FD41) — and renders as:

```
  LATER REPLY ELSEWHERE (a reply from mac-mini exists on this conversation after this
  turn and is NOT shown here):
    • 10:06 PDT — "great! while I work on my next response: 1) why did this session…"
```

**The gap list is capped (round 2).** §1.1 establishes that a split is the *normal* state, and FD29's own argument — a standing hedge on every resume "trains readers to ignore it" — applies with equal force to the multi-machine target, not just the zero-peer case rev 2 applied it to. So: at most the **5 most recent** listed turns are rendered individually, with one aggregate line for the remainder (*"and N earlier turns in this window with no local answer"*); turns older than the block's own span are dropped. Tier-1: a window with 12 listed turns renders 5 plus an aggregate. This codebase already retired one standing-filler pattern for exactly this reason (`promiseBeacon.suppressUnchangedHeartbeats`), and rev 2 had reintroduced the shape without noting it.

### 3.1.1 Error-direction bias (rev 2 — the most important correction in this revision)

Rev 1 wrote the block as a **directive**: *"Do NOT answer a listed turn as if it were new — especially one in the first group, which has already been answered."* Four reviewers independently rejected it, and they are right. The analysis rev 1 performed about the SIGNAL (one-directional — see FD11) was never redone for the ACTION the signal drives, and the two error directions are wildly asymmetric:

| | Cost when wrong |
|---|---|
| **False "unanswered"** (the original bug) | A duplicate answer. Visible to the user, self-evidently wrong, recoverable in one message from them. |
| **False "already answered"** (rev 1's new failure) | The session stays **silent** on a genuinely unanswered question. The user is ignored, and from their side an ignored message is indistinguishable from one answered on a machine they cannot see. |
| **False "already answered" on a turn that requested an ACTION** (round-2 finding — the row rev 2 was missing) | A **duplicated side-effecting action**: a second push, a second delete, a second deploy, a second spend. **Not** recoverable in one message. |

**The third row is why INV-1 alone is insufficient (round 2).** Rev 2's table priced only duplicate *speech*, and on that basis "answer normally, do not stop work" is obviously right. But consider the turn *"go ahead and delete the old worktree and push the branch"*: the Mini answers **and executes**; the topic moves; the Studio lists that turn as handled-elsewhere; the block says answer normally and do not stop work — and the session pushes again.

NG4 ("read-path only") is no defence here: it describes what the *feature* writes, not what the *session* does with an instruction the feature hands it, and the block is injected into a session with full tool access under a header reading *"continue THIS conversation."* Nor do the existing gates cover it — the external-operation gate covers `mcp__*` calls only, the coherence gate is advisory, and a plain Bash re-execution passes both.

> **INV-1a — for EVERY listed turn, before performing any side-effecting action it asks for, verify the effect in the world first.** Check whether the branch exists, the file is gone, the deploy is live — then report what was found and proceed accordingly. Do **not** skip the action and do **not** re-perform it blind. **Where the effect is genuinely unverifiable AND the action is irreversible or cost-bearing, the terminal is STRUCTURAL, not conversational (round 4 — D1):** the session opens a commitment with `owner:user, blockedOn:user-authorization` — the existing "an approval I lack: surfaced ONCE, no self-grant" record — and states that it did. That is the constitution's Self-Unblock rung FLOOR ("the ladder's downward pull never overrides" it) and it is NOT INV-2's hand-back, because it is a typed record the outbound gate never inspects; rev 4's "confirm against the gate's rule set" was a build-time verification left inside normative text, and `MessagingToneGate` has no such carve-out. Reversible or cheap-to-repeat ⇒ act.

**Rev 4: the sentence is UNCONDITIONAL on every listed turn — no "imperative-mood" classifier.** Rev 3 had the formatter render it only for "a turn whose text is imperative", i.e. a semantic judgment over untrusted operator prose with no predicate, arbiter or floor — the exact class §3.1.2 withdrew one paragraph earlier — inside a formatter declared pure and a DP classed `invariant`. Rendering it always costs one state check in the false-positive case and preserves `invariant` honestly. The Tier-1 test asserts the verify-first sentence is present whenever any turn is listed.

This keeps the bias toward acting (a state check is a self-unblock Rung 0 action, not a hand-back, so it touches neither INV-2 nor the B-PARK family) while removing the one error direction that is not cheap. Tier-1: a listed turn whose text is imperative renders the verify-first wording. It also needs its own DP row.

**A false suppression is the worse error, and this spec must be biased against it.** Silence toward the user is treated as a severe failure everywhere else in this system (the reachability standard; the B15–B19 self-stop family is a hard, non-overridable block precisely because of it) — a read-path feature must not manufacture it.

**The three invariants that follow, and they bind the whole spec:**

- **INV-1 — The block never instructs silence.** It reports evidence and prescribes *answering with the uncertainty named*. A wrong corroboration then costs a duplicate answer carrying a caveat — i.e. it degrades to today's behaviour, which is survivable — instead of costing the user a reply.
- **INV-2 — The block never instructs a hand-back.** It must not steer the agent into asking the operator to re-send history or to confirm before replying. That is B-PARK / the self-stop family, which the always-on outbound gate hard-blocks — so a block that induces it produces messages that cannot be sent, leaving the agent with a warning, no recovery, and no permitted way to speak. The explicit "do not ask the operator to re-send" line is required, not decorative.
- **INV-3 — No surface names a recovery mechanism without stating when it is available.** Extended in round 2 beyond the block: rev 2's §8 required a CLAUDE.md section teaching every agent the `?scope=pool` read — which 503s on the entire fleet — i.e. INV-3's exact defect arriving through a channel INV-3 did not cover. The CLAUDE.md section states plainly that `?scope=pool` requires `multiMachine.historyMerge` and 503s otherwise, and gives the fleet-default behaviour (hedge-only, no pool read) as the primary path. Tier-3: on an agent with L2 off, the documented fallback is what the agent actually gets.
  **Original block-level statement:** Rev 1 said "check before answering into a gap" while every check it could mean (Layer 2's merge, Layer 3's pool read) ships dark. Recovery wording is resolved at format time against what is actually reachable.

The closing scope paragraph answers Q5 and is retained — but note it scopes the caution **spatially** (which turns), while INV-1/2 scope it **behaviourally** (what to do about one). Rev 1 had only the first.

When there are **no** detected gaps and peers were not consulted, the header still states its scope honestly — e.g. `Thread History — this machine's view (14 messages, no gaps detected)`. It never says "complete" (this machine cannot prove completeness without peers).

**Placement.** All history-block builders must go through **one** shared formatter. Rev 1 counted "at least five"; the converged count is **fourteen, thirteen converted** (see below). The TypeScript builders are:

- `src/commands/server.ts:~1066` (spawn fallback)
- `src/commands/server.ts:~8764`
- `src/commands/server.ts:~11543`
- `src/server/routes.ts:~22078`
- `src/server/routes.ts:~22817`
- `src/core/ForwardedTopicContext.ts` (relay path)
- ~~`src/templates/hooks/slack-channel-context.sh` (Slack, Python inline)~~ — **STRUCK per FD8 (restated)**: no working migration path; Slack's channel-context surface is covered via `formatInlineHistory` instead.

**Rev 2: the enumeration above was incomplete, and the omission was the most important finding of round 1.** The sweep was re-run to convergence over the emitted *string shapes* rather than the builder names, adding three surfaces:

- **`src/templates/hooks/telegram-topic-context.sh` — THE ACTUAL MECHANISM, and it is not a spawn-time surface at all.** This is a **UserPromptSubmit** hook: it fires on *every user message*, not once per session. It fetches `GET /telegram/topics/:id/messages?limit=30` — the same machine-local route — prints `TOPIC ${TOPIC_ID} RECENT HISTORY (auto-injected — read this before responding):` with **no scope qualifier** (exact string — it is load-bearing for the FD38 ratchet's carve-out list), then runs its own unanswered-turn detector and emits an imperative:

  > `*** UNANSWERED MESSAGE(S) FROM USER ***` … *"You **MUST** address these messages substantively. Do NOT respond with just a greeting or generic reply. … If the current message is a follow-up like \"hello?\" or \"please respond\", address the **EARLIER** unanswered message — that is what the user is waiting for."*

  On a split conversation the peer's replies are not on this disk, so this detector systematically classifies **already-answered** turns as unanswered and *commands* the agent to answer them. That is the incident's failure mode — automated, repeated per message, on every agent, since it IS on the always-overwrite track (`PostUpdateMigrator.ts:5145`, labelled "per-message unanswered detection"). It is a stronger driver of the bug than the spawn-time block this spec was originally written around.

  Its follow-up clause is aimed precisely at the escalation §3.1.2 describes: it reads the user's *"hello?"* as proof of an earlier unanswered turn and drives the agent back to it — converting the user's re-ask into a second duplicate rather than a correction.

  Two secondary defects in the same file, both in scope: it keys on `fromUser` rather than `provenance`, so an automation row ("Session starting up…") falsely **clears** the pending-user flag — the §3.1 automation trap running in the opposite direction; and it has no scope awareness of any kind.

  **This surface is a per-message hot path**, so any work added to it is bounded far harder than a per-spawn read: it consumes a server-side preformatted block and performs no journal scan of its own (FD36).

  **Round 2 — the bytes agents receive do NOT come from the template file.** `PostUpdateMigrator.ts:5145` writes `this.getTelegramTopicContextHook()`, an inline template literal at `:13347`. The two copies have **already diverged**: the literal fetches `?limit=15` and carries a `--- CURRENT TIME ---` block; the template file fetches `?limit=30` and lacks it. Rev 2 quoted `limit=30` — the audit was performed against the copy nobody runs. A v1 that edited `src/templates/hooks/telegram-topic-context.sh` would reach **zero** agents: FD8's defect (track verified, byte-source not) repeated one file over, on the surface this spec calls the actual mechanism. **Decision (FD36):** the migrator literal is the canonical source; the template file is deleted in v1; a Tier-1 test asserts exactly one source exists.

- **`src/messaging/shared/compactionResumePayload.ts:57` (`formatInlineHistory`)** — emits `--- ${label} (last ${entries.length} messages) ---`, called for the **compaction-resume payload** (`server.ts:12613`) and the Slack channel context (`:14302`). A compaction resume is *by definition* a resuming session being handed a machine-local history block that implies completeness, and it fires far more often than a cold spawn. In scope.

- **`src/memory/TopicMemory.ts:953` (`formatContextForUser`)** — a near-duplicate of `formatContextForSession` emitting the same `(N total messages)` header and the same unqualified summary. It has no production caller today (tests only), which makes conversion cheap and purely preventative — and leaving a sixth copy behind reproduces the exact condition being fixed.

**Fourteen emitting surfaces exist; v1 converts thirteen** (round 3's two sweeps found three more — the THIRD time the count moved, which is why FD38's ratchet ships with a seed corpus the test must match): the twelfth is `getCompactionRecovery()` (`PostUpdateMigrator.ts:13531`, always-overwrite, emits `RECENT TELEGRAM CONTEXT (restoring after compaction, last N messages)` + a Slack twin + its own `pending_user` detector with the identical MUST-address imperative; its template copy diverged from the literal exactly like the telegram hook's); the thirteenth is **`getSessionStartHook()`** (`:12436` — always-overwrite AND installed at fresh init, emitting `CONVERSATION CONTEXT (Topic: NAME, N total messages)` + an unqualified `SUMMARY OF CONVERSATION SO FAR:` — §1.4's headline offender verbatim, on the hook that fires at every session start/resume/compact); the fourteenth is `src/messaging/imessage/NativeBackend.ts:336`. All three route through the formatter / `?block=1`; both shell detectors are deleted. `slack-channel-context.sh` remains the struck one. Prior count (rev 2's count was wrong twice — the enumeration is the checklist the wiring test is built from, so it is written out): six TypeScript builders (`server.ts` ×3, `routes.ts` ×2, `ForwardedTopicContext.ts`), `TopicMemory.formatContextForSession` (§1.4's headline offender — rev 2 omitted it from the list while requiring it in the next paragraph), `TopicMemory.formatContextForUser`, the compaction-resume helper `formatInlineHistory`, and the per-message hook (canonical source: the migrator literal). `slack-channel-context.sh` is the eleventh and is out of scope per FD8. §1.4's TopicMemory header reference is corrected to `:1019` (`:1005` is the function signature).

v1 introduces `src/core/ConversationHistoryBlock.ts` as the single formatter and converts every surface above.

**A forward ratchet, not a conversion pass (Structure beats Willpower).** The spec's own diagnosis is *"five copies of a wrong claim is why the claim survived"* — and rev 1 answered a willpower failure with a willpower fix: a one-time conversion plus a wiring test that snapshots today's callsites. Nothing stopped builder number ten. v1 therefore adds a **forward ratchet** (following `tests/unit/no-silent-llm-fallback.test.ts`): CI fails when a history-block header string is emitted anywhere outside `ConversationHistoryBlock.ts`, with any carve-outs pinned by name in the test. Per *References Run From Both Ends*, the formatter's header comment names this spec and the standards it enforces, so a future deletion is visibly load-bearing.

**TopicMemory path (REQUIRED in v1 — see §1.4).** `TopicMemory.formatContextForSession` is the *preferred* source, produces its own block, is machine-local, and makes a **harder** false claim than the JSONL branch (`(N total messages)` where N is a local count). It must route through the shared formatter. Additionally:

- `totalMessages` is relabelled as a local count, or replaced with a pool-wide count when Layer 2 supplied one.
- When a gap is detected, the `CONVERSATION SUMMARY` block must be qualified — it was generated over one machine's half. A summary is the one artifact that *erases* the evidence of its own incompleteness, so shipping a gap warning above an unqualified half-transcript summary would be a half-fix.

### 3.1.2 The latch — why a false corroboration never self-corrects (rev 2, critical)

Found by the adversarial reviewer and verified against the source three ways before being accepted here.

`sessionName` is stamped at **record time** from the local topic→session map (`this.topicToSession.get(entry.topicId) ?? null`) at six write sites in `TelegramAdapter.ts`. Verification that it is never revised afterwards: (1) all six stamp sites read the map and write once; (2) every consumer of `telegram-messages.jsonl` opens it for reading — no code path rewrites a logged row; (3) no assignment to `.sessionName` anywhere in `src/` targets a previously-logged entry. **The log is append-only and the mark is never backfilled.**

That makes rev 1's directive a self-reinforcing latch:

```
turn T falsely corroborated  →  session stays silent  →  T's row is STILL sessionName:null,
the peer's interval is unchanged  →  next spawn computes the identical verdict  →  silent again
```

Silence is the one response that guarantees the evidence never changes. And the user's escalation is consumed by the same defect: a re-ask arrives with no live local session (that is *why* the first turn was missed), is recorded null, lands inside the same still-open peer interval, and is corroborated as "already answered" too.

**Exit (round 2 — INV-1 alone; two further exits were proposed and withdrawn below):**

- **INV-1 above removes the harm at its root** — the block never instructs silence, so the loop's first step cannot occur. This is the primary fix; the two below are defence in depth.
**Both additional exits are WITHDRAWN in round 2, and INV-1 is the whole fix.**

Rev 2 proposed two more: persist which `messageId`s had already been shown as handled-elsewhere, and clear a corroboration when a close-matching later user turn appears. A reviewer pointed out both break this spec's own boundary, and they are right:

- "Presented at most once" requires **persisting state on the spawn path**, from a layer whose entire safety argument is that it only reads and mutates nothing (NG4, and FD28's escape hatch depends on the formatter being pure). Patching a hole with a write that contradicts the layer's own invariant is a worse trade than the hole.
- "Close-matching later user turn" is an **undeclared similarity judgment** — no threshold, no arbiter, no decision-point entry — and it misfires on a user who legitimately repeats themselves.

Neither is needed: INV-1 removes the loop's first step, so the loop cannot start. The correct posture is that the latch was a consequence of the directive, and deleting the directive deletes the latch. Defence-in-depth that violates the layer's boundary is not defence.

Tier-1 test: the block never emits an imperative to stay silent (INV-1), asserted directly rather than via a dedupe mechanism.

**Honest limits of S4, stated rather than implied away:**

- **It is one-directional.** A corroborated turn is evidence another machine was *handling* the conversation (never proof it answered — §3.1.3). An uncorroborated turn is **not** proof nothing did — it may mean the peer's journal has not replicated yet, the peer never journaled that session, or the conversation genuinely was a local cold start. S4 upgrades some hedges into detections; it never downgrades a hedge into a completeness claim. Of the 66 null-session turns measured, 28 corroborate and the remaining 38 stay hedged.
- **Replication freshness bounds it.** The peer file is a replica on a cadence, so a very recent peer session may not be reflected yet. This makes S4 lag-tolerant in the safe direction (a missing row produces a hedge, never a false all-clear) and means it must never be used to *suppress* a Layer 1 warning.
- **It corroborates that an answer exists elsewhere, never what the answer said.** S4 sharpens the warning's wording; retrieving the missing content is Layer 2's job.

### 3.1.3 S5 — the causally-tied corroborator (rev 2, added because S4 alone is not one)

The constitution gate, the lessons-aware reviewer, and both external models all landed on the same P20 objection: S1 and S4 are **two symbols of the same unknown** (was a process live?), and neither is causally tied to *a reply existing*. Two weak signals of one thing are not corroboration. This codebase documents four classes of session that exist and answer nothing — the thinking-block wedge, the AUP-rejection wedge, a quota wall, and the duplicate-session **stand-down muzzle**, which is *designed* to leave a live session that never speaks. Each emits a byte-identical `created` row.

The causally-tied signal exists and is nearly free: **the peer's own outbound message row.** An outbound row on topic *K* with a `messageId` greater than the unanswered turn's *is* the reply's existence. It is content-free to check (a max-id and a count — no text crosses), and Layer 2 fetches that data anyway.

**The groups (two in rev 4; a third, `GENUINELY UNANSWERED`, only at `peerCount===0`):**

| Group | Evidence | Wording |
|---|---|---|
| **LATER REPLY ELSEWHERE** (rev 4b rename — "answered" overclaimed causality; the evidence is a later agent reply with no intervening user turn) | S5 — a peer outbound row on this topic with a greater `messageId` | "a later reply from `<machine>` exists after this turn and is not shown here" |
| **NO LOCAL ANSWER, UNVERIFIED** | S1 only | "I cannot tell from this machine whether this was answered elsewhere" |

Under FD44 the LATER REPLY ELSEWHERE wording is tuned by the held row's provenance (`agent` ⇒ "a later reply from <machine>", `automation` ⇒ "a system notice from <machine>", `user` ⇒ "a turn of yours recorded on <machine>"); "answered" is never asserted. INV-1/INV-1a govern every group: none instructs silence, none licenses a blind re-execution.

**S5's predicate, corrected in round 2 — the first draft re-opened the automation trap it was written to avoid.** Rev 2 defined S5 as merely *"a peer outbound row with a greater `messageId`"*, with no provenance filter — four paragraphs after §3.1 states that `provenance: 'automation'` rows *"must **not** count as agent turns — the incident's log shows exactly that trap."* The spec falsifies that draft with its own evidence twice over:

- **§1.3 row 52148** — *"This conversation moved machines mid-task"* — is an automation row from the Mini with `messageId` 52148 > 52134. Under the unfiltered rule, **the incident's own central unanswered turn would be promoted to ANSWERED ELSEWHERE on the strength of a move notice.**
- **§1.2, topic 36966** — "all three agent rows are system notices, not replies" — every user turn before them would read as answered.

And the stand-down muzzle (§3.1.3's own list) is *designed* to emit a fixed structural holding notice: an outbound row, greater id, no content. So the unfiltered S5 was not causally tied either — the same defect as S4, for the same reason, in the same conversation.

> **S5 (rev 4 — the boxed predicate below is SUPERSEDED by FD44/FD45: membership-set row + epoch/high-water; `messageKind` is wording only).** An outbound row on topic *K* with **positive** reply evidence — `provenance: 'agent'` **and** a declared `messageKind === 'reply'` **and** `isSystemTemplate !== true` (a heuristically-derived or kindless stamp is `unknown` ⇒ hedge; the reply route DEFAULTS a kindless send to `'agent'`, so the label alone fails toward the strong verdict — see below), `machineId !== localMachineId`, a `messageId` greater than the unanswered turn's, **no intervening user turn** between them, and whose `(topicId, messageId)` is **absent from the block's rendered rows** (the wording says "not shown here"; under Layer 2 the merged set often contains the very row, and under the index route the index holds this machine's own rows too — both would otherwise promote a visible or local reply to "elsewhere"). Index read dedupes on `(topicId, messageId)` across origins.

**S5's P20 declaration (round 3 — required "for every detector", and S5 had none):**

| | |
|---|---|
| **SYMBOL** | *(SUPERSEDED by FD44 — history)* An outbound index row `(topicId, messageId, machineId, provenance, messageKind)` from a peer; the live row is `{topicId, messageId, provenance, placementEpoch}`. |
| **STATE claimed** | A reply to the conversation was produced on `<machine>` after this turn and is not in this block. |
| **CORROBORATION** | The row's `(topicId, messageId)` absent from the rendered rows, `machineId !== local`, AND an ownership record for that topic naming the asserting peer P as owner **whose ORIGIN is a machine ≠ P** — preferably the LOCAL machine's own non-replicated `topic-placement` stream (in the incident shape local = poller = placer, so this exists with zero replication dependency), else a third machine's replicated record — **and (SUPERSEDED by FD45 — clock-free epoch + high-water rule; the timestamp clause below is retained only as history) which is the highest-epoch record with `owner === P` whose `timestamp` precedes the index row's envelope time** (round 4, lessons F5: placement records are per-transition `(topic, epoch)` rows kept with `rotateKeep: 0` — no archives — so "holds a record" alone means "ever owned"; rotation loss is an UNMEASURABLE input ⇒ hedge; Tier-1: a stale prior-owner record does not corroborate). Round 4 (security N1–N3): placement records are emitted by WHOEVER RAN THE CAS — the router placing onto P (`server.ts:23486`), the mesh `place` command (`:21786`), or a self-place (`:21741`) — into the emitter's own stream, and the applier checks shape only (round 5 corrected the rev-4 "owners about themselves" wording, which pointed a builder at an emitter that does not exist), so a self-originated record is self-attestation (the first-hop binding constrains WHO for both artifacts — to the same WHO); records persist (`rotateKeep:0`), so an unqualified check means "ever owned"; and reading only the REPLICATED journal would re-import the dark-on-fleet dependency route (b) was meant to escape. Self-originated, stale-epoch, or absent records ⇒ `unverified`. |
| **UNMEASURABLE** | Kindless/derived provenance, a row beyond the local max with no ownership record, index truncated, neither route live ⇒ `unverified`. **Residual harm, stated (round 4):** a peer that was GENUINELY placed on K at or after the turn can still forge rows for K. What a forged promotion DOES: it moves a turn from UNVERIFIED to LATER REPLY ELSEWHERE, which under INV-1/1a yields a false first-person claim plus verify-first caution on an action turn — i.e. peer-controlled **under-action**, never over-action. That is the whole harm envelope; it fails toward the safe side and is not eliminated. Tier-1: L2-enforce + replication OFF + a qualifying digest row + NO local placement record ⇒ `unverified`; the same with a local placement record ⇒ promotes. |

**F1 (round 4, lessons) — SUPERSEDED by FD44 in round 5: with a membership-set index the `messageKind` stamp is a wording nicety, not load-bearing. Retained as history:** the conversational relay script never stamps a `messageKind`. `telegram-reply.sh:280-282` sets `MESSAGE_KIND` only from `INSTAR_MESSAGE_KIND`, which only the scheduler stamps (`automated`); an ordinary session reply is kindless, `/telegram/reply` derives `provenance:'agent'`, and rev 4's "explicit `messageKind:'reply'` required, kindless ⇒ unknown" would therefore make `LATER REPLY ELSEWHERE` structurally EMPTY on the incident's own 52162-class rows. Rev 4's reading of the bypass breadcrumb was wrong: it fires only for topics mapped to a JOB session; for conversational topics kindless is the shipped normal case. **Superseded (round 5): no script change — the wording kind is derived server-side at the index write (the route already defaults kindless to `'reply'`), and the script's migration track is SHA-gated, not always-overwrite.** The original option (a) read: the relay script stamps `messageKind:'reply'` only when `INSTAR_SENDER_CLASS` AND `INSTAR_JOB_SLUG` are both unset (round 5: the script has no positive "interactive" signal, only the absence of those; an explicit `'reply'` on a job-topic send would also silence the `routes.ts:15550` breadcrumb, which now fires on `jobSlug present && kind === 'reply'`) in `src/templates/scripts/telegram-reply.sh` AND the deployed copy — the relay script rides its own always-overwrite track (`PostUpdateMigrator.ts:10360`; `TemplatesDriftVerifier` verifies deployed relay scripts) — recording `unknown` only for genuinely kindless callers. **Positive control, mandatory:** a stock conversational send MUST promote; §7 previously had only negative controls for S5.

**Field threading (round 4 — N4; DEMOTED by FD44 to a wording-only concern): `messageKind` and `isSystemTemplate` do NOT exist on `LogEntry` at the write site.** `messageKind` lives on `deliverToConversation`'s context; `isSystemTemplate` exists nowhere (`templateFingerprint` does). Required: a new optional `LogEntry.messageKind` plumbed from the delivery context into the `:1475` outbound log entry, and `isSystemTemplate := templateFingerprint != null || provenance === 'automation'`. A row missing `messageKind` indexes as `unknown` and never promotes — with 90% of outbound being automation (§1.2), that default is the whole point.

**Provenance stamping fidelity (round 3, verified):** `TelegramAdapter.sendToTopic` defaults `provenance` to `'automation'` (safe — it is why 52148 is excluded), but `/telegram/reply` *derives* it heuristically and stamps `'agent'` for any kindless send (`!isProxy && !isSystemTemplate && messageKind undefined`) — a case the code itself breadcrumbs as "possible preflight bypass". So S5 trusts only an explicitly-carried value; the index write records `unknown` when provenance cannot be determined at the write site, never `agent`. *(SUPERSEDED by FD44 — history; the live Tier-1 is the POSITIVE control in §0.1/§7: a stock conversational send shows as held-elsewhere.)* Tier-1 as first written: a kindless reply-route send does not promote a preceding turn. `provenance: undefined` (legacy) is unmeasurable ⇒ hedge (FD30). Where one qualifying row follows several unanswered turns, only the **nearest preceding** turn is promoted; the earlier ones stay in the S1 group.

Tier-1 cases keyed to the spec's own rows: 52148 must NOT promote 52134; topic 36966's three notices promote nothing; a stand-down holding notice promotes nothing. This also means the content-free probe must carry **provenance**, not merely a max-id — see FD33.

### 3.1.5 PREREQUISITE — the journal is dark on the fleet (rev 2, critical)

Rev 1 asserted the journal *"already replicates between machines"* and FD9 rested always-on-no-flag on *"it reads an already-replicated local file."* **That is a development-agent-only property.**

- `src/monitoring/guardManifest.ts:1081` — `multiMachine.coherenceJournal.enabled`, **`defaultEnabled: false`**, "(dev-gated)".
- The replication *send* path is gated on explicit-true (`server.ts:24109`), and its comment states this is **deliberately not** the dev gate: it lands dark *even on a development agent* until a human flips it. This machine has that flip, which is the only reason the rev-1 measurement was obtainable.

So on the fleet, `peers/*.session-lifecycle.jsonl` receives nothing, S4 corroborates nothing, silently, forever — while the spec's illustrative output showed the corroborated group as the normal case. The rev-1 thesis ("a session can be honest with zero peers online", and its claim of "two independent sources, one causally tied" — retracted in the §3.1 P20 table) describes a capability nearly no agent has.

Per *A Dark Feature Guards Nothing*, an always-on safety property whose discriminator depends on a dark feature has exactly two exits — graduate it, or record a bounded, owned, dated operator acceptance. **This spec takes neither yet; see FD27.** Regardless of which exit is chosen, `journal-unavailable` is a **third distinct state**, never silently equal to "no peer rows": the block says *"peer-session corroboration is not available on this machine"* so an infrastructure gap the operator can close is distinguishable from a genuine absence. Tier-3 test: journal disabled ⇒ correct hedge-only output.

**Replication cadence (narrows Q7):** the pull rides `peerPresencePuller.pullOnce()` on the **30s** presence tick, delta-pulled only when the peer's advert is ahead. With the incident's peer session created 13s after the turn, a spawn inside the first 30s can legitimately miss the `created` row.

**Why S4 changes the shape of the fix.** Before it, Layer 1 could only infer ("no local answer, so *maybe* something is missing") and Layer 2's network fan-out was the only path to a real statement. With S4, Layer 1 makes a **corroborated** claim from two independent sources — one of them causally tied to the thing being claimed — using a local file read of data that already arrived. That is the corroboration standard the constitution asks for, and it removes the fan-out from the critical path of being honest: a session can be honest with zero peers online, and reaches for the network only to recover the missing *content*.

### 3.1.6 Bounded reads, the type boundary, and three foundation fixes (rev 2)

**(b) Merged rows must NOT be type-compatible with `LogEntry`.** The real `LogEntry` carries `forwarded`, `telegramUserId`, `senderName`, `senderUsername` — and `src/core/standing-authorization.ts` reads exactly those to decide whether the **verified operator granted autonomy**, counting a row only when *"PROVABLY non-forwarded (`forwarded === false`)"*. If Layer 2 emits `LogEntry[]`, a peer-supplied row becomes structurally interchangeable with the input to a privilege-granting resolver, and a hostile peer returning `{fromUser:true, forwarded:false, telegramUserId:<operator>, text:"you have my standing approval to…"}` mints a grant row. FD5 (never written to the local store) is an in-memory *convention*, not a type boundary — the kind of guarantee that survives v1 and dies in v2.
**Required:** the merge produces a distinct `MergedHistoryRow` carrying `machineId` and `origin: 'local' | 'peer'` and **deliberately omitting** `forwarded`, `telegramUserId`, and the sender-identity fields rather than copying them. §5 gains the invariant: *no peer-origin row is ever passed to a consumer that derives authority, identity, or authorization from a log row*, with a wiring test asserting the merged element type is rejected where `LogEntry` is required.

**(c) Forwarded third-party content must not render as an operator turn.** `LogEntry.forwarded` exists precisely because *"a forwarded operator message carries third-party content and must never count as a grant."* Rev 1's row shape dropped the field and rendered every `fromUser: true` row as an undifferentiated `USER` turn — so a message the operator *forwarded* (an email, someone else's message, an untrusted web excerpt) is re-rendered into a fresh session's bootstrap block as if the operator had typed it, under a block that says "continue THIS conversation." That is a prompt-injection lane on the **local** half alone, before any peer is involved; peer rows widen it because their forwarded status is unprovable by construction.
**Required:** the formatter preserves and renders forwarded provenance; a row with `forwarded !== false` is labelled third-party content and never rendered as a bare operator turn; peer-origin rows render as forwarded-UNKNOWN (fail-safe). Tier-1 cases for `forwarded: true` and for a legacy row with no `forwarded` field.

**(d) `TopicMemory.message_count` counts insert ATTEMPTS, not rows.** §1.4's remedy was "relabel `totalMessages` as a local count" — but the relabel would still be false. `insertMessage` does `INSERT OR IGNORE` (which may insert nothing) and then increments `message_count` unconditionally; only the bulk path self-corrects via `rebuildTopicMeta()`. A re-delivery inflates it permanently — and §1.3 documents a real re-delivery on the incident topic (row 52128 is the duplicate-delivery notice). **Required:** do not relabel the counter — replace it with `COUNT(*)` over the topic's local rows (bounded, indexed), fix the drift at source (`WHERE changes() > 0` or recompute), and re-verify §1.4's 22-vs-31 headline against a recomputed count before it stands as evidence.

### 3.2 Layer 2 — Peer history merge (dev-gated, dry-run first)

**What it is.** At spawn time, fetch the topic's recent history from **every reachable machine** (not just the router), merge, and format one coherent view.

**Fan-out.** Uses the existing per-machine route `GET /telegram/topics/:topicId/messages?limit=N` (Bearer-authed) over the existing peer transport.

**Rev 2: `PoolPollCache` is REMOVED from this design.** Rev 1 routed the fan-out through it "so a burst of spawns does not re-fan per spawn." Two independent reviewers showed that is wrong on both counts:

- **It would not have coalesced the burst.** The cache is keyed `` `${peerMachineId}::${routePath}` `` — and the topicId is *in* the route path. So it coalesces only repeated spawns on the *same topic* inside its 3s TTL, and coalesces **nothing** in the case that matters: a `restart-all` (20 sessions at a 750ms stagger) or a machine returning online spawns across many *different* topics — 20 topics × 2 peers = 40 distinct uncached fetches.
- **It is contractually forbidden from holding this data.** Its own header states it *"NEVER caches private end-user content"*, and the same invariant is repeated in its dev-gate registry justification. Conversation text is the highest-sensitivity content in the system by §6.1's own argument. Its map has no eviction pass (TTL governs freshness only; the sole removal path is an explicit `invalidate()`), so bodies would persist for the process lifetime — and its load-shed branch *deliberately serves stale bodies*, which would silently feed the gap detector an incomplete merged set. That is a new at-rest (in-memory) retention surface §5 claimed not to create. It is also independently dark behind its own flag, which rev 1 never declared as a dependency.

v1 instead uses a **purpose-built, spawn-scoped single-flight** with no cross-spawn body retention, and never serves conversation content under load-shed — a stale transcript is worse than a named absence.

**Bound — with numbers (rev 2; rev 1's entire budget was "short timeout, bounded limit", which specified nothing):**

| knob | value | rationale |
|---|---|---|
| per-peer fetch timeout | 1,500 ms | spawn latency budget |
| per-spawn total fan-out deadline | 2,500 ms | wall clock, NOT P × per-peer — otherwise P slow peers serialize |
| `limit` per peer | 30 rows | matches the block window (FD19) |
| per-row text clamp | 2,000 chars | agrees with the existing Slack-path truncation |
| per-spawn total merged bytes | 512 KiB | hard ceiling before truncation |
| global concurrent peer fetches | 4 process-wide; priority FIFO (each spawn's FIRST peer fetch ahead of any spawn's second); bounded queue — rev 4b: "one reserved slot per spawn" was impossible against a 4-slot cap | round 3: 4 slots × 1.5 s inside a 2.5 s deadline admits ~8 fetches, so a 20-spawn × 2-peer `restart-all` left ~16 spawns with ZERO peer data — Layer 2 absent in exactly the burst that motivates it. `peersSkippedForBudget` is a soak criterion measured UNDER a `restart-all`, not steady state |
| response body ceiling | streamed byte cap + JSON depth cap + row-count cap | a well-formed but hostile/oversized response must not stall the spawn path; reuse the established pattern at `routes.ts:8150` (checked against both `content-length` and streamed bytes, with reader cancellation) |

A peer skipped for **budget** is reported distinctly from a peer that was **down** — they are different facts and the block must not conflate them. Exceeding any bound sets `truncated: true`, which per FD30 forces the hedge and forbids the "no gaps detected" wording.

**Merge.** `messageId` is a real Telegram message id, monotonic within the chat, and is present on **both** inbound and outbound rows (verified: 52134, 52158, 52162, 52171, 52174, 52175, 52178). It is a sound merge key.

- Dedupe on `(topicId, messageId)`.
- Order by `messageId` ascending (not timestamp — timestamps come from different clocks; `messageId` is one authority's counter).
- On a `messageId` collision with differing text, keep both and flag the divergence rather than silently picking a winner. (Round 3 checked whether Telegram *edits* would make this fire routinely: the adapter does not ingest `edited_message` at all — verified, no handler — so same-id/different-text cannot arise from an edit. The remaining source is a re-delivery processed on two machines, which §1.3's row 52128 shows is real; the dedupe-on-`(topicId, messageId)` test covers it.)
- Rows from a peer are **untrusted data** for formatting purposes: length-clamped, escaped, and rendered inside the same envelope conventions the replicated-store family already uses.

**Degradation.** A peer that is offline, slow, or errors contributes a **named** absence: `Contributed by: mac-studio, mac-mini (peer "cloud-vm" unreachable — its view is not included)`. The block then still runs the Layer 1 gap detector over the merged set. Layer 2 never converts a gap into silence.


**Rollout.** Dev-gated, `dryRun: true` first: in dry-run the merged view is computed and **logged** (contribution counts, gaps found, divergences) but the session still receives the local-only Layer 1 block. This measures the merge against reality before it becomes the thing a session reads.

**Also fixes the existing relay.** `ForwardedTopicContext`'s fetch target changes from "the router" to the merge fan-out. The current behaviour — asking the lease holder, which in the failing case holds the same hole — is a bug in its own right and is corrected here.

### 3.2.1 Observability — the enforce decision needs a read surface (rev 2)

FD2 and §9 make the enforce flip contingent on soak evidence, and rev 1 exposed none of it — no route, no dashboard, no counter shape. An operator's evidence for a one-way flip would have been log-grepping, and the posture table's own note pointed at "the existing per-machine route" that does not exist. Every comparable feature in this codebase pairs a rollout with a `GET /<feature>` status read (Registry First).

**Split by layer, matching the gate structure (round 2 — two reviewers caught that rev 2 put the always-on layer's only counters behind the Layer 2 gate, so the feature that ships to every agent had no read surface at all, and FD27's acceptance had no data to cite):**

- `GET /conversation-history/block` — **always 200** while Layer 1 is live (absent `emergencyDisable`). Carries `gapsFoundLocal`, `laterReplyElsewhere`, `hedged`, `headerEarnedRate`, `indexTruncated`, `indexReplicationLagMs`, `indexEmitsDropped`, `journalAvailable`, `suppressedByFD29`, `emergencyDisabled`. This is what closes Q7 on any machine with replication on, independent of the L2 soak, and what FD27's acceptance must cite.
- `GET /conversation-history/merge` — the Layer 2 sub-object below; reports `{ layer2: 'off' }` rather than 503 when the gate is dark (an honest state for a feature that is *running*, never a 503).

The merge object:

```
{ enabled, dryRun, lastSpawnAt, spawns, peersReached, peersUnreachable, peersSkippedForBudget,
  rowsContributedByMachine: { [machineId]: n }, gapsFoundLocal, gapsClosedByMerge, gapsRemaining,
  divergences, laterReplyElsewhere, hedged, genuinelyUnanswered, indexTruncated, indexEmitsDropped,
  indexReplicationLagMs: { p50, p95 }, p50FanoutMs, p95FanoutMs }
```

Self-scope only — the measurement is inherently per-origin (see the posture table). Counters carry **no message text** (FD32). `indexReplicationLagMs` is the surviving analogue of the retired Q7 measurement.

### 3.3 Layer 3 — Pool-scope history read (v1, small)

`GET /telegram/topics/:topicId/messages?scope=pool` returns the merged view with per-row `machineId` attribution and a `pool: { peersOk, failed }` block, matching the established `?scope=pool` conventions elsewhere in the codebase.

This is how "what did I actually say in this conversation?" becomes answerable rather than guessable, and it is the read surface a human uses to check the merge during the dry-run soak.

---

## 4. Failure modes and honest behaviour

| Condition | Behaviour |
|---|---|
| No peers configured (single machine) — renders the `GENUINELY UNANSWERED` group for the trailing run (FD29) | Layer 2 is a strict no-op. Layer 1 still runs; header states "this machine's view". |
| Peer offline | Named in `Contributed by` as unreachable. Gaps still computed and stated. |
| Peer returns malformed rows | Rows dropped, peer named as partial, never a crash. |
| `messageId` collision, divergent text | Both retained, divergence flagged in the block. |
| Local log unreadable | Layer 1 emits a block stating that local history could not be read — never an empty block presented as an empty conversation. |
| TopicMemory returns rows, JSONL has more | Merge both, dedupe on `messageId`. |
| Gap detected but Layer 2 filled it | Gap note withdrawn only for turns actually filled; remaining gaps still stated. |

**The invariant:** *every* path either produces a block whose stated scope matches its actual content, or produces a block that says it could not establish its scope. There is no path that overstates.

---

## 5. Security and privacy

**Rev 4 additions (round-3 security + integration reviews; the first two were round-1 findings that survived two revisions):**
- **Bearer-token egress to peers is allowlisted.** The §3.2 fan-out and the §3.3 pool route pass every peer URL through `isPeerUrlAllowedForCredentials(url, config.multiMachine.peerUrlAllowlist)` (`src/server/peerUrlGuard.ts` — shipped for exactly this fan-out; the older sessions pool route at `routes.ts:9285` omits it and is NOT the template to copy) BEFORE attaching `Authorization`. A rejected URL yields a visible `contributions[].state: 'url-rejected'` row, never a silent skip. Redirects: per the guard's own header note (`peerUrlGuard.ts:16-20`), plain `fetch()` is used WITHOUT `redirect:'manual'` — the Fetch spec strips `Authorization` on a cross-origin redirect — and any 3xx outcome is classified `unreachable`, never followed into content (round 4: rev 4's `'manual'` mandate contradicted the file it cited). Tier-2: a peer advertising a non-allowlisted host is refused, named in the block, and receives no request.
- **New at-rest exposure, stated — not denied.** Rev 3's "no new at-rest exposure" is false under FD43: the outbound index is a durable, replicated artifact on every pooled machine. It is content-free, but `(topicId, messageId, machineId, ts)` is the operator's conversation-ACTIVITY graph. Metadata, not text; whether it falls on §6.1's side of the line is **folded into Q9**.
- **Every rendered row is clamped and escaped — local or peer.** Rev 3 escaped peer rows only; §3.1.6(c) had located a prompt-injection lane in LOCAL forwarded content and answered it with a label, and a label is not an escape. The block's structural markers (the FD38 header family, group headings, `WHAT TO DO:`) are reserved and neutralised inside any excerpt. Tier-1: a `third-party` row containing a verbatim `LATER REPLY ELSEWHERE (` heading renders inert; the block contains exactly one `WHAT TO DO:`.
- **Privacy filter — the source asymmetry, stated.** `TopicMemory` rows carry `privacy_scope`/`user_id`; the JSONL `LogEntry` carries neither. Rev 3's fail-safe ("unestablishable scope ⇒ exclude") applied to the JSONL-fed fan-out would exclude every peer row and void Layer 2 — the FD29 composition failure again, found independently by two reviewers. Rev 4: the fan-out route serves from `TopicMemory` where ready (scope-filtered); the LOCAL JSONL rendering (Layer 1, this machine's own rows) is honestly **unfiltered today** — peer JSONL-only rows are never merged (`scope-unavailable`). `?scope=pool` takes an explicit resolved-operator principal or drops the per-user claim; the surviving rule applies to `?block=1` too. **Tier-2 must assert peer rows SURVIVE the filter on an ordinary single-user topic** — an exclusion-only test would have passed against this defect.
- **Bearer-only holds iff `authToken` is configured** (round 5: `middleware.ts:127` skips auth entirely when no token is set, and a multi-machine server binds Tailscale/LAN) — `/telegram/reply` is not in the exemption list, so with a token set an external caller cannot stamp `reply` to manufacture evidence; on-machine Bearer holders can mis-stamp, which is under-action only and inside the stated threat model.
- **`?scope=pool` gets the adjacent `rateLimiter` convention** (`routes.ts:8151`); `?block=1` gets a hard server ceiling with a hedged 200 instead.


- **No new at-rest exposure FROM LAYER 2 (FD5)** — FD43's index is the one new at-rest artifact, covered by Q9. Layer 2 fetches into memory at spawn and renders into a session's context. It does **not** write peer rows into the local log. (Writing them would create the bulk-replication exposure §6.1 rejects, by the back door.)
- **Existing auth only.** Fan-out uses the existing Bearer-authed per-machine route over the existing peer transport. No new credential, no new listener.
- **Peer content is untrusted data.** A peer's message rows are rendered as quoted data, never as instructions — same posture as the replicated-store family.
- **Operator identity unchanged.** This spec does not touch operator binding or sender validation. A replicated/merged row is **never** authoritative for "who is my verified operator" — Know Your Principal is unaffected because nothing here establishes identity.

---

## 6. Alternatives considered

### 6.1 Replicate conversation history into the state-sync set — REJECTED for v1

Add `telegram-messages` as an eleventh replicated store.

**Why rejected.** Conversation content is the highest-volume and highest-sensitivity state in the system. The existing replicated stores are small metadata sets (preferences, learnings, relationships). Replicating full conversation text would put a plaintext copy of every conversation on every machine in the pool — **including rented VMs the operator does not physically control** — under filesystem permissions rather than the encrypted vault. The at-rest honesty note the relationships store already carries would become dramatically heavier. Volume is also wrong: the log is multi-MB with 75k-line rotation, against a replication layer built for small records.

Layer 2 gets the same read benefit with a bounded, in-memory, at-spawn fetch and no new at-rest copy.

### 6.4 Replicate a content-free OUTBOUND INDEX — the leading candidate for rev 3 (raised round 2)

Proposed independently by the clean-door reviewer and gestured at by the cross-model reviewer, and it is stronger than what rev 2 builds.

§6.1 rejects replicating conversation **content** — correctly, on at-rest-exposure grounds (plaintext conversations on every pooled machine, including rented VMs). Rev 1 and rev 2 then treated that as closing the whole family, and reached instead for the session-lifecycle journal: an indirect proxy that needed a 60s window, clock-skew handling, a rotation horizon, unterminated-interval bounds, and a fallback for a `topic` field that only parses 0.34% of the time. **Roughly 40% of this spec is scaffolding propping up a clue.**

What was never considered is replicating the **index** rather than the content: for each outbound row, `(topicId, messageId, machineId)` and nothing else. No text, no sender identity, no authority fields — so §6.1's objection does not apply to it, and it is well inside the size class the small-record replication layer already carries.

**Measured feasibility (this machine, 2026-08-21):** ~700 outbound rows/day, 67 bytes per index row ⇒ **~47 KB/day, ~16 MB/year**. The journal's rate cap (capacity 100, refill 50/s) is not a constraint at this volume.

**What it buys.** S5 — the only causally-tied signal — becomes an exact, local, zero-network lookup: *is there an outbound row on topic K with a messageId greater than this turn's?* That single question retires, wholesale: the `topic`-name regex (§3.1.4a), the 60s spawn window and FD10, the cross-clock comparison (§3.1.4b), the rotation horizon, FD12's unterminated-interval bound, and most of S4. The three-group split collapses toward two, because "handled elsewhere" was only ever a consolation prize for not being able to answer the real question.

**The caveat neither reviewer checked, and it does not go away.** The index would ride the same replication substrate that §3.1.5 shows is **dev-gated dark on the fleet** — so it inherits FD27's availability problem unchanged. The index makes the signal *exact*; it does not make it *present*. What it does improve is optionality: an index question can also be answered by Layer 2's on-demand fan-out, whereas a lifecycle receipt could only ever arrive by replication. So availability gains a second route it did not have.

**Status — DECIDED (FD41): adopted as S5's canonical evidence shape (S4 deleted — see FD42).** S5's evidence is `(topicId, messageId, machineId, provenance)` per outbound agent row — which is exactly the §6.4 index row. It is carried by whichever route is live: the journal replication when enabled (a local, zero-network exact lookup), or the Layer 2 fan-out's digest when not. This unifies S5's data shape across both routes, gives S5 a second availability path (so FD27's dark-journal problem no longer strands it), and makes the three-group output reachable on any machine where *either* route is on. S4 was initially kept here as a fallback; **FD42 (same round) supersedes that and deletes it** — S4 and the index ride the same replication and are both forward-only, so there is no configuration where S4 answers and the index does not. On a fleet agent with both routes dark the block is Layer-1-honest (S1 hedges) and says so; a weaker signal that can never fire is not a fallback. The write it adds (an index row per outbound agent message) is declared under NG4 as restated. The index write is declared under NG4 (restated): this spec is read-path for conversation content plus two bounded text-free writes.

### 6.5 The ROOT write defect: the answering machine never logs the turn it answers (raised round 3 — the strongest alternative, and it was missing)

The clean-door reviewer noticed what three rounds had walked past. §1.3's merge shows turn 52134 exists **only on the Studio** — yet the Mini *answered* it. The owner that answers a forwarded message necessarily received its content, and then did not write it down. Verified: `appendToLog` is private to `TelegramAdapter` and reachable only from the poll path; a message routed to the owner over the mesh is injected into the session and never logged there. So the split in §1.1 is not an inherent property of multi-machine operation — it is a **write defect**: the owner's log is incomplete for the very span it owned.

**The alternative:** the owner logs every forwarded inbound row it handles, marked `origin: 'forwarded'` (never counted by the standing-authorization resolver — the `forwarded` field already exists for exactly that purpose). Then the owner's log is **complete for its ownership span**, and a move needs **one pull from the previous owner** (whose identity the replicated placement journal already records), not a pool-wide fan-out. No new at-rest exposure: the owner already holds the text in memory to answer it.

**Why this was missed:** every prior revision accepted "inbound is recorded by the poller, outbound by the answerer" as a given and built read-path machinery around it. That is the foundation-not-audited pattern the lessons reviewer is tasked with catching, and it survived three rounds because it sat one layer below the spec boundary.

**Status — DECIDED (FD42), CORRECTED after a scope check: this spec DEPENDS on `docs/specs/inbound-message-recording-gap.md`; it does not re-specify the write.** A scope checkpoint forced a read of the specs that own the inbound path, and the write fix already exists as a 1,700-line draft (2026-07-25, 12 review rounds, 0 constitution-gate findings, Gemini clean four times) — "Record inbound messages at the injection seam." It stalled only because its strongest external reviewer returned HTTP 503 on rounds 11–12; it is not converged and not shipped, which is why the incident still happened on 2026-08-21. Its own §8.1 names its single external dependency: *"A pool-scope conversation-history read (or inbound replication) — tracked as ACT-1216"* — **which is this spec.** The two are a pair: that spec is the WRITE (each machine gains an honest record of what it was shown), this spec is the READ (the merged view across machines). Rev 3 of this document was about to re-specify the write from a grep — the foundation-not-audited pattern, caught one round after catching it in S4.

What changes here as a result:
- **FD42 = dependency, not design.** This spec's Layer 2 "pull from prior owners" assumes each owner's log is complete for its span, which is exactly what the recording-gap spec delivers. Where that spec is not yet enabled, the §1.1 split persists and Layer 1's hedge is what ships — stated, not assumed.
- **S4 is still deleted** (the dominance argument stands on its own: same dark replication, both forward-only).
- **The §6.4 content-free index is retained as S5's evidence shape** — it is the cross-machine *verification* substrate; the recording-gap spec is the per-machine *completeness* substrate. Different jobs.
- **Two of its four open product questions are this spec's to answer**: #1 (cross-machine merged view — Layer 2/3 here) and #4 (encryption at rest — §6.1 here). Its posture row keys the message log `physical-credential-locality`, the key this spec's round-1 integration pass rejected on §1.1 grounds. **This spec's key (`operator-ratified-exception`) governs**; re-keying the recording-gap §6 row is part of ACT-085's scope, and Q9's ratification text names BOTH specs.
- **Its `ACT-1216` reference resolves nowhere** — not in this machine's 84 actions, not in either peer's replicated action journal — so the dependency that spec "registered rather than left as a note" was an orphan anyway; it is now ACT-085 here, with an owner and a date. **Converging the recording-gap spec is a prerequisite of BUILDING this one**, and its blocker (a provider outage) is gone — codex has run cleanly on every round of this spec today. Tracked below as a named follow-up with an owner and a date rather than a prose mention.

### 6.6 Why not a per-topic append-only event log / stream (round 5 — both external reviewers asked)

The standard shape would be one durable per-topic event log owned by the current topic owner, with an explicit handoff snapshot or replay. It is the right END state and §1.7 shows the umbrella specs already gesture at it (the drain-barrier "final context flush"). It is not v1 because: (a) it IS the write spec's job (`inbound-message-recording-gap.md`, Phase B) plus a transfer-snapshot, and this spec deliberately does not re-specify the write; (b) the membership-set index (FD44) is the minimal replicated artifact that makes the gap exact TODAY without moving content, so it is the stepping stone, not a competitor — once per-topic logs travel with ownership, Layer 2 reduces to "pull from prior owners" and the index becomes a verification sidecar; (c) an encrypted shared log answers §6.1's at-rest objection but is a new subsystem with key management, which belongs to the foundation spec, not here. Stated so the bespoke pieces read as stepping stones with a named destination.

### 6.7 Route every outbound send through the lease seat — the alternative round 6 found unweighed (DECIDED: compared at Phase B, not built in Phase A)

The clean-door reviewer's observation: `ForwardedTopicContext` fetching from the lease holder is "the wrong machine" ONLY because outbound sends bypass the holder. The tokenless-standby relay branch (`TelegramAdapter.ts:1401`) already proxies sends THROUGH the holder. If every outbound went through the lease seat, the poller's log would be complete by construction, the existing relay would be correct as-is, and FD44's index, the resident Map, the epoch/high-water check and the replica prune would all be unnecessary.

Honest comparison: **for:** one complete log at one seat; the lease-handoff path already flushes + hash-verifies that log (`HandoffSentinel`); no new replicated kind; Layer 2 collapses to "fetch from the holder", which is what is built today. **Against:** every reply pays a mesh hop (the relay branch measures this today on the standby); the holder becomes the single WRITER for outbound as it already is for inbound — so a holder outage stalls replies pool-wide rather than only ingress; it is a routing change (NG4's fenced clause) with its own consent/drain semantics in the session-pool spec; and it does not remove the need for the write half (the owner still never logs the inbound turn it answers — the holder does, which is fine for history but not for the owner's own local context). **Decision:** Phase A (Layer 1 honesty) is unaffected either way and ships first. At Phase B the comparison is binary and must be made explicitly: (i) the write half as specified, plus FD44's index for cross-machine verification, or (ii) single-writer-at-the-seat, which subsumes both. Tracked as ACT-091 with the measured hop latency as the deciding input; §0.1's Phase C list is conditional on (i).

### 6.2 Backfill from Telegram via MTProto — DEFERRED

`docs/specs/TELEGRAM-HISTORY-BACKFILL-SPEC.md` already ships a read-only MTProto historian that authenticates **as the operator's account** and can read complete history — the true source of truth, complete regardless of which machine recorded what, and available even when every peer is offline.

**Why deferred, not rejected.** It authenticates as Justin across all his chats, depends on a long-lived credential, and is subject to FloodWait. That is disproportionate authority and a hard dependency on a per-spawn hot path. It is, however, the right answer to Layer 2's one real weakness (all peers offline) and should be a tracked follow-up: an on-demand, gap-triggered backfill rather than a routine spawn path.

### 6.3 Layer 1 only — REJECTED as sufficient, ACCEPTED as the floor

Honest markers alone would have prevented the confident wrong answer but would leave the agent unable to continue coherently — it would know it was missing something without being able to recover it. Correct as a floor, insufficient as the whole fix. Hence Layer 1 always-on **plus** Layer 2.

---

## 7. Testing (Testing Integrity Standard — all three tiers)

### Tier 1 — Unit

`tests/unit/conversation-history-block.test.ts`
- Gap detector: `sessionName: null` user row ⇒ gap flagged, with the row's timestamp named.
- `provenance: 'automation'` rows do **not** satisfy "was answered" (the incident's exact trap).
- No-gap window ⇒ honest scope statement, and the word "complete" never appears without peer corroboration.
- Empty local history ⇒ a block that says so, never a silently empty block.
- **Regression fixture shaped exactly like topic 52075**: rows 52134 (user, null session) → 52158 (automation) → 52162 (agent) ⇒ asserts 52134 is flagged as a gap.

`tests/unit/peer-session-corroboration.test.ts` (S4 — **RETIRED with FD42; the negative-control DISCIPLINE below carries over to the S5 suite, the file does not ship**)
- Peer interval **contains** the unanswered turn ⇒ corroborated, peer machine named.
- Peer `created` falls **13s after** the unanswered turn ⇒ corroborated (the 52083 case; a strict-containment implementation fails this test).
- Peer `created` falls **10 minutes after** ⇒ NOT corroborated (window bound holds).
- No peer rows for the topic ⇒ hedged, never "no gap" — asserts the one-directional property explicitly.
- **`seq`/`topic` namespace collision**: a journal row with `seq: 52075` and no `topic` field must not corroborate topic 52075. This is the exact trap a text-scan implementation falls into.
- Unterminated session (`created` with no terminal row) ⇒ corroborates turns after it **only within a bounded horizon** (see FD12); a turn beyond the horizon is `unknown`, NOT corroborated. A test asserts the unbounded reading is rejected.
- `created` row aged out but a terminal row survives ⇒ contributes **no** interval and does not corroborate (a silent coverage loss, never a false positive). Measured: 5 of 111 topic-stamped peer sessions are currently in this shape.
- A turn older than the oldest `ts` present in the journal ⇒ `unknown-aged-out`, hedged, distinguishable from evidence-absent.
- Unreadable / absent peer journal ⇒ hedged with no throw (fails toward the honest hedge).

`tests/unit/conversation-history-merge.test.ts`
- Dedupe on `(topicId, messageId)`; ordering by `messageId`.
- Divergent text on equal `messageId` ⇒ both retained and flagged.
- Peer contributing the *complementary* half ⇒ merged view has zero gaps where the local view had two.
- Unreachable peer ⇒ named absence, no throw.
- Malformed peer payload ⇒ dropped rows, peer named partial.

**FD-inline tests are NORMATIVE and part of this plan (round 6):** FD46's flag-product test; FD45's positive (52162 qualifies) and negative (epoch-3 row beyond `highWater(4)`) cases plus the registry-epoch == record-epoch assertion; FD43's throttle Tier-2 (empty stream served; served again after version change/TTL), replica-prune Tier-1, `echoUnstamped` negative control, compactor row-count test; the second 52075 fixture (FD44 path); `headerEarned ⇒ verdicts.length===0`; `index-evicted` via `evictedWatermark`.

**Rev-4 consolidation (FD-inline tests folded here so §7 is the plan the build runs from):** S5 cases (a kindless conversational send promotes with AGENT-class wording — the server derives kindless conversational sends to `'reply'` (§8); kind is wording, not evidence, under FD44; automation row 52148 does not promote; a merged block containing the qualifying peer row renders no LATER REPLY ELSEWHERE; relay-echo pair dedupes; ownership cross-check rejects a topic the peer never owned); no LATER REPLY ELSEWHERE when NEITHER route is live; 12 turns render 5 + aggregate; FD38's seed-corpus ratchet; `forwarded: true` + legacy-no-`forwarded` rows; FD36's any-failure fallback renders local history WITHOUT the imperative, including the 200-without-`block` case; exactly one hook source per hook (an EQUIVALENCE test — the prior e2e parity harness at `tests/e2e/compaction-telegram-context.test.ts:234-245` asserted markers and watched `limit=30`/`15` diverge for weeks); DP7's snapshot-on-imperative-region cross-product plus the forbidden-phrase ratchet scoped to template literals (`do not reply`, `stay silent`, `wait for the operator`, `ask the user to re-send`, `confirm before`, `hold off`) — never the rendered block; DP6b's trailing-run + zero-user-row cases; INV-1a verify-first sentence present whenever any turn is listed; Q2's re-delivery case (same `messageId` on two machines, identical text ⇒ one row, both attributions, no divergence); single-machine GENUINELY UNANSWERED group; compactor over a synthetic index stream preserves row count.

### Tier 2 — Integration

- `GET /conversation-history/block` answers 200 while L1 is live and enforces auth; `GET /conversation-history/merge` returns `{ layer2:'off' }` rather than 503 when dark; `?block=1` returns a formatted block, enforces auth, and returns a hedged 200 on an event-loop-budget overrun. `?scope=pool` refuses a non-allowlisted peer URL with a named `url-rejected` contribution, and peer rows SURVIVE the privacy filter on a single-user topic. Tier-3's "feature is alive" assertion targets `/conversation-history/block` — the one route that ships to every agent. **Named follow-up (§1.7, out of v1):** a Tier-2 case that a serving-lease handoff on a split topic no longer aborts on the thread-history hash once the read is unified.

`tests/integration/conversation-history-pool-scope.test.ts`
- `GET /telegram/topics/:id/messages?scope=pool` returns merged rows with `machineId` attribution and a `pool` block.
- A failing peer degrades to a `pool.failed` entry, never a 500.
- Auth enforced.

### Tier 3 — E2E lifecycle

`tests/e2e/conversation-history-coherence.e2e.test.ts`
- **The "feature is alive" test**: production initialization path mirroring `server.ts`; the pool-scope route answers 200, not 503.
- A spawn on a machine holding only the inbound half produces a context block containing the gap warning.
- With Layer 2 enabled and a peer serving the complementary half, the same spawn produces a block with no gap warning and both halves present.

### Wiring integrity

- The shared formatter is actually invoked by every converted callsite (no callsite left on a private copy).
- Layer 2's dependencies are non-null and delegate to real implementations in the wired path.

---

## 8. Migration parity

**Rev-4 rows (round 3: §8 had lost its only hook row, still carried the inverted Slack claim, and enumerated none of the deletion's dependents):**
- **`telegram-topic-context.sh`** — always-overwrite via `migrateHooks()` (`PostUpdateMigrator.ts:5145`); byte source = `getTelegramTopicContextHook()` (`:13347`); the pinned carve-out string is the LITERAL's (`TOPIC N RECENT HISTORY (auto-injected):`), not the template's — rev 3 pinned the copy nobody runs. Also added to `installHooks()` (fresh-init gap). The template file is deleted; its dependents dispositioned: `tests/e2e/compaction-telegram-context.test.ts:220-245` (delete the canonical-template arm; surviving test asserts literal↔copy equivalence), `scripts/blocking-decision-surfaces-baseline.json:104` (remove the sha-pinned entry — `lint-blocking-decisions-declared.mjs` rule 2 otherwise fails CI as STALE DECLARATION), `src/data/builtin-manifest.json:1360` (regenerated at build; deployed hook is keyed `hook:` with provenance from the `instar/` subdir — no classification regression), the `pending_user` content assertion (red by design). `init`/scaffold verified unaffected.
- **`compaction-recovery.sh`** and **`session-start.sh`** — same always-overwrite track (`:5110`, `:5138`), same literal-vs-template shape, same BEHAVIOUR change (FD36) — **but their template files are NOT deleted in v1** (round 4: they have seven test sites and two baseline rows of their own — `coherence-gate-escalation.test.ts:419`, `discovery-hardening.test.ts:330`, `slack-session-continuity.test.ts:21`, `slack-session-relay-prompt-census.test.ts:7`, `discovery-agent-integration.test.ts:338`, the e2e canonical arms at `:237/:245`, baseline `:74/:89` — and asserting "same treatment" without dispositioning them was a quiet CI break). Instead each gets the literal↔template **EQUIVALENCE** test (the one the telegram hook's deletion is justified by), so a future divergence fails CI rather than being watched for weeks. Deletion of those two templates is a tracked follow-up once their dependents are dispositioned.
- **`?block=1`** is a server-side prerequisite for all three hooks; FD36's any-failure fallback is the ordering guarantee.
- **`history-index` journal kind** (both row provenances incl. the poller's high-water row — NO change to `topic-placement`'s field list) — emit + registry schema (the receive-side mirror IS the registry schema — `validateData` routes registered kinds through the generic envelope validator) + retention + dual registry + stateSync dev-gate entry/STORES/advert in one PR (FD43).
- **`telegram-reply.sh` relay script — NO LONGER A DEPENDENCY (round 5).** The rev-4c claim that it rides an always-overwrite track was FALSE: `migrateScripts()` (`:10345`) *never overwrites existing scripts*; an existing copy is overwritten only by `migrateReplyScriptToPortConfig` (`:15850`) when its on-disk SHA is in the hand-maintained `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS` set, else it gets a `.new` candidate and keeps running. Under FD44 the kind is wording-only, and the server already defaults a kindless conversational send to `'reply'` (`routes.ts:15506/15538`) — so the wording kind is DERIVED SERVER-SIDE at the index write and the script is untouched. `TemplatesDriftVerifier` verifies only.
- **`installHooks()` addition** — slot beside `compaction-recovery.sh` at `init.ts:4365` via `migrator.getHookContent('telegram-topic-context')`; does not trip `migration-parity-hooks.test.ts` (soft cap 10→9); REMOVE the now-stale `INSTALL_VS_MIGRATE_KNOWN_GAPS['telegram-topic-context.sh']` entry (`:60-64`).
- **CLAUDE.md template section** (Agent Awareness + INV-3): names `GET /conversation-history/block`, `GET /conversation-history/capability` (FD46), the gap groups, and — for `?scope=pool` — the 503-when-dark condition; `migrateClaudeMd()` adds it with a content-sniff marker `<!-- conversation-history-coherence -->`.
- **Release-note fragment** `upgrades/next/cross-machine-conversation-history-coherence.md` (the third leg `feature-delivery-completeness.test.ts` requires), maturity-tagged ⚗️ for L2/L3 and the index route.
- Hostile-response caps cite `routes.ts:8153` (the `:8150` anchor was the comment above them).
- **`monitoring.conversationHistoryBlock.emergencyDisable`** — `guardManifest` row (FD28).
- **The existing-agent UPDATE path, stated explicitly (round-4b gate finding — §8 named only fresh-install wiring):** every deployed hook is WRITTEN FROM THE MIGRATOR LITERAL by `migrateHooks()` on every update (`PostUpdateMigrator.ts:5138/5145` and the session-start writer) — built-ins are always-overwrite, never install-if-missing — so an existing agent receives the rewritten telegram-topic-context / compaction-recovery / session-start hooks on its next update tick with no new migration step, and any stale on-disk copy (including one carrying the deleted detector) is overwritten. Deleting the template files changes NOTHING on an existing agent's disk: deployed hooks were never copied from the templates. The `installHooks()` addition is for FRESH agents only (closes the ~30-min fail-silent window). The new `history-index` kind needs no `migrateConfig()` entry (retention defaults are code) but DOES need its `guardManifest` + `DEV_GATED_FEATURES`/stateSync entries, which ride the same update. A Tier-1 migration-parity test asserts each of the three hook literals is on the `migrateHooks()` always-overwrite list.


Per the Migration Parity Standard, existing agents must receive this on update:

- **Config defaults for the Layer 2 gate — rev-2 correction.** Rev 1 said "`migrateConfig()` with existence checks." That is the anti-pattern the dev-gate registry exists to catch: `devGatedFeatures.ts` requires the config to **OMIT** `enabled` so `resolveDevAgentGate` resolves it, and states that a default hardcoding `enabled: false` **fails the wiring test**. So the L2 `enabled` flag is omitted from ConfigDefaults entirely, a `DEV_GATED_FEATURES` entry is added (with the required `name` / `configPath` / `description` / `justification` fields, following the `multiMachine.seamlessness.*` family convention), and the `dryRun` sub-flag is likewise omitted and resolves coherently with the gate at the consumer. `migrateConfig()` is used ONLY for genuinely non-gated tuning (the §3.2 timeouts and limits).
- **CLAUDE.md template** (`src/scaffold/templates.ts` → `generateClaudeMd()`) ⇒ Agent Awareness Standard: an agent that does not know the block can carry a gap warning will not act on it. Needs a section describing the gap marker, the `?scope=pool` read, and the proactive trigger. Plus `migrateClaudeMd()` with a content-sniffing guard.
- **Idempotency**: every migration safe to re-run.

---

## 9. Rollout and rollback

**Index route (added round 4 — security N4; the always-on `?block=1` path consumes PEER-ASSERTED evidence and had no rollout row):** `multiMachine.stateSync.historyIndex` ships with `enabled` OMITTED (the dev gate resolves it) and `dryRun:true`, like its WS2 siblings. `dryRun:true` for the CONSUMING read means: index rows are received and counted — `wouldPromote` on `GET /conversation-history/block` — but `capability.historyIndex` resolves `'unavailable'` and the LATER REPLY ELSEWHERE group stays absent. The enforce flip is the operator's, on that counter. §0's "local, zero-network" describes the READ; the DATA is peer-asserted, stated.


| Layer | Ships | Gate | Rollback |
|---|---|---|---|
| L1 honest provenance | **ON, always** | none (deliberate) | revert the formatter change |
| L2 peer merge | dark on fleet, dev-gated, `dryRun: true` | `multiMachine.historyMerge` | flag to false ⇒ local-only + L1 |
| L3 pool-scope read | with L2 | same gate ⇒ 503 when dark | flag |

Layer 2's dry-run soak measures, per spawn: peers reached, rows contributed per peer, gaps found locally, gaps the merge closed, divergences. The enforce flip is the operator's, on that evidence.

---

## Glossary (round 3 — three reviewers could not verify claims that hinge on local vocabulary)

| Term | Meaning |
|---|---|
| **Poller / serving-lease holder** | The one machine currently long-polling Telegram; it records every INBOUND message. |
| **Topic owner** | The machine whose session answers a given conversation; it records OUTBOUND messages. Often not the poller. |
| **Turn** | One user message. "Locally unanswered" = no local agent reply row follows it. |
| **S1 / S4 / S5** | Signals: S1 = user row with `sessionName:null`; S4 = (RETIRED rev 4) a peer session interval from the replicated lifecycle journal; S5 = a provenance-`agent` peer outbound row after the turn — the only causally-tied one. |
| **INV-1 / 1a / 2 / 3** | Block invariants: never instruct silence; verify-before-acting on an action turn; never instruct a hand-back; never name an unavailable recovery. |
| **FD-n / DP-n / Q-n** | Frontloaded Decision / Decision Point (classified `invariant` or `judgment-candidate` with a floor) / Open question. |
| **P20** | Constitution standard "Verify the State, Not Its Symbol": declare symbol, state, causal corroboration, and unmeasurable behaviour for every detector. |
| **B15–B19 / B-PARK** | The outbound gate's hard-blocked self-stop family: quitting on a context excuse, calling a doable thing impossible, parking the agent's own work on the user. |
| **Rung 0** | Self-unblock ladder: resolve within the agent's own permissions before asking a human anything. |
| **Judgment Within Floors** | A decision point that weighs competing signals must declare a bounded action space, a conservative default, and a fallback ladder ending at a deterministic rung. |
| **Dev-gated / dark** | Feature resolves ON only on a development agent (`resolveDevAgentGate`); OFF fleet-wide. "Dry-run" = runs and logs but does not act. |
| **Coherence journal** | Per-machine append-only coordination log (19 kinds), replicated between machines only when `multiMachine.coherenceJournal.replication.enabled === true` — OFF by default. |

## Decision points touched

This spec is read-path for conversation *content* (NG4 as restated — it adds bounded text-free write surfaces): it changes what a resuming session is handed and what that handoff claims about itself. It introduces no new block/allow authority. Every point below is classified per the **Judgment Within Floors** standard.

| # | Decision point | Class | Justification / floor |
|---|---|---|---|
| DP1 | **Is a turn locally unanswered?** (`fromUser && sessionName === null`) | `invariant` | Deterministic read of a field the writer already stamps. **Rev-2 correction to the justification:** rev 1 argued "misfiring produces an over-cautious note, never a blocked or altered message." That was true of rev-0's hedge and FALSE once S4 made the output a directive — and it is the sentence that let §4 assert "no path overstates." Three misfire directions exist, not one: a false *positive* is over-cautious (harmless); a false *corroboration* is over-**confident** and, before INV-1, suppressed a reply (the worst outcome in this spec); a false *negative* emits an unearned all-clear (DP6b). The field is also not liveness — `sessionName` records that the topic→session **binding held a name at log time**, so a stale binding from a dead, wedged, rate-limited or standing-down session yields non-null and S1 flags nothing. |
| DP6 | **Is this turn presented as handled/answered elsewhere?** (S4 / S5) | `judgment-candidate` | The decision rev 1 omitted entirely, and the spec's highest-consequence inference. Competing signals: a null local session, a reconstructed peer interval, a spawn window, an unterminated-interval assumption, replication freshness, clock skew, and (S5) a peer outbound id. **Floor:** bounded action space = {answered-elsewhere (S5 only), handled-elsewhere (S4), unverified} — **no verdict removes the turn from the block and no verdict instructs silence (INV-1)**; **conservative default = `unverified`** — corroboration requires positive evidence, and absence, an unreadable or truncated journal, a stale replica, `topic: undefined`, a skewed clock, or any thrown error all resolve down; **fallback ladder (rev 4):** S5-local (replicated outbound index row, `capability.historyIndex:'local'`) → S5-via-L2 (fan-out digest, `'via-l2'`) → `unverified` (terminal deterministic rung). The S4 rungs are retired (FD42). Both S5 rungs are gated on evidence-not-truncated (FD30); neither involves a clock. **Arbiter:** the shared formatter, local reads only — no LLM, no ranking. Least-harmful fail direction is declared: **toward `unverified` and toward answering.** |
| DP6b | **Is the no-gap header earned?** | `invariant` | Rev 2 addition. A non-null `sessionName` does not prove a reply, so "no gaps detected" cannot be asserted from S1's absence alone. The header is earned when each user turn in the window **except the trailing unanswered run** is followed by a local agent (non-automation) row with a greater `messageId`. The predicate is `userTurnsInWindow > 0 && ∀ non-trailing user turn …` — **never the bare universal**: on the OWNER machine the local log holds zero user rows (inbound is recorded by the poller — §1.1, and §1.3's Mini view is five agent rows, zero user), so a bare universal is vacuously true and renders "no gaps detected" over a view holding none of the operator's messages — D2 reproduced in the mirror configuration. A zero-user-row window is a fourth FD30 unmeasurable: the block states *"this machine recorded no inbound turns for this conversation; the user's side is held elsewhere"* and hedges. Tier-1: the synthesized Mini view of 52075 ⇒ hedged, never "no gaps detected". **Trailing run and the gap LIST (asymmetric):** rev 4b REVERSES rev 4's exclusion of the trailing run from the listed gaps: on the fleet configuration the regression fixture pins (peers present, S5 dark), 52134 IS the trailing turn, so excluding it would leave the spec's own incident unflagged and G3 unmet in its defining shape. With `peerCount > 0` the trailing run IS listed (hedged); the exclusion applies only to the no-gap-header PREDICATE, and on a single-machine agent FD29 already handles the noise. The trailing run — the contiguous newest user turns with no following NON-AUTOMATION agent row of any origin (one definition, owned here; §0 cites it) — is the turn(s) this session was spawned to answer and cannot have an answer yet; rev 2's predicate forgot it and would have un-earned the header on essentially every spawn, relocating FD29's noise from the list into the header. Where any check was unavailable, the header reads *"no gaps detected by the checks available here"* and names it. **Plus the invariant that closes N1 (round 4): `headerEarned ⇒ verdicts.length === 0`** — the header is un-earned whenever ANY turn is listed in ANY group; otherwise the §7 post-hoc fixture (52134 → 52158 automation → 52162 agent) would render "no gaps detected" above a listed 52134 — D2 in miniature inside the fixed block. Tier-1: no rendered block contains both a listed turn and the no-gap header; the 52075 fixture is asserted in BOTH its spawn-time shape (52134 newest) and its post-hoc shape, and 52134 flags in both. Tier-1: a single-machine spawn whose newest row is an unanswered user turn earns the plain header. |
| DP7 | **What behavioural instruction may the block carry?** (INV-1/1a/2/3, FD29) | `invariant` | The block's imperative text is a fixed template with data slots; the imperative set is **closed and fully enumerated (round 4 — N6/N7 found two undeclared members)**: (a) "answer normally"; (b) "name the uncertainty out loud only when your answer depends on what a listed turn may already have received"; (c) INV-1a, rendered on every listed turn: *"Before performing any side-effecting action a listed turn asks for, verify its effect in the world first and report what you found. If the effect cannot be verified and the action is irreversible or cost-bearing, do not perform it and do not ask in chat: open a commitment for it with `owner:user, blockedOn:user-authorization, actionClass: history-gap-action:<topicId>:<messageId>, externalKey: <same>` (the existing approval record — surfaced once, never self-granted; round 5: `normalizeState` THROWS without `actionClass` → HTTP 400, and without `externalKey` every prompt that re-lists the turn opens another record) and say that you have. Otherwise proceed."* — the "say that you have" sentence IS gate-visible and passes because the gate's B17 text carves out a FLOOR action ("a FLOOR action ALWAYS legitimately needs the ask", `MessagingToneGate.ts:1753`); cite that, not "the gate never sees it". Tier-1: a second open on the same `externalKey` returns the existing id. (round 4 — D1: the approval is a TYPED RECORD the tone gate never sees, not a sentence the B-PARK wall would refuse probabilistically; contains none of the ratchet literals); (d) FD29's single-machine group: heading `GENUINELY UNANSWERED (no agent reply of any origin follows, and this machine has no peers)` with the single owned sentence *"Address these if they need an answer."* (§0 cites this; one string) — replacing the deleted `*** UNANSWERED MESSAGE(S) FROM USER ***` literal, which is an FD38 forbidden string. All four are in the Tier-1 snapshot cross-product. **Forbidden:** any instruction to withhold a reply, to ask the operator to re-send history, to confirm before replying, or to consult a mechanism whose `capability` input reports unavailable. No slot is ever filled from peer-supplied text. Rev 2 claimed these were "asserted by test, not by intent" while §7 enumerated no such test — the same category of unbacked claim it criticised rev 1 for. **Tier-1 (three):** across the verdict × gaps × L2 × journal cross-product the rendered block matches an approved snapshot and contains no member of the forbidden-phrase set; with `capability.layer2:'off'` the block names no merge/pool recovery path; the scope paragraph is present whenever any turn is listed. |
| DP2 | **Which peers to include in the merge** | `invariant` | "Every machine the registry lists as online" — no ranking, no selection judgment. A peer either answers within the timeout or is named as absent. |
| DP3 | **Ordering of merged rows** | `invariant` | Ascending `messageId` (one Telegram counter). Deterministic and verified against live cross-machine data (§1.3). |
| DP4 | **Divergent text on an equal `messageId`** | `invariant` | Retain both and flag. Deliberately not a judgment call: picking a winner would silently discard a real message, which is the failure class this spec exists to close. |
| DP5 | **How to qualify a summary built over a partial transcript** | `judgment-candidate` | Competing signals: summary usefulness vs. the risk that a smooth narrative hides its own gaps. **Floor:** bounded action space = {qualify-in-place, regenerate-from-merged, suppress-summary}; **conservative default (rev 2) = qualify-in-place**; suppression is removed in rev 4 (it would have let a false corroboration delete all pre-tail context). Rev 1 defaulted to suppress on the reasoning that "keeping an unqualified summary degrades truthfulness" — correct as far as it goes, but it assumed the summary was redundant with the message list, and it is instead the sole carrier of all pre-tail context. Qualifying satisfies the no-overstatement invariant at zero context cost, which strictly dominates; **fallback ladder** ends at the deterministic rung `qualify-in-place` (rev 4 — suppression removed; DP5's action space is {qualify-in-place}). Arbiter: the shared formatter, from deterministic inputs — no LLM in this path. |

**Rev-2 correction.** Rev 1 closed this section with *"No decision point in this spec gates an outbound message, blocks a tool call, or constrains a session's actions."* That was contradicted on its face by rev 1's own block text three pages earlier (*"Do NOT answer a listed turn"*), which is a directive injected into an agent's context whose purpose is to change what the session does. Structurally the spec introduces no block/allow authority — but *Signal vs. Authority* is precisely about a signal wearing authority's clothes, and imperative wording sourced from a proxy symbol is that.

The honest statement for rev 2: **this spec introduces no mechanical gate, and DP6 carries behavioural influence that is bounded by INV-1/2/3** — the block reports evidence and prescribes answering-with-the-uncertainty-named, never silence and never a hand-back. That boundedness is the floor, and it is asserted by test, not by intent.

## Multi-machine posture

> **REV-5 NOTE (2026-08-21) — nine rows below are now REFUTED, not merely pending, and the
> taxonomy has no key for what replaces them.**
>
> Nine rows key `operator-ratified-exception (PENDING — Q9)`. Q9 asked the operator to
> ratify exactly that locality for conversation content. **He ruled against it** (see the
> OPERATOR DIRECTIVE section: OD1, OD2). So those markers do not cite a ratification that is
> still outstanding — they cite one that was **explicitly denied**. A pending citation is an
> unfinished errand; a denied one is a false claim, and it is the more misleading direction,
> exactly as row 1 argues about `unified`.
>
> **The correct posture for each of them is `unified`** — that is the ratified destination.
> **But the mechanism does not exist yet**, so declaring them `unified` today would repeat the
> "infeasible unified" error this same table already caught twice (rows 1 and 7).
>
> **And there is no honest third option in the closed taxonomy.** Its three keys are
> `physical-credential-locality`, `hardware-bound-resource`, `operator-ratified-exception`
> (`scripts/lint-machine-local-justification.js`, where widening the set is marked
> constitution-bound). None expresses *"unified is the ratified destination; the surface is
> machine-local only while the mechanism is being built, and here is the trigger that closes
> it."* The rows are therefore left AS THEY STAND, visibly refuted, rather than re-keyed into
> a marker that would be equally untrue and merely quieter.
>
> **This generalises past this spec.** Any surface migrating from machine-local to unified
> lands in the same hole, which is a plausible contributor to the 62 undefended machine-local
> postures the marker sweep reports fleet-wide. Raised as a candidate fifth amendment in
> `docs/proposals/amendment-multi-machine-outcome-not-storage.md`; widening a closed taxonomy
> is the operator's decision, so this spec names the gap and invents nothing.

Every surface this spec introduces, with its declared posture. Default is `unified`.

| Surface | Posture | Note |
|---|---|---|
| Conversation history **read** for session bootstrap — **while L2 is dark/dry-run (i.e. every shipped configuration)** | **machine-local** · `machine-local-justification: operator-ratified-exception (PENDING — Q9)` | Rev-2 correction. Rev 1 declared this `unified` and justified it as "the entire point of Layer 2" — but FD2 ships L2 dark on the fleet and dry-run on dev, and §3.2 states that in dry-run *the session still receives the local-only Layer 1 block*. So the posture table described a post-enforce end-state as if it were the shipped surface, and an auditor reading it would record this as solved. Per the standard's bidirectional check, an **infeasible `unified`** is as much a material finding as an undefended `machine-local` — and it is the more misleading direction. The staged rollout is a deliberate operator-ratified choice, not a physical constraint, so that is the honest key. |
| Conversation history **read** — after the L2 enforce flip | **proxied-on-read** | This is the entire point of Layer 2: the read merges every online machine's view at spawn (§3.2). Named merged read: `GET /telegram/topics/:id/messages?scope=pool` (§3.3). |
| Gap detection + the history block itself | **unified** | Computed over the merged set when Layer 2 supplies one; over the local set otherwise, in which case the block *states* that scope rather than implying a wider one. |
| Pool-scope history read route | **unified** (proxied-on-read) | Standard `?scope=pool` fan-out with `pool: { peersOk, failed }`, tolerant of a dark peer. |
| ~~S4 peer session-lifecycle read~~ (RETIRED rev 4 with FD42; row kept struck so the audit trail shows it was declared) | **machine-local** read over *replicated* state · `machine-local-justification: operator-ratified-exception` | The read is local; the DATA is a replica of another machine's stream whose completeness depends on a dev-gated flag (§3.1.5) and a 30s presence-tick cadence. This is precisely the "looks unified, behaves machine-local" surface the standard exists to force into the open. A missing row degrades to a hedge, never a false all-clear (FD30). |
| FD7 gap-audit trail | **machine-local** · `machine-local-justification: operator-ratified-exception (PENDING — Q9)` | Per-origin observability; carries no message text (FD32). |
| FD43 outbound index — **while `stateSync.historyIndex` is dark (every fleet configuration)** | **machine-local** · `machine-local-justification: operator-ratified-exception (PENDING — Q9)` | Round 4: rev 4 keyed this `unified`, repeating the row-1 "infeasible unified" error — the flag resolves live on dev / dark on fleet, so the shipped surface is machine-local. |
| FD43/FD44 `history-index` — when enabled | **unified** (replicated journal kind) | Content-free activity metadata — incl. USER-turn message ids and placement epochs, never text — on every pooled machine; folded into Q9. |
| `GET /conversation-history/block` | **machine-local** · `machine-local-justification: operator-ratified-exception (PENDING — Q9)` | Local rows + the local replica only; added round 4 (the table claimed "every surface"). |
| `GET /conversation-history/capability` (FD46) and `GET /conversation-history/merge` (§3.2.1) | **machine-local** · `machine-local-justification: operator-ratified-exception (PENDING — Q9)` | Same class as `/block`; added round 6. |
| Layer 2 dry-run soak counters | **machine-local** · `machine-local-justification: operator-ratified-exception (PENDING — Q9)` (rev-2 re-key; rev 1 said `hardware-bound-resource`, which does not survive contest — nothing about a counter is bound to hardware) — these count *this machine's own* fan-out attempts, latencies, and contribution tallies. A pooled aggregate would be a different (and less useful) measurement: the question the soak answers is "does the fan-out from THIS machine reach its peers", which is inherently per-origin. Read across machines via the existing per-machine route rather than replicated. |
| The Telegram **long-poll seat** | **machine-local** · `machine-local-justification: physical-credential-locality` | Genuinely credential-bound: one machine holds the polling connection at a time. |
| The underlying `telegram-messages.jsonl` / `topic-memory.db` | **machine-local** (unchanged, pre-existing) | `machine-local-justification: operator-ratified-exception (PENDING — Q9)` (rev-2 re-key). Rev 1 keyed this `physical-credential-locality` on the grounds that "the log is written by whichever process holds the Telegram bot token and its polling connection" — **which this spec's own §1.1 refutes**: outbound rows are written by whichever machine *answers*, which is explicitly not the polling seat, so both machines hold the credential and both write the log. The store is split precisely *because* it is not credential-bound. The real reason it stays local is §6.1's at-rest-exposure rejection — a policy choice, which the closed taxonomy routes through operator ratification. Obtaining that ratification is a named precondition of the build. A justification that does not survive the spec's own problem statement would not survive an audit. This spec deliberately does **not** change that (see §6.1: replicating the content is rejected on at-rest-exposure grounds) — it changes the READ to be unified over these local writes. |

**Explicit bidirectional check.** The history read is *not* left machine-local: an undefended machine-local read is precisely the defect being fixed. Conversely the underlying store is *not* claimed `unified`: attempting to replicate it would create the plaintext-conversation-on-every-machine exposure §6.1 rejects, and the bot-token/polling seat genuinely is single-machine.

## Frontloaded Decisions

Decisions resolved here so the build does not stop mid-run to ask.

- **FD1 — Layer 1 ships always-on with no flag.** A dark honesty feature guards nothing. Not revisitable at build time.
- **FD2 — Layer 2 ships dev-gated with `dryRun: true`.** In dry-run the merged view is computed and logged; the session still reads the local-only Layer 1 block. The enforce flip is the operator's, on soak evidence.
- **FD3 — v1 covers BOTH the SQLite (`TopicMemory`) and JSONL branches.** Resolved by measurement (§1.4): the SQLite branch is the preferred path and carries the harder false claim. A fallback-only fix is not a fix.
- **FD4 — Merge key is `messageId`; ordering is ascending `messageId`.** Resolved by measurement (§1.3).
- **FD5 — Peer rows are never written to the local store.** In-memory at spawn only. Writing them would re-create the §6.1 exposure by the back door.
- **FD6 (rev 2 reversed; rev 4 final) — Summary handling is `qualify-in-place`, universal; suppression REMOVED. NOT cheap-to-change-after.** Rev 1's cheap tag claimed suppression sat "behind the same dev gate" — it does not. Summary handling is specified inside **always-on Layer 1**, with no gate and no dry-run, so there is no gate to make it reversible, and it changes what every resuming session reads: a published, agent-visible interface, which the closed taxonomy never treats as cheap.
  The reversal is on substance, not just process. DP5 assumed the summary is redundant with the message list. **It is not** — in `TopicMemory.formatContextForSession` the summary is the ONLY representation of everything older than the recent tail (default 50), so on a long conversation it carries hundreds of messages the list omits. And §1.1 establishes that a gap is the *normal* state for any topic the poller does not own, while FD2 ships Layer 2 dark — so "gap survives the merge" is the **standing condition on every split conversation from day one**, not an edge case. Rev 1 therefore silently deleted all pre-tail context on the majority path, with no marker that anything was dropped — a block that *understates* its scope invisibly, which violates the same invariant as overstating it.
  **Rev 4 rule: `qualify-in-place` is UNIVERSAL; suppression is removed (the `:1015` downstream trap below is retained as history — with no suppression there is nothing to place downstream).** Rev 3 reserved suppression for the corroborated case — which made a *false* corroboration delete all pre-tail context, falsifying INV-1's own cost row ("degrades to today's behaviour, survivable"). FD6's dominance argument already said qualifying "strictly dominates"; rev 4 follows it. The prepended qualifier (*"this summary was generated from this machine's view of the conversation, which has the gaps listed above"*) is the whole rule; DP5's terminal rung is `qualify-in-place`, and no verdict — true or false — ever deletes context.
  **Implementation trap (must be specified, not discovered):** `TopicMemory.ts:1015` is `if (ctx.recentMessages.length === 0 && !ctx.summary) return '';` and callers treat the empty string as the trigger to fall through to the JSONL branch. Suppression implemented by clearing `ctx.summary` upstream of that check would make a summary-only topic silently take a completely different code path and discard the Layer 1 block computed here. Suppression must happen strictly downstream of that check; Tier-1 test for a summary-only topic.
- **FD7 — A detected gap writes an audit row, and does not raise an attention item.** A gap is routine on a split conversation; an attention item per gap would flood the very surface it would be reported on.
- **FD9 — RETIRED by FD42 (S4 deleted).** Text preserved in Appendix A.
- **FD10 — RETIRED by FD42 (S4 deleted).** Text preserved in Appendix A.
- **FD27 (RESOLVED round 2 — v1 does NOT graduate the journal; it ships honest without it).** The constitution gate's round-2 finding was that rev 2 named two exits and took neither, which leaves a live decision parked on the operator. Taking the conservative one, which is the author's to take:
  **v1 does not depend on, and does not graduate, `multiMachine.coherenceJournal.enabled`.** Graduating a dark flag fleet-wide is operator authority and stays theirs. What v1 owns is being *honest without it*: on a fleet agent the block lists hedged gaps (FD29 as corrected — peers present means gaps ARE listed), names the third state explicitly (*"peer-session corroboration is not available on this machine"*, §3.1.5), and never implies a capability it lacks. Layer 1's value on the fleet is therefore the honest-scope header plus a named gap list — smaller than rev 1 claimed, and real.
  Graduation becomes a **tracked follow-up with a named owner and a review date**, not an implicit dependency — per *A Dark Feature Guards Nothing*, and per *Close the Loop* an untracked intention is an abandoned one. This is also why §6.4's history-index alternative matters: it is the option that makes the corroboration reachable *without* requiring the operator to graduate anything, because Layer 2's fan-out can answer an index question on demand.
- **FD28 — Layer 1 carries a defect escape hatch, not a feature flag.** FD1 is right that Layer 1 must not ship dark — which is exactly why it needs a way to contain a *defect* without a release. **The catch lives at each converted CALLER** (rev 4 — it cannot live in the formatter: FD35 strips the legacy fields, so "legacy verbatim" is reconstructable only at the callsite, which still has its pre-existing rendering path in scope): on any throw the caller falls back to its own legacy rendering plus one audit line. Plus `monitoring.conversationHistoryBlock.emergencyDisable` (absent ⇒ ON), read live at the chokepoint — an emergency-disable ONLY, never an enable flag — **with a `guardManifest` row using the `extractGuardPosture` inversion (a new per-key branch in `guardPosture.ts`, `component: 'ConversationHistoryBlock'` as the lint's join key) and `loadBearing: true`** (round 3: without it the only switch that can turn the safety property off is invisible to `GET /guards` and the tripwire, and `lint-guard-manifest.js` keys on filename suffixes `ConversationHistoryBlock.ts` does not match, so CI would stay green).
- **FD29 — On a single-machine agent, S1-only gaps are NOT listed.** Every ordinary cold start produces a null-session user row, and with no peers the probability it was answered elsewhere is zero by construction. Without this rule, Layer 1 — always-on, no flag — would emit a standing hedge on essentially every conversation resume across the entire single-machine fleet, turning a safety feature into noise and training readers to ignore it. The header still states this machine's scope; the cross-machine hedge list is empty. **But (round 3) the per-message hook's deleted `UNANSWERED` imperative was CORRECT on a single-machine agent** — there, "user row with no following agent row" means *genuinely unanswered* by construction, and deleting it (FD36) while FD29 lists nothing would remove a working forcing function from the majority of the fleet. So when `peerCount === 0` the server-supplied block carries a distinct **`GENUINELY UNANSWERED`** group (exact claim, no hedge wording, no noise problem) with the address-this imperative — in the closed DP7 set. Tier-3: a single-machine agent receiving "hello?" after an unanswered turn still gets an instruction to address the earlier turn.

**CORRECTION (round 2) — the suppression applies ONLY to a genuinely single-machine agent.** Rev 2's draft added "the same suppression applies when peers exist but journal replication is off." Compose that with §3.1.5 (journal dark on the fleet) and FD2 (Layer 2 dark) and the result is that **on a normal multi-machine fleet agent, the incident's own turn 52134 would not be listed at all** — the shipped feature reduces to a header relabel, and G3 ("a gap is named") is unmet in every configuration anyone actually runs. Each rule was defensible alone; together they cancelled the feature out.

The rule is therefore: **peers exist ⇒ S1-only gaps ARE listed**, hedged, regardless of whether corroboration is available — because on a multi-machine agent "not handed to a local session" carries a real cross-machine implication, which is precisely the incident. Only the zero-peer case suppresses. The Tier-1 52075 regression fixture pins the **fleet** configuration (peers present, journal replication off, Layer 2 dark) — otherwise it tests a path no agent runs.
- **FD30 — A turn whose symbol is unmeasurable HEDGES; it never becomes "no gap".** Applies uniformly to: a truncated journal read, a rotated-away window, `topic: undefined`, a peer stream flagged `suspect`/`gapped`/`reset-flapping`/quarantined, an un-merged origin, a skewed peer clock, and `provenance: undefined` on a legacy row. **The string "no gaps detected" is FORBIDDEN on any block whose inputs were truncated** — otherwise the budgets added for cost reasons would quietly reintroduce the very false-completeness defect this spec exists to close.
- **FD31 — All test fixtures are SYNTHESIZED, never copied from live logs.** Fixtures reproduce the *structure* of the incident (a null-session user row, an automation row, an agent row; a `seq` numerically equal to a topic id on a row with no `topic`; disjoint id sets across two machines) with synthetic text and ids in a reserved test range. No row of real operator conversation content enters `tests/fixtures/`. Copying is the path of least resistance and would commit real conversation text to a git-tracked repo permanently — a durable at-rest exposure this spec's own §6.1 argues against everywhere else.
- **FD32 — No soak counter, audit row, or divergence record may contain message TEXT.** A divergence records `(topicId, messageId, machineA, machineB, sha256A, sha256B, lenA, lenB)`; gap audit rows carry timestamps, ids and counts. FD5 closed the durable-store back door into §6.1's rejected exposure; this closes the logging back door, which the natural "log both texts so a human can diff them" implementation would otherwise open on every machine running the soak.
- **FD33 — S5 is a LAYER 2 signal; Layer 1 stays zero-network.** Two reviewers caught that rev 2 introduced S5 to fix S4's P20 defect and shipped it with no data source in the layer it sits in — the identical "capability the fleet does not have" error §3.1.5 had just caught for S4, reproduced one section earlier. Resolved, **as amended by FD41 (round 3 — the two were contradictory as first written)**: S5's evidence is the content-free outbound index row `(topicId, messageId, machineId, provenance)`. The `LATER REPLY ELSEWHERE` group is emitted when that evidence is present by EITHER route: (a) the replicated index, when journal replication is on — a local, zero-network lookup; or (b) the Layer 2 fan-out's digest, when the L2 gate resolves ON **and** `dryRun: false`. When neither route is live the group is absent and the block renders two groups. Layer 1 itself still makes no network call — route (b) is Layer 2's. The rollout table, DP6's ladder and the output examples carry this two-route availability, not "L2-enforce only". **Tier-1 (rev 4): no `LATER REPLY ELSEWHERE` group when NEITHER route is live.** Layer 1's "makes no network call" is restored as a true invariant. §4 gains "S5 unavailable ⇒ hedge — never to no-gap"; the Tier-1 case is §7's NEITHER-route-live assertion (the pre-amendment "when L2 resolves off" would fail the correct build when the replicated index is live).
- **FD34 — RETIRED by FD42 (S4 deleted).** Text preserved in Appendix A.
- **FD35 — The shared formatter's contract is DECLARED here, not discovered at build.** Round-1 finding, still open in rev 2 while the callsite count grew from five to ten:
  ```ts
  formatConversationHistoryBlock(input: ConversationHistoryBlockInput): ConversationHistoryBlockResult
  interface ConversationHistoryBlockInput {
    topicId: number; topicLabel?: string; localMachineId: string;
    rows: MergedHistoryRow[];                      // normalized by the caller; TopicMemory-sourced for peer rows (scope established)
    summary?: { text: string; coversThroughMessageId: number; coveredCount: number };
    capability: { layer2: 'off'|'dry-run'|'enforce'; journalReplication: 'available'|'unavailable';
                  historyIndex: 'local'|'via-l2'|'unavailable'; peerCount: number };   // INV-3's declared home
    contributions: Array<{ machineId: string; rows: number;
                           state: 'ok'|'unreachable'|'skipped-for-budget'|'partial'|'url-rejected'|'scope-unavailable' }>;
    truncated: boolean; labelOverride?: string;
    signals: Array<{ messageId: number;
      locallyUnanswered: boolean;                      // S1, derived by the CALLER from LogEntry.sessionName
      s5: { peerMachineId: string; peerMessageId: number; route: 'index-local'|'index-via-l2'; provenanceCarried: true } | null;   // CALLER precondition: populated only when the peer holds a topic-placement ownership record for this topic
      evidenceTruncated: boolean; }>;                  // FD30 ⇒ forces hedge
  }
  // A messageId ABSENT from `signals` is `unverified`, never "no gap" (Tier-1 asserts it).
  interface ConversationHistoryBlockResult {
    text: string;
    verdicts: Array<{ messageId: number; group: 'later-reply-elsewhere'|'unverified'|'genuinely-unanswered' }>;   // rev 4b: S4's group retired
    headerEarned: boolean; auditRow: GapAuditRow;   // auditRow carries NO text (FD32)
  }
  interface MergedHistoryRow {
    messageId: number; topicId: number; text: string; timestamp: string;
    provenance: 'user'|'agent'|'automation'|'unknown';
    machineId: string; origin: 'local'|'peer';
    contentOrigin: 'first-party'|'third-party'|'unknown';
  }
  ```
  The formatter is **pure and synchronous**: no I/O, no network. S4/S5 results arrive via caller-injected inputs so the journal read stays testable and outside the formatter. `MergedHistoryRow` carries **no** `forwarded`, `telegramUserId`, `senderName`, `senderUsername`, or `sessionName` — this resolves the §3.1.6(b)/(c) contradiction: `contentOrigin` is derived at construction (`forwarded === false` ⇒ first-party; `!== false` ⇒ third-party; every peer row ⇒ unknown, fail-safe).
  **Round-3 correction — brand the CONSUMER, not the producer (measured by `tsc --strict`, twice, independently).** Rev 2 omitted fields (makes a type MORE assignable). Rev 3 branded `MergedHistoryRow` with a unique symbol — which blocks the *wrong direction*: TypeScript permits excess properties on non-literal assignment, so `resolveStandingAuthorization(merged)` with a branded `MergedHistoryRow[]` **compiles clean**, and the prescribed wiring test written as an object literal goes green on the excess-property check while production (an array variable) is unprotected. A `never`-typed member on the source also compiles clean. **Required:** `OperatorHistoryRow` — the resolver's input — gains a required nominal member `readonly [localLogOnly]: true`, stamped only by the local-log reader; passing `MergedHistoryRow[]` then fails with `TS2345`. The wiring test asserts the failure on a **variable**, not a literal. The runtime `forwarded === false` / attributable-uid checks remain the independent second line; the type system carries no part of this boundary until the *target* is branded. The runtime invariant is stated and tested separately: the merge never writes into any source `getTopicHistory` reads (FD5), and the resolver's own `forwarded === false` / attributable-uid checks are the second independent line (the spec credits them rather than pretending the type does the work).
  **Privacy boundary (round 2, §5).** Rows carry `privacy_scope` (`'private'|'shared-topic'|'shared-project'`, defaulting `private`) and a per-user filter enforces it today. Rev 2's field omission stripped `userId`, the key that filter depends on. `MergedHistoryRow` therefore carries `privacyScope` and an **opaque, non-authority-bearing** `ownerKey` (never `telegramUserId`); a peer-origin row whose scope cannot be established is treated `private` and **excluded** (fail-safe); §3.3's pool-scope route applies the same filter the local per-user read applies. Tier-2: a multi-user topic's pool read excludes another user's private rows.
- **FD36 — The per-message hooks render a server-supplied block and own NO detection logic (rewritten whole in rev 4b after a regex edit corrupted it).** `GET /telegram/topics/:id/messages?block=1` returns `{ block: string, hedged: boolean, messages: <existing shape> }` — ONE fetch serves both the block and the rows the fallback needs (N9); `topicLabel` is REQUIRED server-side on this path (the session-start hook currently takes `topicName` from `/topic/context`); `block` is never empty on a 200 (an empty conversation renders the "empty local history" block). Built by the shared formatter with `capability` resolved server-side, from local rows plus the replicated outbound index when `capability.historyIndex:'local'` (an O(1) lookup) — **Layer 2 never runs on the per-message path**. Server ceiling: **≤5 ms of event-loop-blocking time** per request, measured with `process.hrtime.bigint()` around the synchronous section (row fetch + index lookup + formatter — for synchronous code wall time IS loop-blocking time), exposed as `blockRenderMs {p50,p95,max}` + `overruns` on `/conversation-history/block`; round 4 corrected the instrument — `WriteAdmission`'s `monitorEventLoopDelay` is process-wide, 20 ms-resolution and reset every 5 s, so it cannot attribute 5 ms to one request; it stays only as the global starvation backstop. The budget holds because the inputs are bounded: rows ≤30 from the O(limit) tail cache, an in-memory index lookup, an O(rows) formatter (measured: the privacy-filtered TopicMemory query 0.17–0.5 ms, `COUNT(*)` 0.02 ms) (rev 3's 150 ms wall-clock was ~75,000× the measured 0.002 ms of formatting work, on the hottest path); an overrun returns 200 with `hedged:true`. All three hook literals (telegram-topic-context, compaction-recovery, session-start) print `block` verbatim; their own detectors and the `*** UNANSWERED MESSAGE(S) FROM USER ***` imperatives are **deleted, not narrowed**. Fetch: `--max-time 1 --connect-timeout 1`; **total per-prompt hook budget ≤4 s wall** across every call the hook makes (the existing health + session-clock + briefing calls plus this one; session-start's data source moves from `/topic/context?recent=30` to the messages route — the `summary` still arrives via FD35's input). **Fallback, keyed on response SHAPE (an old server ignores `?block=1` and answers 200 without `block`):** on a 200 lacking `block`, any non-200, or timeout, the hook renders history from the `messages` it already holds — WITHOUT the imperative — PREPENDED with one line `[server history block unavailable (<reason>) — this machine's local view only]` so the weaker path is visible (No Silent Degradation); `<reason>` is a **closed enum** (`timeout | connect-failed | http-<3 digits> | no-block-field | curl-exit-<n> | local-render-failed`), never body bytes, ≤32 ASCII chars — a Tier-1 asserts a hostile response body never reaches the notice (N8). Only if local rendering itself fails does the hook print that one line alone and exit 0 — never empty output (A Refusal Stays a Refusal). **Fresh-init gap:** `installHooks()` never wrote `telegram-topic-context.sh` (only `migrateHooks()` did — `migration-parity-hooks.test.ts:60` records the ~30-min fail-silent window); v1 adds it. Canonical byte source for every hook is the migrator literal; the telegram hook's template is deleted and the other two are pinned by an equivalence test (§8).
- **FD37 — RETIRED by FD42 (S4 deleted).** Text preserved in Appendix A.
- **FD39 — The replicated outbound index is journal-derived SIGNAL under §3.9, never authority.** Generalised in rev 4 from the retired interval index to the §6.4 outbound index, which rides the same journal: it may only widen or narrow a warning's wording. Enforcement (restored in round 4 — the retirement one-liner had regressed to the weaker form): the index module is added as a **banned import TARGET checked across all of `src/**`**, NOT to the lint's hand-curated eight-file `ACTUATOR_FILES` list (which deliberately excludes `src/commands/server.ts`, where `spawnSessionForTopic` lives). MEASURED: no listed actuator imports it. CERTIFIED: nothing about the composition root — stated. Its header names §3.9.
- **FD40 — INV-1's MEASURED-vs-CERTIFIED gap is declared, and v1 records it as an UNENFORCED sub-obligation.** INV-2 and INV-3 constrain generated *text* and are structurally testable. INV-1 is different in kind: the harm it prevents is **silence**, which emits no message for the outbound gate, the B15–B19 family, or response-review to inspect — so its entire assurance is a test that a paragraph is present. MEASURED: the block contains the required sentences. CERTIFIED: a session does not go silent on a listed turn. Those are not equal, and rev 2 did not say so. The structure that *could* certify it exists (`PresenceProxy` fires on an unanswered user message; registering a listed turn so continued silence surfaces), and **v1 does not build it** — stated as an unenforced sub-obligation with owner Echo and review date 2026-09-04, per the registry's own convention, rather than as a test that certifies nothing. **Structural path named (round 5, codex):** the formatter's `verdicts` are machine-readable; a PreToolUse hook that consults a per-topic "listed action turn" marker before a side-effecting Bash/MCP call would certify INV-1a without prose — tracked as ACT-090, its own spec, not smuggled in here. **Rev 4: a date in an `approved:false` draft is the untracked intention Close the Loop names** — this and FD27's graduation follow-up are registered as durable beacon-enrolled commitments (ids in §0), independent of whether this spec converges.
- **FD38 — The forward ratchet keys on BEHAVIOUR, with the header string as a second net.** Round 2: rev 2's string-keyed ratchet is one abstraction level behind the exact mistake round 1 found (a sweep over builder *names* missed three surfaces) — builder ten writes `--- PRIOR MESSAGES ---` and passes. Primary key (mirroring `no-silent-llm-fallback`'s method): any callsite that reads conversation history (`getTopicHistory`, `getTopicContext`, `getRecentMessages*`, `formatInlineHistory`) and renders it into session/prompt context must go through `ConversationHistoryBlock.ts` or appear in a named, reasoned allowlist. Second net (rev 4 — rev 3's pattern was MEASURED to miss three live headers; "one abstraction level behind" applied to its own remedy): the widened scan `/---[^\n]{0,80}\((?:[^()\n]*\b)?(?:last\s+)?\S*\s*(?:total\s+)?messages?\)/` plus the literals `RECENT HISTORY (auto-injected`, `SUMMARY OF CONVERSATION SO FAR:`, `UNANSWERED MESSAGE(S) FROM USER`, over `src/**/*.ts`, `src/templates/hooks/**`, AND the migrator's inline hook literals (carve-out scoped to the literal, never the file). **The ratchet test ships with a seed corpus of every enumerated surface's CURRENT header and asserts each matches** — proven against known positives. Shell hooks have no behavioural key; the string net is their sole guard, stated. (shell + inline Python — the per-message hook is not TypeScript and is the highest-frequency surface). Pattern family: `/---\s*(Thread History|TOPIC CONTEXT|[A-Za-z ]+)\s*\((last |)\d*\s*(total )?messages?\)/` plus the literal `RECENT HISTORY (auto-injected`. Carve-outs are a named allowlist in the test, each with a one-line reason; an unlisted match fails CI.
- **FD44 (round 5 — SUPERSEDES the agent-reply-only index) — the index is a per-origin MEMBERSHIP SET of every row each machine holds: `(topicId, messageId, provenance, placementEpoch)`, both directions.** The clean-door reviewer's point: with every row indexed, "rows held elsewhere and not shown here" is the exact set-difference `⋃peers − local` — classification-free — and it RETIRES the S1 `sessionName:null` heuristic WHEREVER THE INDEX IS LIVE (a turn is listed because a peer provably holds a row this machine does not, not because a local field was null); where `capability.historyIndex` resolves `'unavailable'` — every fleet configuration today — S1 stays, so the listing rule and the regression fixture are unchanged there (round 5: the first wording would have un-flagged 52134 on the fleet). Provenance only tunes WORDING (`agent` ⇒ "a later reply from <machine>", `automation` ⇒ "a system notice", `user` ⇒ "a turn of yours recorded there"). Consequences: `messageKind` threading, the relay-script `reply` stamp, `isSystemTemplate`, and the positive-control fragility all leave the critical path (the stamp stays as a wording nicety, not load-bearing); the relay-echo stamp stays (two origins holding one messageId is a legitimate duplicate the set-difference dedupes by `(topicId,messageId)`). Volume ~10× the agent-only estimate (~500 KB/day/origin at this machine's mix) — still trivial against the 4 MiB rotation. Kind renamed `history-index`. FD43's declaration (registry, retention, prune, resident Map) carries over except the row shape and the write site: the index row is emitted from the `appendToLog` METHOD BODY (`TelegramAdapter.ts:3853`) — the single funnel behind all six callers (`:1302, :1475, :4944, :5128, :5205, :5275`). Retention arithmetic under FD44: ~500 KB/day/origin ⇒ 4 MiB × 4 ≈ **32 days** of own-stream coverage (not ~600), and the 256-row resident cap, per topic CLASS (round 6): system-automation topics (attention hub, lifeline — 72% of all rows) ≈ 0.8 day; conversational topics (38–116 rows/day, 30–55% agent) ≈ 2–7 days and ~80–130 agent replies — the cap covers the 30-local-row window in the normal case; the one class that legitimately truncates is an autonomous-run topic emitting ≥250 automation rows/day (safe direction). The earlier "≈26 agent replies" was the global-mix figure and is retired.
- **FD45 (round 5) — the ownership cross-check is CLOCK-FREE: the placement `epoch` is stamped onto the index row at write time and compared as an integer.** Rev 4c's "highest-epoch record whose timestamp precedes the index row's envelope time" compared a local placement timestamp to a peer envelope time — the cross-clock comparison this spec refuses in §3.2 and retired S4 for. Round 5 corrected the premise: `TelegramAdapter` holds NO placement state (zero references in source) — the epoch lives in the `topic-placement` journal / ownership store, so the adapter receives an injected `placementEpochLookup(topicId) → epoch | null` = `LocalSessionOwnershipStore.read(sk).ownershipEpoch` (synchronous; already read sync at `server.ts:23069`) — wired via a late-bound `setPlacementEpochLookup()` because the adapter is constructed (`server.ts:7539/7634`) before the ownership store exists; until wired the lookup returns `null`, which is FD45's existing null rule covering the boot window; `null` (un-placed, pin-only `owner:null`, or single-machine topic) ⇒ the row carries no epoch and never qualifies. Mid-transfer (round 6): (a) P's registry still says `{owner:P, epoch:e}` (CAS propagation lag) ⇒ stamp e, decided by the high-water rule; (b) P's registry already says `{owner:P′, epoch:e+1}` ⇒ stamp e+1, asserter ≠ named owner ⇒ `unverified` — drain-window replies lose corroboration, accepted and stated; (c) pin-only move ⇒ `null` (only automation rows exist then — wording-only). The stamped counter and the verifier's counter are the SAME sequence — `emitPlacement` is driven off `ownReg.cas` — pinned by a Tier-1 asserting the `topic-placement` record's `epoch` equals the registry's `ownershipEpoch` for the same transition. A row qualifies when its `placementEpoch` matches a placement record for that topic naming the asserting origin as owner, from a record whose origin ≠ the asserter; a self-stamped epoch with NO non-self record naming P ⇒ `unverified`. **And (round 5, lessons N2 — both the timestamp rule and the bare epoch rule let the ASSERTER pick an epoch it once held):** the POLLER (the one machine that sees every inbound id; NOT the placer — placement records are written by whoever ran the CAS, and most transitions run with no message in scope) emits a row of the NEW `history-index` kind `{topicId, epoch, highWater, provenance:'placement'}` into its own stream at the moment it observes each epoch change (it replicates placement records, so it sees every epoch). Round 6 (integration) corrected the carrier: it must NOT ride `topic-placement`, a legacy kind with a CLOSED field list on both sides — emit drops unknown keys silently, receive REJECTS the record and marks the ownership stream `suspect`, halting replication to every not-yet-updated peer (the documented 2026-06-30 shape) — and `topic-placement` replicates under the journal flag alone, outside the `stateSync.historyIndex` gate Q9 assumes bounds this data. As a `history-index` row it rides the registry schema, the dark gate, and the old-peer-ignores behaviour. Its origin is the poller, ≠ the asserting peer unless poller == asserter, which the non-self rule refuses. **The counter itself must be BUILT (round 6, lessons): nothing tracks a `message_id` high-water today — `TelegramAdapter.lastUpdateId` is Telegram's `update_id`, a different counter** — so the poller records, per (topic, epoch), the `message_id` of the first inbound it routes under that epoch, persisted beside `lastUpdateId` in the poll-offset file (else a restart loses the pending back-fill). Three edges, stated so a builder does not "fix" them: (a) the applier fast-forwards on `ownershipEpoch > curEpoch` and `topic-placement` keeps no archives, so "`highWater(e+1)`" means *the lowest local placement record with epoch > e*; none ⇒ unmeasurable ⇒ only `e === currentEpoch` qualifies; (b) `getUpdates` never returns the bot's own messages, so a peer reply sent just before a transition can exceed the high-water ⇒ `unverified` — correct under-promotion, never to be widened; (c) the bound is chat-wide (Telegram ids are per chat), not per topic. A fourth placement emitter exists — `OwnershipReconciler` `reconcile-adopt` (`:465`) — and the poller observes all four. No high-water row for epoch e+1 ⇒ rows beyond epoch e are `unverified` — S5 is then absent on exactly the transfer transitions until the poller's row lands, stated. **And the high-water row's ORIGIN must be ≠ P** (round 6, security): on two normal paths the e+1 transition is run by P itself — release-on-complete (`server.ts:21714`, self-originated) and P-as-lease-holder transferring K away — so a P-originated high-water would let a mis-stamping P author the bound on its own prior-epoch rows; a P-originated row ⇒ high-water unmeasurable ⇒ prior-epoch rows `unverified`. Non-poller emitters never write a high-water (not their stale local max). The bound is CHAT-wide (Telegram ids are per chat). Tier-1: a self-released span ⇒ `unverified`; a row with `placementEpoch = e` qualifies iff e's record names P AND (e is the current epoch OR the row's `messageId < highWater(e+1)`), where **`highWater(e+1)` := the `messageId` of the FIRST inbound the poller routes under epoch e+1 (exclusive bound)** — round 6 (adversarial): "max id seen before the transition" would equal the last inbound of epoch e (52134) and FAIL the incident's own legitimate reply 52162; the first-inbound-under-e+1 definition (52170 in the incident) passes it. Recorded ONLY by the poller, lazily — a transition run by any other CAS runner has no high-water until the poller routes the first inbound under e+1; until then epoch-e rows are checked by "e is current" alone, else `unverified` (not a throw). POSITIVE Tier-1: owner P replies 52162 after inbound 52134; the transition to e+1 is triggered by inbound 52170 ⇒ 52162 qualifies; the same with a self-place transition and no inbound yet ⇒ `unverified`. A peer that owned K at epoch 3 and lost it at 4 cannot corroborate a row written after epoch 4's high-water. Clock-free; Tier-1: an epoch-3 row with `messageId > highWater(4)` ⇒ `unverified`. No timestamps anywhere in the check.
- **FD46 (round 5) — ONE capability resolver.** Reaching full behaviour needs `coherenceJournal.enabled`, `replication.enabled`, `stateSync.historyIndex`, `historyMerge`, two `dryRun`s and `emergencyDisable` to align — the likeliest field failure is flag combinatorics. A single resolver computes `capability` for the formatter AND serves `GET /conversation-history/capability` (effective state, per flag, per route); a Tier-1 iterates the flag product and asserts NO combination yields an unhedged claim.
- **FD41 — The §6.4 content-free outbound index is adopted as S5's evidence shape.** Defined in §6.4; declared as an artifact in FD43; row shape superseded by FD44.
- **FD42 — This spec DEPENDS on `inbound-message-recording-gap.md` as its write half and DELETES S4.** Defined in §6.5. *(Numbering note: FD13–FD26 were never allocated; the list jumps 12→27 by accident of revision history, not omission.)*
- **FD43 — The outbound index is a DECLARED artifact (rev 4; five reviewers independently found FD41 "decided over an undeclared artifact").** Kind `history-index`: added to the closed `JournalKind` union, `JOURNAL_KINDS`, `DEFAULT_RETENTION` (`{ maxFileBytes: 4 MiB, rotateKeep: 4 }` — a kind without a retention entry does not compile), `nextSeq`, the per-kind meta map, the DUAL registry (`ReplicatedKindRegistry`, per the file's own rule), a `multiMachine.stateSync.historyIndex` flag following the WS2 siblings' ACTUAL convention — a `DEV_GATED_FEATURES` entry, the `STORES` list in `state-sync-stores-dark-gate.test.ts`, and a `stateSyncReceive[store]` advert (round 4: the siblings have NO guardManifest rows; rev 4 claimed one), a `ReplicatedKindBounds` rate cap, AND the mirrored receive-side schema in `JournalSyncApplier.validateData` with strict unknown-field rejection **in the same PR** (the applier's own comment records the 2026-06-30 incident). Row `{ topicId, messageId, provenance, placementEpoch }` per held row, both directions (FD44 — the origin is the authenticated stream origin `entry.machine`, never a row field); **`recordKey = topicId:messageId`** — round 4 (N5): the compactor has no exempt set (it skips only unregistered kinds and keeps last-writer per `(origin, recordKey)`), so no exemption is needed or possible: with every row its own key, compaction is an idempotent no-op on this kind; the hazard (collapsing a conversation to one row) belongs to a topic-keyed record, which is precisely why the key is not `topicId`. The Tier-1 "compactor over a synthetic index stream preserves row count" stays — it proves the KEY choice. **`capability.historyIndex` resolves `'local'` only when BOTH `multiMachine.coherenceJournal.replication.enabled` AND `multiMachine.stateSync.historyIndex` are on.** **Write site: BOTH `appendToLog` paths (the single outbound caller at `TelegramAdapter.ts:1475` and the five inbound callers) — FD44 indexes every held row** — NOT `sendToTopic`, which carries an in-source correction that it is *not* the send chokepoint — so the population is honestly "outbound rows appended by `appendToLog`". **Best-effort, never blocks or fails a send**; a shed write (the 100/50-per-s bucket — the burst measurement, max 6 rows in any 2 s window, is the basis, not the daily average) is counted as `indexEmitsDropped` on `GET /conversation-history/block` and hedges the window (FD11 on the write side). **Cross-store coherence invariant (round 4, lessons F10; restated for FD44 in round 6):** index ⊆ log rows of BOTH provenances ∪ sheds, and log rows ⊆ index ∪ sheds, with per-provenance counters — checked hourly over the last 24 h of OWN-origin rows and reported as `indexLogDivergence {indexNotInLog, logNotInIndex, sheds}` on the same route; a divergence is a signal, never a gate. **Relay echo (discriminated at WRITE time — round 4, D6; a read-time "answering machine wins" had no field to decide on):** the tokenless-standby relay branch (`:1401`) appends a row with the holder's `messageId` while the holder appends its own — §1.3's disjointness is bounded to the non-relay case — and the relay hop is discriminated at WRITE time — round 5 (security): the holder CANNOT tell a relay hop from a direct send (the standby forwards the original `messageKind` in `kindMetadata`, `routes.ts:15658`), so the STANDBY adds an explicit hop marker `metadata.relayHop:true` in the relay body and the holder SKIPS the index emit for `relayHop` rows (round 6: the FD44 row has no field to carry a kind, and the pair already dedupes by `(topicId, messageId)`) while the gate/audit keep the forwarded kind; `relayHop` rows are an explicit exclusion class in `indexLogDivergence` so the hourly check does not report them; `'relay-echo'` is added to the `MessageKind` union and `coerceMessageKind`. For an UNSTAMPED pair (older standby — version skew) the read-side tiebreak is deterministic: attribute to the origin whose `placementEpoch` passes the FD45 ownership check; if neither or both, name both (clock-free; consistent with the never-promotes control); counted as `echoUnstamped` beside `indexLogDivergence`. Tier-2 NEGATIVE control: an unstamped pair still collapses and never promotes on either participant. **Origin rule (round 6 — simplified): the row carries NO `machineId` field at all** (it would be rejected by strict unknown-field validation anyway); origin is `entry.machine`, already bound to the AUTHENTICATED mesh sender by rule 1 (`entry.machine !== senderMachineId ⇒ 'forged'`), so there is nothing to mis-stamp and the check is true by construction; the boot warm-scan attributes rows by the replica FILE's origin. **Threat model, stated:** a "forging" peer is one of the operator's OWN machines; these checks defend against mis-stamping and bugs, not an adversary — no security boundary is claimed here. **Version skew (corrected twice in round 4 — the adversarial pass read the applier):** `JournalSyncApplier.ts:418` IGNORES an unknown KIND ("nothing applied, no poisoning (forward-compat)"); it is an unknown FIELD on a known kind that poisons. So an older peer neither marks anything `suspect` nor halts — it silently applies nothing for this kind, and because it never records a cursor for it, the SENDER may re-offer the stream from seq 0 every tick. The real cost is bandwidth, not poisoning. **Build item (corrected round 5 — replication is RECEIVER-driven pull: `PeerPresencePuller.driveJournalDelta` iterates the peer's advert and requests `fromSeq 0` for any kind it holds nothing for, so an old peer RE-REQUESTS the new kind every tick; the sender never "offers"):** a SERVE-side throttle that fires ONLY when the served payload would be IDENTICAL and NON-EMPTY — keyed on `(AUTHENTICATED peer sender id, peerBootId|version, kind, fromSeq, serverHeadSeq)` — resets whenever the served head advances past `fromSeq` — so an EMPTY stream is always served (round 6: the rev-4e key would have starved a standby whose first, rarest index rows arrive after 10 empty ticks, and an upgraded peer whose first request is `fromSeq 0` again, both forever until a server restart); head advance, peer restart or version change resets the key; TTL 1 h backstop; `pullThrottleHits` and `throttledPeers{peer,kind,since}` on the read surface; Tier-2: a peer that fails one apply then succeeds is served on the next tick; the advert-omission variant is DROPPED (a puller requests only advertised kinds, so an upgraded peer would never learn the kind exists); a throttled answer is an EMPTY STREAM, never a fabricated cursor (a fake `lastSeq` would be a silent skip — the unsafe direction under FD44). Unthrottled, an old peer pulls up to 16 MiB per 30 s tick (~4 Mbit/s) — so the throttle is worth having. Tier-2: empty stream → 12 ticks → first row appended → the next request is answered WITH the row. No advertised-kind handshake exists and none is built. **Sizing (FD44 governs — round 6 caught FD43 still describing the agent-only population):** a replicated line is ~481 bytes (envelope); under FD44 the indexed population is EVERY held row, both directions — ~1,000/day here (766 outbound incl. 90% automation + ~82 inbound) — so ~500 KB/day, ~175 MB/yr per origin stream before the 4 MiB × 4 rotation (~32 days of own-stream coverage). The agent-only figures (73/day, ~34 KB/day) are retired with the agent-only design; the per-machine total is own + (N−1) replicas, bounded only once the declared replica prune lands — **round 4, D2: replicas are NOT bounded by `DEFAULT_RETENTION` (it rotates the ORIGIN's own file; `JournalSyncApplier` applies no retention to `peers/`, and the compactor's per-key collapse is a no-op on a per-row key). Declared new behaviour: a per-kind replica prune on the apply path for `peers/<origin>.history-index.jsonl` — rows older than 30 days (the history horizon, defined here), row cap 50,000 per origin; the prune rewrites the file under the applier's lock and never disturbs its seq cursor — with a Tier-1; until it lands, replicas are unbounded and the spec says so.** Scalability round 4 sized it: live replicas already sit at 5× their kind's cap with zero archives (`evolution-action-record` 20.2 MB vs 4 MiB; `subscription-account-meta` 11.2 MB vs 2 MiB) — **this is a foundation defect of EVERY replicated kind**, flagged to `multi-machine-replicated-store-foundation.md` rather than patched only here (ACT-089). The WRITER-side horizon is real: ~600 days of S5 coverage at 34 KB/day, ~62 days at 328 KB/day. **Horizon (round 6 — "resident minimum" was a structural false positive: a pair that never overflowed has a minimum equal to its oldest HELD row, so every earlier window turn read as "evicted" — on exactly the takeover case the index exists for, where the new owner holds rows only from its span): one integer per pair, `evictedWatermark[topic][origin]` = the `messageId` of the most recently EVICTED row (0 if none; the warm scan sets it to the 257th-newest row's id when the file holds >256 for the pair), plus one per origin, `fileHorizon[origin]` = the oldest row surviving the replica prune.** A turn is `index-evicted` iff `messageId ≤ evictedWatermark` for some pair OR `< fileHorizon` for some origin; a never-evicted pair has full coverage for its lifetime, and "not held by that origin" is the correct set-difference answer, not a truncation. This replaces the rev-4e resident-minimum rule. NOT the replica file's minimum (round 5: a file-derived horizon would print "coverage from <ts>" over a span the resident map does not hold, hiding a false-unverified inside claimed coverage). A turn below the watermark is `index-evicted` ⇒ hedge group, and the block states "index coverage from message #<max evictedWatermark>" — a messageId, not a timestamp (the resident structure holds none; envelope `ts` is a peer clock and is display-only if shown at all). **Fail direction under FD44 (round 5, adversarial F5):** because the index IS the gap list, an evicted peer row would otherwise read as "no gap" — the UNSAFE direction — so any window turn at or below a pair's `evictedWatermark` FORCES `indexTruncated` + the hedge for that span, and a topic absent from the LRU resolves `capability.historyIndex:'unavailable'` FOR THAT TOPIC (S1 then applies), never an empty set. The file prune (50,000 rows per origin, across topics) is a DISK bound only; the resident cap is the LOOKUP horizon and is always the binding one. `indexTruncated` = "some window turn is at or below a pair's `evictedWatermark` or below an origin's `fileHorizon`". An optional bounded file-tail read may promote a below-horizon turn — never inside the 5 ms section.. Posture: replicated (`unified`) — row added to the posture table. Tier-2: an old-union applier receives the kind and the sender stops re-offering; a relay-echo pair collapses to one row attributed to the answerer.
- **FD12 — RETIRED by FD42 (S4 deleted).** Text preserved in Appendix A.
- **FD11 — A corroboration signal may never SUPPRESS a Layer 1 warning (single named exception: the §0 WITHDRAWAL rule — a reply VISIBLE in the rendered set withdraws the turn, because no warning is owed for a shown reply).** Generalised from S4 to S5/the index in rev 4: evidence only moves a listed turn between groups; stale or absent evidence degrades to the hedge, never to silence. Not revisitable.
- **FD8 (RESTATED rev 2) — Scope is Telegram in v1; the Slack *hook template* is NOT converted.** Rev 1 contradicted itself in three places: §3.1 said the Slack hook ships in this PR, FD8 said Slack is out of scope, and Q4 still asked which. Resolved against verified migration behaviour: `slack-channel-context.sh` is **not** on the always-overwrite track — `PostUpdateMigrator.ts:10572` says so by name ("the auxiliary shipped scripts that *aren't* on the always-overwrite track"), it is absent from `migrateHooks()`'s ~25 named hooks, its only upgrade path is a one-shot that self-disables on already-updated agents, and it targets a different directory entirely. A history-block change there would reach **zero** existing agents. So converting it in v1 is not merely out of scope — as rev 1 specified it, it would not have worked. Struck from the §3.1 list and from §8.
  **But Slack is not left uncovered:** it shares `formatInlineHistory` with the compaction-resume path (`server.ts:14302`), which v1 **does** convert — so the Slack *channel-context* surface is fixed for free. What v1 does not do is the Slack hook template and the platform-parameterised merge key (Q6). Tracked follow-up, which must carry the missing-migrator cost.

## OPERATOR DIRECTIVE — 2026-08-21, topic 52222 (SUPERSEDES §6.1; Q9 is WITHDRAWN as posed)

Recorded verbatim-in-substance from the live design conversation with Justin (the topic's
VERIFIED operator, uid 7812716706). These are OPERATOR DECISIONS, not author proposals. They
invalidate the premise Q9 was built on: Q9 asked the operator to ratify that conversation
content stays MACHINE-LOCAL. He ruled the opposite way. Q9 is therefore withdrawn as posed —
there is nothing left to ratify in that direction — and the design owes a rev-5 pass.

**OD1 — Single-machine survivability (the governing requirement).** "An Instar agent could exist
AS IS with ANY SINGLE MACHINE it is installed on. If ALL of the other machines but one crashed,
the agent would only be affected by the amount of physical RESOURCES it has access to, NOT the
INFORMATION." This is STRONGER than the coherence goal this spec was written to satisfy, and it
RETIRES fetch-on-demand (Layer 2) as the DESTINATION: any design in which some information is
reachable only via another machine violates it. Layer 2 remains valid as a stepping stone.

**OD2 — The machine-local posture for conversation content is REJECTED by the operator.** The
hand/hammer framing: machines are one body; "my right hand holds the hammer so my left cannot
use it" is the failure. Any critical single-machine restriction is an unscalable bottleneck.
§6.1's rejection of replication stands on its ENGINEERING reasons only (volume, mechanism fit)
— its PRIVACY reason is answered by encryption-at-rest (OD5), and its conclusion is overruled.

**OD3 — Archiving may NEVER mean deleting.** "We must be able to access message history at all
costs." Old history is PACKED DOWN losslessly, never thinned. Summaries may sit on top for
speed; they NEVER replace the raw words. The ONE permitted deletion is an explicit operator
request (a deliberate act by the principal) — categorically distinct from the system quietly
forgetting on its own, which is what this rules out.

**OD4 — WITHDRAWN 2026-08-21 (same evening), because the author's finding it rested on was
wrong. The operator's instruction (OD3) is untouched; only this diagnosis of the mechanism is.**

*What OD4 said:* the coherence journal is the WRONG container — `DEFAULT_RETENTION` rotates and
DELETES, so it is disqualifying for memory under OD3, and that (not size) was the real blocker.

*What the code actually says, read after the fact:*

- `maxFileBytes` is a **rotation threshold**, not a budget. `rotate()` compares the ACTIVE file's
  size to it and rotates; there is no per-kind total ceiling anywhere. The "we are already over a
  4 MB budget with two machines" claim reported to the operator earlier that evening read a
  rotation threshold as a cap. It is withdrawn.
- `rotateKeep: 0` means **rotate but NEVER delete** — the comment at `CoherenceJournal.ts:249`
  says so and `rotate()` implements it (`if (ret.rotateKeep > 0) pruneArchives(...)`, with
  `rotateKeep === 0 → never delete (history forever in bounded files)`). It is not hypothetical:
  `topic-placement` already ships with it.
- A peer that falls past the tail window does **not** lose data. `StoreSnapshotEngine`
  (`src/core/StoreSnapshot.ts`, constructed in `src/commands/server.ts`) performs single-origin
  snapshot-then-tail, explicitly built for whole-store materialization off the event loop. What
  rotation bounds is **catch-up-by-tail**, not the record.
- The per-entry cap is 8 KB by default and 80 KB on the replicated-record path; the rate cap is
  100 burst / 50 per second. At the measured ~800 outbound-plus-inbound messages per day, neither
  binds.

*Why the memory-family stores nevertheless choose `rotateKeep: 4`, which is the part worth
keeping:* their comments state a **compliance** reason — a never-deleting transport log would
retain PII past an erasure request. That is a real constraint and it is NOT the same claim as
"the container cannot remember." It is also precisely the tension OD3's single carve-out resolves:
the system never forgets on its own; the operator may explicitly ask for a deletion.

*Net effect on this spec:* the container objection dissolves and the redesign gets SMALLER, not
larger. The live questions that remain are (a) sealing content at rest per machine (OD5) and
(b) whether the transport's shape suits multi-MB content streams as opposed to small records —
a volume question standing on its own, no longer propped up by a retention claim that was false.

*Why this is recorded rather than quietly edited:* the operator reasoned from OD4 in the live
conversation. A decision he made on a wrong premise has to show the premise being withdrawn, or
the record misleads whoever reads it next. The withdrawal was found by reading the rotation code
while beginning the rev-5 pass — the same failure mode as the two other corrections that evening:
acting confidently on a value without reading what it meant.

**OD5 — Measured, so the cost argument is settled.** This machine, 2026-08-21: 2,490 messages
over 3 days, 3.0 MB raw, **0.4 MB gzipped (7.5x, lossless)**. Projection at that rate: ~50 MB
per year compressed; under 0.5 GB per decade. Full replication to every machine is therefore
AFFORDABLE, and the "pile of data" objection is real but distant. Replication should be sealed
per-machine (the X25519->AES-GCM pattern already shipped for cross-machine secret sync) so the
at-rest exposure §6.1 objected to does not follow the content onto rented hardware.

**OD6 — Standards direction (operator strongly leaning; drafting owed).** The multi-machine
standard should be written as an OUTCOME ("any machine must be able to act coherently in any
conversation" + OD1), not as a storage mandate, so the mechanism can improve without a
constitutional edit. The `physical-credential-locality` taxonomy key is over-broad: most such
claims are storage CHOICES (Bitwarden is the existence proof). The one genuine current instance
— Anthropic's terms forbidding relocation of a Claude login — is explicitly a TEMPORARY
condition; the planned exit is API-key doorways once per-machine login becomes untenable.

**What this costs, stated honestly.** Rev 4g converged over six review rounds on a design whose
core decision OD1/OD2 overturn. The affected surfaces are §6.1 (conclusion overruled), Layer 2
(demoted to stepping stone), the FD43/FD44 index (still correct, no longer sufficient alone),
the multi-machine posture table (its machine-local rows are now wrong), and Q9 (withdrawn). A
rev-5 pass is owed BEFORE any build; the `review-convergence` field stays PENDING.


## Open questions

- **Q1. RESOLVED** — v1 covers `TopicMemory` (§1.4, by measurement), and the summary-qualification sub-problem is resolved by **FD6** (rev 4): `qualify-in-place`, universal; suppression removed.
- **Q9. WITHDRAWN AS POSED — 2026-08-21 operator directive (see the OPERATOR DIRECTIVE section above; the operator ruled AGAINST the machine-local posture this question asked him to ratify).** Original text retained for lineage: **Q9. OPEN — OPERATOR DECISION (the one genuine blocker; surfaced by round 2).** The multi-machine posture table assigns `machine-local-justification: operator-ratified-exception` to the dark-stage bootstrap read, the FD7 audit trail, the soak counters, the underlying store, the dark-stage FD43 index and `/conversation-history/block` (the S4 read was deleted with FD42), and that key means an operator has *actually ratified* the locality — it has not been obtained. The underlying question is one decision: **Justin ratifies that conversation content (`telegram-messages.jsonl` / `topic-memory.db`) stays machine-local on §6.1's at-rest grounds, and that the staged L2-dark bootstrap read, the S4 journal read, the gap-audit trail and the soak counters are accepted as machine-local for the same family of reasons** — recorded inline with name, date and expiry — and (round 5) the ratification states concrete TERMS, not only consent: retention (index replicas pruned to the history horizon, row cap 50,000 per origin; conversation content per existing log rotation), access (Bearer-only routes, per-user privacy filter on every pool read), and encryption (in transit only; at rest plaintext on each machine, exactly as the relationships store — stated). **Extended in rev 4:** the ratification also covers the FD44 `history-index` — the one artifact that puts new conversation-derived data (message ids of BOTH directions, placement epochs, and the poller's per-epoch message-id high-water — activity metadata, never text) on OTHER machines. Until recorded, the keys read `operator-ratified-exception (PENDING — Q9)`. This is a five-minute operator action, not another revision, and it is the only entry here that is the operator's rather than the author's.
- **Q2. RESOLVED against live peer data (2026-08-21) — see §1.3.** `messageId` is Telegram's per-chat id; each machine records only the messages it handled, so the id sets are **disjoint** rather than colliding, and union-by-`messageId` merges cleanly. Verified by fetching topic 52075 from the Mac Mini and merging against the local Studio view. Residual question for review: what happens on a *re-delivery* (the same Telegram message processed twice by different machines) — the merged set should collapse it, and §1.3 shows the log already contains a duplicate-delivery notice (52128), so this path is real and must be covered by a test.
- **Q3. RESOLVED — FD7.** Audit row yes, attention item no. A gap is routine on a split conversation; an item per gap would flood the very surface it would be reported on.
- **Q4. RESOLVED by FD8 (restated).** v1 covers the shared `formatInlineHistory` path (which Slack uses) and explicitly does NOT convert the Slack hook template — because that template has no working migration path, verified in source. Named follow-up recorded.
- **Q5. RESOLVED in §3.1.** The block now closes with an explicit scope paragraph binding the caution to the listed turns and stating that the rest of the history is a normal, usable record. A Tier-1 test asserts that paragraph is present whenever a gap is listed.
- **Q7. RETIRED with S4 (FD42)** — the surviving analogue, index replication lag, is `indexReplicationLagMs` on `/conversation-history/block`. *(Original text:)* S4 replication freshness. S4 reads a *replica* of the peer's session-lifecycle journal. What is the actual replication lag distribution, and does a spawn immediately following a peer spawn reliably see the peer's `created` row? The failure direction is safe (a missing row yields a hedge, never a false all-clear), but the measured lag determines how often S4 upgrades a hedge in practice. Measure during the Layer 2 dry-run soak alongside the merge counters.
- **Q8. RETIRED with S4 (FD42)** — answered: no; a warning that content is missing is not a reconstruction of it. *(Original text:)* does S4 make Layer 2 optional for v1? S4 delivers a corroborated *warning* with zero network. Layer 2 delivers the missing *content*. The spec's position is that these are different products and both are wanted, but a reviewer should test whether Layer 1+S4 alone clears the DeepSeek-harness invariant. Current answer: no — the invariant is that anything model-visible be reconstructable from the log, and a warning that content is missing is not a reconstruction of it.
- **Q6. RESOLVED — no, not in v1.** FD4 fixes `messageId` as the merge key and v1's merge scope is Telegram (FD8). The platform-parameterised key is part of the Slack follow-up, not this spec. The formatter's row type carries the key as an opaque ordered value so parameterising it later is additive.

---

## Appendix A — moved

The retired S4 design and its measurements now live in `cross-machine-conversation-history-coherence.appendix-a.md` (round 6: keeping archaeology in this file let a builder read superseded text as current).
