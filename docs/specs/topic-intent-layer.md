---
title: "Topic Intent Layer — conversational evidence + arc-aware continuation (v14 CLEAN)"
slug: topic-intent-layer
review-iterations: 14
review-convergence: "v14 CLEAN — external re-review (GPT 5.5) confirmed CLEAN after correcting per-day decay classifications at t=104/105/106 to match the half-life=180d formula. 13 external review rounds and 14 internal Claude rounds total."
eli16-overview: "Inlined as Part 1 of this document"
approved: true
approval-context: "Approved by Justin on 2026-05-22 via topic 9413 (topic-intent-layer). v14 replaces the v0 draft in this worktree. The build is authorized as the test bed for the GSD-Instar integration spike: Layer 1 (confidence tracker) built through a GSD-integrated /build path, Layers 2 and 3 (resume briefing + ArcCheck redraft) built through Instar's normal /build path, with a honest side-by-side comparison report at completion. The whole feature ships to main with CI green either way; the integration question is decided on data, not opinion."
lessons-engaged:
  - "Agent IS the interface (Justin's 2026-05-22 direction — users never learn vocabulary)"
  - "P1 structure-over-willpower (Layer 3 closes the loop in the outbound path, not relying on agent discipline)"
  - "P7 LLM-supervised execution (per-layer hybrid deterministic + LLM split)"
  - "signal-vs-authority (ArcCheck is signal; existing outbound gate decides)"
  - "B24 gate-latency-vs-client-timeout (ArcCheck concurrent with send-prep)"
  - "P10/B23 out-of-scope deferral discipline"
  - "L6 seven-dimension side-effects review (in Part 2)"
  - "L9 ELI16 companion (Part 1)"
  - "Hybrid determinism+LLM, per-layer"
  - "Observability first-class (diagnostics view + daily probes)"
build-mode: "GSD-Instar integration spike — slice-based comparison"
---

# Topic Intent Layer — Phase 1 spec converged (v14 CLEAN)

> Start with the ELI16 overview. Skim the technical spec only if you want detail. The convergence report and external review history are appendices.

---

# Part 1 — ELI16 overview (plain English)

# Topic Intent Layer — ELI16

## The problem in plain terms

When you talk to your agent in a long conversation that spans days, or picks up after the agent's memory got compressed, or covers several things at once, the agent doesn't actually remember the *point* of the conversation. Every time it resumes, it gets handed a transcript of the last 50 messages. A transcript isn't a brief. It tells the agent what was said, not what you're trying to accomplish.

Two things go wrong because of that:

1. **Drift.** You're deep in an investigation with a clear goal, and you ask a follow-up. The agent answers that one question in isolation instead of as the next step toward the goal.

2. **Amnesia about decisions.** Earlier in a long conversation you and the agent settled on an approach. Later, mid-task, the agent proposes changing it — having forgotten it was already decided.

## How this works (v8 — no commands)

Three layers that give the agent a real sense of each conversation's arc, **and you never have to learn any syntax to use it.** No `/pin`, no `/confirm`, no commands at all. Just talk normally; the agent does the bookkeeping.

**1. The agent keeps a quiet running summary of each conversation.** Each time you say something substantive, the agent updates its sense of (a) what this conversation is about, (b) what's still open, and (c) what seems settled. It tracks how *confident* it is about each of those things on a sliding scale — not a binary yes/no.

Things start tentative. As the conversation goes on, confidence rises when:
- You re-reference the same thing without contradicting it
- You explicitly agree ("yes", "exactly", "agreed")
- The agent uses an assumption and you don't push back
- Time passes without you contradicting it

Confidence drops when:
- You explicitly contradict ("actually no, we're going with X")
- A new thing comes up that conflicts with the old one
- Months pass with no reinforcement (slow forgetting)

When something accumulates enough evidence, it crosses into "the agent treats this as settled." When something contradicts a settled item, the agent notices.

**2. A briefing at the top of every resume.** When the agent picks the conversation back up, the first thing it reads is the briefing — the goal, open threads, what's settled, what's tentative. Tentative things are clearly marked as "the agent thinks but isn't sure." So it resumes with the point in mind, not just the last few messages.

**3. A pre-send check that triggers a *conversational* confirmation if needed.** Right before the agent sends a reply, a quick check asks: am I about to act on something that's only tentative, or am I about to quietly reverse a settled decision? If yes, the agent **rewrites its own reply to include a confirmation question, in plain English**, before sending.

Example. The agent's first draft says "Using Path A OAuth, here's the implementation..." but Path A is only tentatively the call (the agent extracted it from earlier conversation but you never explicitly confirmed). The check fires. The agent rewrites: "I'm planning to use Path A OAuth here — that's what I think we decided earlier. Just want to make sure that's still the call before I go deep. If we settled on something else, let me know."

You answer naturally: "Yes, Path A." Confidence on Path A jumps; it's now settled. Or: "Actually I think we switched to Path B." Path A confidence drops; Path B becomes the new tentative item. Either way, **you never type a command.** The conversation IS the interface.

## Why this is safe (no laundering)

The whole point of asking for confirmation is that the agent can't silently accumulate authority through its own guesses. A single LLM extraction puts an item at "tentative" — it's a signal, not authority. Authority requires multiple corroborating signals over time, OR an explicit "yes" answer when the agent asks. A wrong guess that nobody reinforces fades automatically. A contradiction immediately lowers it. A real decision survives because real decisions get re-referenced and re-affirmed naturally over the course of work.

## What you'll notice

In long, multi-day, or multi-topic conversations: the agent stays on-point. It resumes knowing the goal. It stops re-litigating things you already settled together. When it's about to do something based on an assumption that might be wrong, it asks first — in plain English, as part of its reply. When you correct it, it actually updates.

In short, simple conversations: nothing changes. The layer only kicks in once a conversation is substantial enough to have an arc worth tracking, and it stays quiet otherwise.

## Why this design over the simpler "user pins things"

That was an earlier draft, and you correctly pushed back: instar's whole point is that the agent handles things intelligently without users having to learn commands. Asking users to type `/pin` would have been a regression. The replacement — multi-signal evidence accumulation plus conversational confirmation — solves the same problem (no silent authority laundering) without forcing anyone to learn syntax. It's also what the best memory systems in the field (Letta, Mem0, Zep, ChatGPT Memory) actually do.

## What's deliberately out of v1

Auto-spreading insights across separate conversations, retroactive backfill of conversations that started before this shipped, cross-machine collaborative state with CRDT machinery, automatic conversation renaming, a rich dashboard editor, and user-tunable confidence weights (the operator can tune them, the user can't — that would be another command).

## What you can watch

A diagnostics view per conversation tells you exactly what the agent is tracking, how confident it is, what signals built that confidence, and whether anything is in conflict. A daily probe replays the two real incidents that motivated this feature against each agent's classifier and fails loudly if either gets the wrong answer. Precision and recall targets are enforced in CI. You never have to read raw logs to know whether this is working.


---

# Part 2 — Technical spec (v14, CLEAN)

---
title: "Topic Intent Layer — conversational evidence + arc-aware continuation (v14)"
slug: "topic-intent-layer"
review-iterations: 14
review-convergence: "v13 → GPT MINOR with internal-contradiction at the t=105 row (text said 'observation' but parenthetical computed 'tentative'). v14 corrects the per-day classifications to match the formula precisely: t=104 tentative (c≈0.3009), t=105 observation (c≈0.2997), t=106 observation (c≈0.2986). The exact crossing remains t*≈104.7. External re-review pending; expecting CLEAN."
review-report: "docs/specs/reports/topic-intent-layer-convergence.md"
review-external-report: "docs/specs/reports/topic-intent-layer-gpt55-review.md"
eli16-overview: "docs/specs/topic-intent-layer.eli16.md"
approved: false
lessons-engaged:
  - "Agent IS the interface (Justin's 2026-05-22 direction — users should never have to learn vocabulary; the agent handles ambiguity by asking conversationally)"
  - "P1 structure-over-willpower (Layer 2 is willpower-based; only Layer 3 closes the loop)"
  - "P7 LLM-supervised execution (supervision tiers + the hybrid deterministic/LLM split per layer)"
  - "signal-vs-authority (ArcCheck is signal; the existing outbound authority decides)"
  - "B24 gate-latency-vs-client-timeout (ArcCheck concurrent with send-prep, not a serial second LLM gate)"
  - "P10/B23 out-of-scope deferral discipline"
  - "L6 seven-dimension side-effects review"
  - "L9 ELI16 companion"
  - "Hybrid determinism+LLM (per-layer)"
  - "Observability first-class"
approval-context: "v8 rewrite 2026-05-22 after Justin pushed back on v7's /pin /confirm commands as violating instar's principle that users never learn syntax. v8 replaces the binary pinned/extracted model with continuous confidence + multi-signal evidence accumulation (drawing on Letta/Mem0/Zep memory-tier patterns); the trust boundary becomes a confidence threshold the agent reasons against, not a command the user types. Conversational confirmation by the agent (asking 'is this still right?' when about to act on uncertain ground) replaces explicit /confirm. Operator-emergency paths for cross-machine recovery remain but are NOT user-facing. Pending external re-review on this new shape, then approval."
---

# Topic Intent Layer — conversational evidence + arc-aware continuation

## Problem

On a multi-turn investigation topic (especially Telegram), the resuming session receives the last N messages as continuation context. That is a **transcript, not a brief**. There is no captured "stated goal of this topic" at the top of context. When the user asks question N+1, the agent answers it against the literal last 1-2 turns instead of against the arc of the investigation.

Two canonical failures from real agent logs define the scope:

1. **qalatra / 9235 — arc drift.** Multi-turn deep-dive whose stated goal was implicit across the early turns. Every follow-up was a tile in that mosaic; the agent answered each as standalone trivia, never grounded in the stated goal.
2. **GCI / Luna topic 365 — decision amnesia.** 326-message engagement with six concurrent arcs. The agent proposed redesigning the production OAuth architecture mid-debugging — contradicting a decision made earlier. The user caught it. The agent had no durable sense of "what was already settled."

Two faces of one gap: the agent reasons from the recent transcript, not from the topic's accumulated semantic state.

## UX principle that drives v8's shape

**The agent IS the interface. Users never have to learn vocabulary, syntax, or commands.** Earlier drafts (v2 through v7) carried `/pin`, `/confirm`, `/refocus`, `/retract`, `/supersede`, `/promote` as user-facing commands — a structural correctness fix that solved the laundering problem GPT had flagged, but by violating this UX principle. v8 keeps the trust boundary intact (durable authority must require evidence beyond a single LLM guess) and moves that evidence-gathering INTO the conversation itself.

Concretely:
- The user never types a command to make the system work.
- The agent proactively asks for confirmation in natural English when about to take action on uncertain ground.
- Authority is a continuous confidence score derived from multi-signal evidence accumulation, not a binary flag toggled by syntax.
- Correction is conversational: "actually no, we decided differently" → the state updates.
- Operator-emergency paths (cross-machine conflict resolution, corruption recovery) exist but are NOT user-facing — they're invoked by the agent's own self-heal flows or by an operator administering the agent, not by users in conversation.

## Related work — what we accurately borrow and don't (v9 corrected)

Letta/MemGPT, Mem0, Zep, ChatGPT Memory, and Cognee all manage memory automatically; none require the user to learn commands. v9 corrects v8's overstated borrowings:

- **Letta/MemGPT.** Working memory vs archival memory tiers, with an LLM-driven pager managing transitions. **We borrow:** the working/tentative vs durable/authoritative distinction. **We do NOT borrow:** Letta's LLM-as-pager (signal-vs-authority — we don't want an LLM acting as the authority on what's settled); their two-tier discrete model (we use a continuous confidence score instead). The v8 claim that tier emergence is "Letta's pattern" was overstated; it's our own continuous-scoring derivative.
- **Mem0.** Per-user/per-agent/per-session memory with extraction, scoring, and decay-like ranking. **We borrow:** scoping primitives (per-topic) and the confidence-with-decay shape.
- **Zep.** Temporal knowledge graph with fact invalidation, episodes, and derived observations. **We borrow:** the "episode as the unit of evidence" framing (v9 — distinct user-authored episodes, not signal sums). We do NOT primarily borrow Zep's "time decay" as v8 implied; Zep's main mechanism is fact invalidation via newer contradicting facts.
- **ChatGPT Memory.** Saved memories + chat-history reference. **We do NOT borrow** the conversational-confirmation-as-primary-mechanism framing v8 attributed to it; ChatGPT Memory writes when the user says "remember that..." or via summarization. **What we borrow:** the principle that the user doesn't type syntax; the system extracts from natural language.
- **Cognee.** Knowledge-graph memory with ontology. **We borrow:** typed-entity discipline (already shipped in Phase 0d's SemanticMemory).
- **Append-only decision ledgers** (research literature). **We borrow:** event-sourcing for the per-topic state file.
- **CRDTs.** Considered. **Reject for v1:** single-agent single-server write path doesn't justify CRDT machinery. Revisit if cross-agent collaboration ships.

**Why our hybrid design over the simplest alternative** (a deterministic "tell me when I've said something important enough to remember" register): the GCI failure (decision amnesia under load) requires the system to be able to surface "you settled X earlier" without the user having pre-flagged X. Pure user-driven registers miss that. Conversely, pure LLM-driven authority (Letta-style) is what GPT correctly warned creates laundering risk. The conversational-confirmation pattern is genuinely between the two: extraction provides the signal, user-authored episodes (including conversational confirmation when stakes are high) provide the authority.

## The hybrid model — what's deterministic vs LLM, per layer

| Concern | Mechanism | Why |
|---|---|---|
| **Storing and surfacing confidence** | **Deterministic** — event log, derived projection, numeric scoring | A confidence score should be a function with predictable behavior, not a vibe. |
| **Capturing what the topic is about** | **LLM** — extractor reads early turns and emits `statedGoal` | Goal is rarely explicit enough for a rule. |
| **Capturing what was decided / discussed** | **LLM extracts; user behavior confirms** | The extractor proposes; subsequent conversation either reinforces (confidence up) or contradicts (confidence down). |
| **Conversational confirmation when stakes are high** | **Agent-initiated, not user-initiated** | The agent recognizes uncertainty in its own draft and asks. User answers naturally. |
| **Detecting drift / decision contradiction** | **Hybrid** — deterministic confidence-threshold gating + LLM classifier for paraphrased contradiction | Lexical lookup catches exact contradictions cheaply; LLM only escalates for paraphrase. |
| **Authority on send** | **Deterministic** — existing outbound gate (tone-gate/response-review); ArcCheck is signal only | Classifiers do not block sends. |
| **Authority on durable state** | **Deterministic confidence threshold + accumulated evidence** | Single-LLM-guess never authoritative; threshold + consistent multi-signal evidence is. |

**The rule:** durable authority requires sustained evidence. Evidence accumulates from conversational signals (extraction, user affirmation, agent reference without correction, time without contradiction) — never from a command the user types.

## Trust model — confidence as a continuous score (v8)

Every `EstablishedRef` (a candidate fact or decision the system is tracking) has:

```
EstablishedRef {
  refId, arcId, kind: "fact" | "decision", text,
  confidence: number in [0.0, 1.0],
  evidence: EvidenceEvent[],     // append-only history of signals that moved confidence
  lastReinforcedAt: ISO8601,
  status: "live" | "conflicted",
}
```

**Confidence is a function of evidence**, computed on read from the evidence array. **Critical principle (v9):** *user-authored episodes* are the unit of evidence. An "episode" is a distinct user-authored message that produces a signal anchored to a specific refId. Agent-derived mentions do NOT count as independent evidence — they're observation only. "User didn't contradict" is NOT evidence (users routinely ignore wrong premises; silence is not consent).

| Signal | Confidence Δ | Independence |
|---|---|---|
| Initial extraction from user message | +0.40 | Counts as one user-authored episode. |
| Initial extraction from agent message | +0.10 | Does NOT count as a user-authored episode. Cap +0.10 total from agent-originated extraction. |
| User explicitly re-references the refId in a new message (lexical or LLM-anchored to the same proposition) | +0.10 per distinct user-authored episode (cap +0.30 from this signal) | Each counts as one episode. |
| Agent re-references the refId; user's next reply does not contradict | +0.01 per occurrence (cap +0.05 total) | Does NOT count as a user-authored episode. Heavily discounted because silence-is-not-evidence. |
| Explicit affirmation by user in a user-authored message that lexically references the refId's proposition OR is the immediate-next reply to an agent's confirmation question about that refId | +0.30 | Counts as one episode. Cap one affirmation-bonus per refId per 24h; AND no more than 3 distinct refIds may receive affirmation-bonus from a single user message (defends against a single "yes" mass-promoting). |
| Pending-confirmation answered positively (see Pending-Confirmation Records below) | +0.50 | Counts as one episode. The strongest signal — but only valid if the pending-confirmation record's exact proposition is what the user replied to. |
| Pending-confirmation answered negatively | −0.70 | Counts as one episode. |
| Contradiction in user-authored message (LLM-anchored to the refId) | −0.60 | Counts as one episode (negative). |
| Conflict with newly-high-confidence opposite item | mark both `conflicted`; both clamp to 0.30 | Triggered automatically; surfaced conversationally next reference. |
| Time decay | exponential: `confidence(t) = confidence_at_last_evidence × exp(-λ × max(0, days_since_last_evidence − 30))` where `λ = ln(2)/180` (half-life 180 days from end of grace period) | Mild. A 0.4 unreferenced item: 0.40 through day 30 (grace), 0.356 at day 60, 0.318 at day 90, **0.300 at day 105** (75 days into decay; `0.4 × exp(-ln(2)/180 × 75) ≈ 0.300`). The arithmetic is checked in the acceptance test below. |

**Authority gating (v9 hard rule):** an item cannot reach the authoritative tier (≥0.7) unless **at least one of its evidence episodes is a user-authored episode** (initial extraction from user, user re-reference, anchored user affirmation, positive pending-confirmation answer, OR a contradiction event followed by user-authored creation of the replacement item). Authority cannot be reached purely through agent-originated and non-contradiction signals. The hard rule is enforced by the projection — confidence sums that would cross 0.7 without a qualifying user-authored episode clamp at 0.69.

This closes the politeness-laundering hole GPT correctly flagged on v8: an agent re-referencing its own extraction five times while the user happens not to contradict no longer accumulates to authority.

**Per-message dedup (v10 — schema-enforced):** multiple signals extracted from the SAME user message about the SAME `refId` count as ONE episode, not multiple. (E.g., a user message that both re-references AND affirms an item produces one episode with the larger of the applicable deltas, not the sum.) **Schema enforcement:** every evidence event that participates in confidence accumulation carries `sourceMessageId` (`extract`, `reference`, `affirmation`, `conversational-confirm`, `contradiction`, `pending-confirm-positive`, `pending-confirm-negative`). The projection deduplicates by `(refId, sourceMessageId)` before summing — on collision the larger applicable delta wins. Time-decay is computed on read and is not an event.

Confidence is clamped to `[0.0, 1.0]`. Weights are starting values that telemetry tunes against the precision/recall acceptance targets.

**Confidence tiers — emerge automatically, not chosen by anyone:**

| Range | Tier | Behavior |
|---|---|---|
| 0.0–0.3 | observation | Signal-only. Not in the header. Won't trigger any ArcCheck verdict. May be retained for evidence accumulation. |
| 0.3 ≤ c < 0.7 | tentative | Surfaced in the header with explicit hedge ("the agent has been operating on the assumption that ___"). Before high-stakes action on a tentative item, ArcCheck causes the agent to redraft with a conversational confirmation question. |
| 0.7 ≤ c ≤ 1.0 | authoritative | Surfaced in the header without hedge. Triggers `decision-reopen` verdicts when contradicted by a draft. Materialized to SemanticMemory as a typed `fact`/`decision` entity. |

Items move between tiers smoothly as evidence accumulates. There is no user action that toggles tier. The whole point.

**Why this is a real trust boundary, not the same laundering hole:**
- A single LLM extraction is +0.40 → observation tier → no authority.
- Authority (0.7+) requires accumulated evidence from multiple distinct signals, OR an explicit conversational confirmation from the user (+0.50 + the +0.40 from initial extraction = 0.9 — authoritative).
- A wrong extraction without reinforcement decays past authority over time.
- Contradictions immediately lower confidence and surface conflicts.

The laundering risk GPT correctly flagged in v2 is addressed not by a command but by requiring multiple signals before durable authority. A wrong inference can't accumulate evidence it doesn't have.

## Pending-Confirmation Records (v9 — addresses GPT round-on-v8 finding #2)

When the agent emits a conversational confirmation question, it creates a `PendingConfirmation` record:

```
PendingConfirmation {
  pendingId,                       // UUID
  topicId, arcId,
  refId,                           // the specific refId the agent is asking about
  propositionText,                 // verbatim text of what we're confirming ("use Path A OAuth for fetchDocument")
  questionText,                    // verbatim text of the question the agent sent
  sentAtTurn,                      // user-message-count when sent
  sentAtTime,                      // ISO ts
  ttl: { turns: 5, hours: 24 },    // expires after 5 substantive user turns OR 24h, whichever first
  retries: 0,                      // sharpening retries attempted
  maxRetries: 2,
  status: "pending" | "answered" | "expired" | "abandoned"
}
```

**At most one outstanding `PendingConfirmation` per topic at a time.** If a second confirmation need arises before the first is answered, the second queues; the agent does not stack multiple open confirmation questions on the user (defends against confirmation-fatigue).

**Queue lifecycle (v10):**
- Maximum queue depth: 3 per topic. A 4th queued confirmation is silently dropped, telemetry counter `pending_confirm_queue_dropped_total` increments, and the affected refId remains tentative (a future high-stakes draft against it will re-trigger ArcCheck — nothing is permanently missed).
- Queue dedup: at most one queued PendingConfirmation per `refId`. A second confirmation need on the same refId while one is queued or outstanding is dropped (idempotent — the existing question covers it).
- TTL for queued items: the TTL clock starts at *dequeue* time (when the item actually becomes the active outstanding question), not at queue-entry time. A queued item that never gets dequeued before being dropped does not consume its TTL.
- Revalidation at dequeue: before the agent surfaces a queued question to the user, the interpreter checks (a) the refId is still tentative (didn't already become authoritative or get retracted), AND (b) the proposition text is still semantically relevant (the LLM checks for staleness against more recent extractions). Stale queued items are dropped silently with telemetry.

**Answer interpretation** (Tier 1 LLM):
- The user's next user-authored message after `sentAtTurn` is fed to the interpreter along with `propositionText` and `questionText`.
- Output: `{verdict: "positive"|"negative"|"ambiguous"|"non-responsive", confidence}`.
- `positive` → emit `pending-confirm-positive` event (+0.50 to the refId, episode counts as user-authored).
- `negative` → emit `pending-confirm-negative` event (−0.70 to the refId).
- `ambiguous` → the agent **sharpens the question** ("just to be precise — when I said X, are you confirming the specific claim that we're using Path A?") and `retries++`. After `maxRetries=2`, the pending expires with status `abandoned`; the item stays in its current tier; emit telemetry counter `pending_confirm_abandoned_total`.
- `non-responsive` → user changed topic or didn't address the question. After `ttl` elapses, pending expires with status `expired` (telemetry).

**TTL expiration:** if no qualifying answer arrives within 5 substantive user turns OR 24h, the pending expires. The agent does NOT re-ask automatically; the item stays in its current tier; telemetry records the unanswered-rate (a leading indicator that the agent's questions are landing badly or that the user is interrupting too much).

**Pending-confirmation safety guarantees:**
- One outstanding per topic (no fatigue).
- TTL prevents stale "yes" attaching to a question from days ago.
- Lexical anchor in `propositionText` (the interpreter must verify the user's reply references THIS proposition, not a different topic that came up since).
- Retry-with-sharpening for ambiguity, capped at 2 retries.
- Abandoned/expired pendings do NOT silently update state — they just exit.

## How the agent asks for confirmation (the load-bearing UX detail)

When the agent's draft would commit to an action that depends on a `tentative` item, OR contradicts an `authoritative` item, the ArcCheck signal causes the agent to **redraft including a natural-language confirmation question**, not block and not call a command.

Examples:

- Agent's first draft: "Per our decision to use Path A OAuth, here's the implementation..."
- ArcCheck signal: "Path A OAuth confidence 0.55 (tentative); high-stakes implementation action."
- Agent's redraft: "I'm planning to use Path A OAuth here, which I think is what we decided earlier — just want to make sure that's still the call before I go too deep. If we settled on something else, let me know."

User's natural response: "Yes, Path A" → +0.50 confidence (now authoritative) → next draft proceeds.
User's natural response: "Actually I think we switched to Path B" → Path A confidence drops 0.70, Path B item gets +0.40, agent redrafts under the new state.
User's natural response: silence and instructs the agent to do something else → tentative item stays tentative; the action wasn't taken.

The user NEVER sees "/pin Path A" or "/confirm decision-3a." Just conversation. The agent does the bookkeeping.

For an `authoritative` item being contradicted by a draft (the GCI case): the agent's draft proposes Path B; ArcCheck recognizes Path A is authoritative (>=0.7) and the draft contradicts it. The agent redrafts: "I was thinking we should switch from Path A to Path B because [reason] — does that match where you're now? If we're sticking with Path A, ignore what I just said and I'll continue with that." Either response updates state coherently.

## Storage — append-only events, derived projections

Per-topic state is an append-only event log at `.instar/topic-intent/<topicId>.jsonl`, with derived in-memory projections (`arcs[]` and per-`refId` confidence). Event types (v8 — observation-based, no user commands):

```
{type, eventId, serverSeq, ts, machineId, ...payload}
type ∈ {
  "extract"            {arcId, statedGoal, openThreads[], extractedRefs: [{refId, kind, text, sourceTurn, sourceMessageId, sourceSpeaker: "user"|"agent"}], extractedAtTurn}
                       // emits new refs at +0.40 (user-source) or +0.10 (agent-source, capped at +0.10 total for agent-originated extraction). See weights table.
  "reference"          {refId, byTurn, bySpeaker, contradictedInTurn: boolean, sourceMessageId}
                       // user-authored re-reference: +0.10 per distinct user-authored episode (cap +0.30). Agent re-reference: +0.01 per occurrence (cap +0.05 total). Contradiction in user-authored msg: -0.60. Per-message dedup by sourceMessageId+refId.
  "affirmation"        {refId, sourceTurn, sourceMessageId, language: "explicit"|"strong"}
                       // user said "yes/exactly/agreed" in a context referring to the refId. Per-message dedup by (refId, sourceMessageId).
  "conversational-confirm" {refId, sourceTurn, sourceMessageId, response: "positive"|"negative"|"ambiguous"}
                       // the agent asked, the user answered. sourceMessageId = user's answering message. Per-message dedup by (refId, sourceMessageId).
  "contradiction"      {refId, byTurn, bySpeaker: "user"|"agent", sourceMessageId}
                       // explicit contradiction; -0.60 from user, -0.30 from agent. Per-message dedup by (refId, sourceMessageId).
  "arc-status"         {arcId, status: "active"|"paused"|"closed"}
  "conflict-marked"    {refIds: [refId, refId], reason}
                       // automatic when two contradicting refs both reach high confidence.
  "conflict-resolved"  {refIds, resolutionRefId, sourceTurn}
                       // automatic when user's conversation makes the resolution clear ("actually we're going with X").
}
```

The projection is the function `events → arcs[] with current confidences`. Confidence is computed from the evidence array, NOT stored as a column (so weights can be tuned without rewriting history). Time-decay applies on read.

**Append safety:** server-mediated single-writer (the awake machine), idempotent on `eventId`, file-locked atomic append. Standby machines get `409 standby-may-not-write`. Cross-machine conflicts (failover split-brain, out-of-band edits, restore merges) are rare; when they occur, the projection marks affected `refId`s `conflicted` and the agent surfaces them conversationally ("I see contradictory signals about X — which is right?"). The same conversational-confirm flow resolves them. **No operator-typed `/resolve` from the user's side.** The operator administering an instar agent can use CLI tools to nudge state for emergency recovery; that path is NOT the user-conversation path.

**Corruption recovery:** truncated tail rebuilds from valid prefix; mid-log corruption quarantines the bad line and enters `recovery-required` state if dangling refs exist; missing referenced `eventId` enters the same state. The agent surfaces these as conversational nudges ("I lost some of our prior context — can you remind me whether [item]?"), NOT as commands.

## Outbound authority contract

Unchanged from v7. The existing response-review / tone-gate is the authority on send. ArcCheck emits signals (`goal-drift`, `decision-reopen` against authoritative items, `tentative-item-action`); the authority adjudicates and may cause the agent to redraft. The classifier never blocks, rewrites, or sends.

Failure behavior is verdict-specific:
- Drift signals fail open to original draft + degradation event.
- High-value signals (decision-reopen against authoritative; tentative-item-action on high-stakes draft) hold the message and route it to the existing prompt-gate so the user sees what's about to ship.

## Supervision tiers

| Pipeline | Tier | Justification |
|---|---|---|
| Scope-change classifier | Tier 0 | Read-only signal. |
| Arc/intent extractor | Tier 1 | Writes durable events; second `fast`-tier validation confirms grounding. |
| ArcCheck | Tier 0 | Annotate-only signal. |
| Evidence accumulator | Tier 0 | Deterministic — applies the weights table to events; no LLM call. |
| Conversational-confirm interpreter | Tier 1 | LLM determines if a user response is positive/negative/ambiguous re: a prior agent question. Validation: only updates state when confidence is high; ambiguous routes back through another agent question. |

## Solution

Three layers, built in order. Only the full stack closes the loop.

### Layer 1 — TopicIntent record (events + confidence + arc structure)

Storage and confidence model covered above. Highlights:

- **Multi-arc** with hysteresis on both edges.
- **Incremental extraction** — only new turns + arc summary, never raw transcript.
- **SemanticMemory composition** — items reaching `authoritative` (≥0.7) materialize as typed entities via Phase 0d's `remember()` (dedup-on-write). Tentative and observation items stay in the event log only.
- **Extraction trigger** — second substantive user turn. Turn count from durable server-side message records.

### Layer 2 — Framework-aware continuation header

```
=== TOPIC INTENT (your agent's reading of this conversation) ===
ARC: <statedGoal>
  OPEN THREADS:
    - <thread>  (agent observation)
  AUTHORITATIVE:
    - [decision] <text>
    - [fact] <text>
  TENTATIVE (agent isn't sure — may ask you):
    - [decision · ~0.55] <text>
    - [fact · ~0.42] <text>
=== RECENT MESSAGES (last 50) ===
[...transcript...]
```

Layer 2 remains willpower-based (the agent has to read and ground against this). Only Layer 3's ArcCheck provides structural enforcement.

Framework-neutral renderer, idempotent per-framework delivery. `/route` survival invariant: TopicIntent record is keyed by topicId, outside framework session state, survives swaps. Header token cap by budget, not turn count.

### Layer 3 — Pre-send arc check, conversational redraft

A `fast`-tier classifier (via `sharedIntelligence`) compares the draft against the topic's arcs. Verdicts:

- **`advances-goal` / `narrow-but-acknowledged`** → no signal; outbound proceeds.
- **`literal-only`** → emit `goal-drift` signal to the outbound authority. Mild — annotation only.
- **`tentative-item-action`** → the draft commits to an action that depends on a tentative item (confidence 0.3–0.7). Emit signal; the agent's response is to **redraft including a conversational confirmation question** (see "How the agent asks for confirmation" above). The classifier output includes a hint of the confirmation question shape but the agent owns the final phrasing.
- **`decision-reopen`** → the draft contradicts an authoritative item (≥0.7). Emit signal; the agent redrafts to either (a) frame the change explicitly ("circumstances have changed — let's switch to X") and ask for confirmation, OR (b) align with the authoritative item. Either way the conversation surfaces what's happening.

The classifier is signal only; the outbound authority adjudicates. ArcCheck runs concurrent with send-prep (not as a serial second LLM gate).

The agent's redraft step uses the same model that's drafting the response (the agent's own `sharedIntelligence`) — not an additional model call beyond what was already happening. The signal arrives as a structured input to the existing draft → review → send chain.

## Cost governance — concrete numbers

Numbers, not narratives. At `fast`-tier rates ($0.80 input + $4 output per Mtok):

| Pipeline | Input p99 | Output p99 | Cost/call |
|---|---|---|---|
| Extraction | 4,000 | 1,000 | $0.0072 |
| Tier-1 validator | 1,500 | 200 | $0.0020 |
| Scope-change classifier | 500 | 50 | $0.0006 |
| ArcCheck | 2,000 | 200 | $0.0024 |

Latency p99 ceilings per framework (Claude / Codex): Extraction 3.0s/5.0s, Scope-change 1.0s/2.0s, ArcCheck 1.5s/2.5s. CI enforces via dual-framework gate.

**Per-topic monthly budget: 200,000 tokens** (~$0.25 realistic mix / $0.80 worst case). **Agent-wide: 5,000,000 tokens** (~$5 realistic / $20 worst case). Server-stored single-writer counters. Per-topic per-minute rate limit: 10 LLM calls.

Degradation thresholds (hard, enforced):
- 80% of budget: warning event + dashboard banner + operator Telegram.
- 100%: ArcCheck degrades to no-op (`unavailable`); extraction + scope-change continue.
- 150%: extraction degrades too (header keeps last-known state).
- 200%: full pause for the topic until next monthly window.

Cost telemetry by call type so degrade-at-ceiling sheds the cheapest-value path first.

## Observability + acceptance metrics — first-class

A feature without precision/recall + clear failure identification is unfinished. v1 ships with:

**Counters** (per-topic + per-agent): `arc_extracted_total`, `confidence_updates_total{signal_type, delta_sign}`, `tier_transitions_total{from, to}`, `conversational_confirm_requested_total{response}`, `arccheck_verdict_total`, `arccheck_fail_open_total{reason}`, `conflict_marked_total`, `conflict_resolved_total{automatic|conversational}`, `cost_tokens_total{call_type}`.

**Latency percentiles** per framework: `extractor_duration_ms`, `arccheck_duration_ms`, `total_outbound_chain_duration_ms`.

**Precision/recall acceptance targets (v1 baseline, tunable):**
- ArcCheck `decision-reopen` precision ≥ 0.9 against the golden table.
- ArcCheck `decision-reopen` recall ≥ 0.8 against paraphrase + partial-reopen rows.
- ArcCheck `tentative-item-action` precision ≥ 0.85 (false positives mean unnecessary confirmation questions — costly UX).
- Extractor goal-correctness ≥ 0.85 against human-labeled reference.
- Confidence-tier-correctness: 95% of items with confidence ≥0.7 are correct upon human review of the evidence trail.

**Failure-identification surface:**
- `GET /topic-intent/<topicId>/diagnostics` — current projection, recent events, latest ArcCheck verdicts, evidence trail per refId, current tier distribution, any conflicts.
- Dashboard surface — same data, color-coded by health.
- Weekly digest of agents whose verdict distribution shifts, fail-open rate climbs, or confidence-update rate looks anomalous (e.g., affirmation spamming).
- Daily canonical-fixtures probe (qalatra + GCI) replayed against each agent. Failure → degradation event.

**Degradation UX** — same three surfaces as v7: dashboard banner, operator Telegram on high-severity, in-conversation agent prompts on confirmation flows.

## Components

**New files:** `src/core/TopicIntent.ts` (event store, projection builder, confidence accumulator, extractor + Tier-1 validator, conversational-confirm interpreter, conflict detection); `src/core/topicIntentHeader.ts` (`renderTopicIntentHeader` with tier-aware rendering); `src/core/ArcCheck.ts` (classifier with the four verdicts).

**Modified files:** Claude ctx + Codex `exec` prompt builders (idempotent); outbound relay path (ArcCheck verdict → existing outbound authority); `src/server/routes.ts` (read + diagnostics endpoints — no user-facing write endpoints; operator-only recovery route hidden behind a separate operator-admin token).

**No user-facing commands.** The `/pin`, `/confirm`, `/refocus`, `/retract`, `/supersede`, `/promote`, `/resolve` constructs from v7 are removed. Conversational signals drive state.

## Glossary — testable operational definitions

- **Substantive turn.** User-authored message with ≥200 chars of non-whitespace OR an attachment OR an @/-mention.
- **Arc.** A `{statedGoal, openThreads[], established[], status}` tuple.
- **Open thread.** Extracted observation only; never durable, never authority-bearing.
- **Confidence.** A number in [0.0, 1.0] computed from the evidence array via the weights table.
- **Observation / tentative / authoritative.** Confidence tiers `c < 0.3` / `0.3 ≤ c < 0.7` / `0.7 ≤ c ≤ 1.0` (non-overlapping; the authoritative tier owns the 0.7 boundary). Items move between tiers as evidence accumulates.
- **Conversational confirmation.** A natural-language question the agent includes in its outgoing message ("Is X still right?") when the draft depends on a tentative item or contradicts an authoritative one. The user's natural response is the signal.
- **Affirmation.** Positive language ("yes", "exactly", "agreed", "that's right", paraphrases) in a context referring to a refId. Detected by the Tier-1 validator; capped once per refId per 24h.
- **Contradiction.** Explicit negation ("no, that's not right", "we're not doing X", "switch to Y"). Reduces confidence on the refuted item.
- **Goal-correctness.** Cosine ≥0.85 between extractor's `statedGoal` and a human-labeled reference, AND no contradictory facts in the reference.
- **`tentative-item-action`.** The draft commits to an action whose grounding is a tentative-tier item. The classifier outputs a confidence hint plus the suggested confirmation-question shape; the agent rewrites the draft to include the question naturally.
- **`decision-reopen`.** The draft contradicts an authoritative item without explicit framing.
- **Conflicted refId.** Two contradicting refs that both reached high confidence. Both clamp to 0.3; the agent surfaces the conflict conversationally on next reference.

## Decision-point inventory

1. Extraction trigger turn — 2nd substantive. 2. Scope-change — per-turn classifier, two-signal hysteresis both edges. 3. ArcCheck authority — signal only; outbound authority adjudicates. 4. Cost ceiling — by call type, per-topic + agent-wide. 5. Cross-topic surfacing — explicit conversational promotion ("can we apply this to other projects?") only; no command. 6. First-turn protection — durable server-side count. 7. Dual-framework gate — hard requirement, latency assertion per framework. 8. Latency — ArcCheck concurrent with send-prep. 9. Default on — absent-safe. 10. Header cap — token budget. 11. Storage — append-only events with derived projections. 12. Authority — continuous confidence threshold (v8), no commands. 13. Observability — precision/recall + diagnostics + canonical-fixture probe. 14. Confidence weights — initial values are tunable from telemetry.

## Tests (acceptance)

[v7 tests preserved where still applicable: extractor stability + human-labeled correctness; multi-arc; framework-neutral header; dual-framework hard gate with latency; /route survival; multi-machine; backup round-trip; config; flip-flop; ArcCheck fail-open; injection.]

**v8-specific:**
- **Confidence accumulation (v10 — user-authored episodes are the unit):** extracted decision from user message → 0.40 (one user-authored episode); user re-references it without contradiction in a later message → 0.50 (two episodes); user re-references again → 0.60 (three episodes); user says "yes, that's right" anchored to the proposition → 0.90 (authoritative; crosses the 0.7 boundary). Verify materialization to SemanticMemory at the 0.7 transition. **Counter-test:** five agent re-references with the user neither affirming nor contradicting → confidence stays ≤ 0.45 (the +0.05 agent-reference cap added to the +0.40 user-source extraction); never crosses 0.7 — the authority-gating rule clamps at 0.69 absent a qualifying user-authored episode beyond extraction.
- **Time decay arithmetic:** an item at 0.40 with no further evidence: confidence is 0.40 at day 0 through day 30 (grace, formula returns 0.40 because `max(0, days_idle − 30) = 0`), 0.356 at day 60, 0.318 at day 90, 0.300 at day 105 (the formula `c × exp(-(ln(2)/180) × max(0, days_idle - 30))` evaluated against the test fixtures must match within ±0.005). **Boundary case:** at day 30 exactly, confidence is still 0.40 (grace is inclusive on the upper end).
- **Per-message dedup (schema-enforced):** a single user message that both re-references and affirms a refId produces ONE evidence delta at the larger applicable value (+0.30 affirmation), not the sum (+0.40). The projection dedup key is `(refId, sourceMessageId)`. Verify by emitting both `reference` and `affirmation` events with identical `sourceMessageId` and asserting only the larger applies.
- **Conversational confirmation:** when ArcCheck emits `tentative-item-action`, the agent's redraft (a) preserves the original action intent, (b) includes a natural-language confirmation question, (c) does NOT include the string "/pin" or any command syntax.
- **Affirmation detection:** positive language ("yes", "exactly") in a context referring to a refId updates confidence; same language in an unrelated context does not (anchored by the Tier-1 validator).
- **Contradiction → state update:** user says "actually we're going with Path B"; Path A confidence drops, Path B item created at 0.4 (user-source).
- **Conflict surfaced conversationally:** synthesize two contradicting refs both at the authoritative tier (≥0.7); verify the projection auto-marks them `conflicted` (per the weights-table conflict rule) and the agent's next reply surfaces the conflict as a natural question ("I see we discussed both X and Y — which is the call?"); user picks → conflict resolved automatically via the conversational-confirm interpreter.
- **Time decay (tier transition):** an extracted item at 0.4 with no reinforcement: at `t = 30 days` confidence is 0.40 (still tentative — boundary inclusive on grace). The exact tier-crossing time per formula is `t* = 30 + 180 × log₂(0.4 / 0.3) ≈ 104.7 days`. The test asserts **tier classification only** (not numeric tolerance against confidence), computed directly from the formula in code:
  - `t = 104`: `c ≈ 0.3009`, `c ≥ 0.30` → **tentative**
  - `t = 105`: `c ≈ 0.2997`, `c < 0.30` → **observation**
  - `t = 106`: `c ≈ 0.2986`, `c < 0.30` → **observation**

  Tier classification is the assertion; the boundary check uses the formula's exact result, not a rounded display value. Verify via clock-mocking test.
- **No user-facing commands surface in the header or in agent outputs:** integration test that simulates a topic with extracted/tentative/authoritative items; assert the agent's outputs never contain "/pin", "/confirm", "/supersede", "/refocus", "/retract", or "/promote" or recommend the user run them.
- **Operator recovery is operator-only:** the recovery endpoint requires a separate operator-admin token, NOT the user's normal Bearer auth.

## Side-effects review (seven dimensions)

1. **Over-confirm:** the agent asks too many confirmation questions, annoying the user. Mitigation: `tentative-item-action` precision target ≥0.85; signals only fire on high-stakes draft actions, not every mention.
2. **Under-confirm:** misses paraphrased reopen / lets a wrong inference accumulate evidence. Mitigation: paraphrase + near-miss fixtures in the golden table; recall target ≥0.8 on decision-reopen; canonical-fixtures probe; confidence-tier-correctness ≥0.95 audit.
3. **Level-of-abstraction fit:** TopicIntent is per-topic semantic state. Confidence is a continuous numeric scoring; tiers emerge automatically. Right altitude.
4. **Signal-vs-authority:** ArcCheck and the extractor are detectors. Outbound authority adjudicates. Confidence + accumulated evidence ratifies durable state. No brittle filter gets blocking power; no LLM single-shot ever becomes authoritative.
5. **External surfaces:** Bearer-authed read + diagnostics; operator-recovery route requires separate operator-admin token (defense-in-depth). No user-facing write endpoints.
6. **Interactions:** ArcCheck concurrent with send-prep. Materialization shares the SemanticMemory graph with Phase 0b/0d — dedup-on-write. Conversational-confirm interpreter shares the response path with the existing prompt-gate.
7. **Rollback:** flag-off → all layers no-op; event log read-only/ignored; materialized entities remain valid. Restore pairs with backup manifest.

## Rollout / rollback

Staged: echo soak 7 days → one opt-in agent 7 days → default-on for all. Per-phase exit criteria: precision/recall hits baseline AND fail-open rate <5% AND no canonical-probe failures AND no `tentative-item-action` confirmation-question spam reports. Rollback = flip `enabled: false` per agent via LiveConfig (live, no restart).

## Out of scope (v1) — with recurrence-risk classification

- Cross-channel beyond Telegram. LOW. No commitment.
- Automatic cross-topic arc-spawn linking. LOW. No commitment.
- Auto topic-rename. LOW. No commitment.
- Retroactive backfill of existing topics. MEDIUM. **Tracked CommitmentTracker item in implementing PR.**
- Rich dashboard editing UI. LOW. No commitment.
- CRDT-based collaborative state. LOW (single-agent single-server). Revisit if cross-agent collaboration ships.
- User-tunable confidence weights. LOW. Operator-tunable only in v1 — user-facing tuning controls violate the no-commands principle.

## Origin

Topic 9235 (qalatra) seeded the original draft. Topic 9976 took it through v2 (Claude internal convergence) → v7 (GPT 5.5 external CLEAN). Justin pushed back on v7's `/pin` and `/confirm` user-facing commands as violating instar's core UX principle ("the agent IS the interface; users never learn vocabulary"). v8 replaces the binary pinned/extracted model with continuous confidence + multi-signal evidence accumulation drawn from Letta/Mem0/Zep patterns; the agent itself asks conversationally when stakes are uncertain. The trust boundary is preserved (durable authority requires sustained multi-signal evidence) but it lives in the conversation, not in syntax.


---

# Appendix A — Convergence report

# Convergence Report — Topic Intent Layer

## ELI10 Overview

We're giving the agent a real sense of *what each long conversation is about* — its goal, its open questions, and the decisions already settled — instead of just handing it the last 50 messages every time it resumes. Today the agent reconstructs the point of a conversation from the recent transcript, which is why on long or multi-day topics it drifts off-goal and sometimes re-opens decisions you already made together.

The design has three layers: a small per-conversation record (goals, open threads, settled decisions), a briefing injected at the top of every resume, and a quick pre-send check that flags when a reply drifts from the goal or quietly reverses a settled decision. The settled facts also flow into the agent's searchable memory graph (which the earlier Phase 0 work just got populated), so they're real, connectable knowledge — not loose notes.

The main tradeoff the review wrestled with: this layer turns *your words* into stored state that later steers the agent. That's a trust boundary. The converged design treats everything the agent extracts as an unverified *signal* until you confirm it, keeps each conversation's state walled off from others by default, and never lets a low-context classifier block or rewrite a message — it only hands a flag to the part of the system that already decides whether messages go out. It also adds a way to *correct* a mis-captured goal or decision, which the first draft was missing (without it, one bad extraction would poison every future turn).

## Original vs Converged

The original draft (v1) was sound in shape but naive about trust, cost, and recovery. Five things changed materially in review:

1. **It assumed extracted state was trustworthy.** Originally a goal or decision the agent guessed from your messages went straight into a shared, cross-conversation memory and was treated as authoritative. After review: everything carries provenance ("extracted" vs "you-confirmed"), only you-confirmed decisions carry real weight, extracted state stays walled to its own conversation by default, and the briefing clearly marks extracted text as *context, not instructions* so a crafted message can't smuggle in commands.

2. **It had no undo.** Originally, if the agent mis-captured the goal, every future turn anchored to the wrong thing with no fix. After review: a first-class "retract/refocus" command ships in v1, supersedes the wrong item, and forces a fresh extraction.

3. **The pre-send check was both too weak and risked a known bug.** Originally it just left a note the agent could ignore (reproducing the exact failure it was meant to catch), and it added a second AI call in front of every outgoing message — the pattern that once caused duplicate-message bugs. After review: the "you're reopening a settled decision" signal is routed to the part of the system that *already* decides whether messages go out (so it can't be silently ignored, but a low-context classifier never gets blocking power), and the check runs off the critical send path so it can't stack latency into a timeout.

4. **Cost was unbounded.** Originally an AI call ran before every message with no budget. After review: the check only fires when there's actually a settled decision or open thread to defend, with a per-conversation cache, a spend ceiling that degrades gracefully (never blocks your message), and a whole-agent monthly budget.

5. **It was honest about one uncomfortable thing.** The "briefing at the top of context" layer relies on the agent *choosing* to read and follow it — that's willpower, not enforcement. The converged spec says so plainly and assigns the actual enforcement to the pre-send check, rather than pretending the briefing alone solves the problem.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, lessons-aware | ~21 | Added the whole trust model (provenance, topic-scoping, data-fencing, signals-not-authorities), the retract primitive, supervision tiers, decision-reopen routing to the existing authority, off-critical-path latency handling, cost governance, dedup-on-write, multi-machine arbitration, backup-manifest inclusion, all 7 side-effects dimensions, deferral risk-classification, hysteresis, paraphrase/near-miss fixtures, endpoint auth. |
| 2 | (convergence check — security+adversarial, scalability+integration, lessons-aware) | 0 material (2 non-material PR notes) | Folded the 2 notes (verdict-cache version-keying, server-stored agent-wide budget). |

## Full Findings Catalog

**Round 1 — Security (5):** C1 cross-topic stored prompt injection via materialized entities → trust model + topic-scoping + data-fencing. C2 extractor/ArcCheck output fed to context with no injection boundary → data fences + "not instructions" preamble + injection fixture. H1 endpoints lacked auth → Bearer + ownership + server-resolves-entityId. H2 denial-of-wallet → per-topic + agent-wide budget, defined ceiling behavior. M1 fail-open is an attacker bypass → log every fail-open + size-bound classifier input. M2 turn-count integrity → durable server-side count.

**Round 1 — Scalability (7):** pre-send check on every message (CRITICAL) → fire-selectively + cache + skip. p95 vs p99 / Codex latency → per-framework p99 budget. multi-arc re-extraction O(topic) → incremental extraction. ceiling undefined + no global budget → defined degrade behavior + agent-wide budget + by-call-type tracking. scope-change doubles call count → fold/skip on short turns. concurrent graph writes race → dedup-on-write. header bloat by turn-count → token-budget cap.

**Round 1 — Adversarial (6):** F1 no correction path (HIGH) → retract primitive. F2 self-reinforcing loop (HIGH) → provenance gating. F3 annotate-only too weak for decision-reopen (MED-HIGH) → route to existing authority. F4 legitimate-reopen vs amnesia conflation → framed-reopen acknowledged + supersede-not-delete. F5 arc flip-flop → both-edge hysteresis + telemetry. F6 gameable fixtures → paraphrase/partial/near-miss rows + correctness anchor.

**Round 1 — Integration (6):** C1 migration model contradiction → pure-code, no PostUpdateMigrator dependency, lazy creation + test. H1 multi-machine JSON conflict → LWW + single-writer server. H2 backup inclusion unstated → manifest + round-trip test. M1 Codex injection idempotency → named site + no-stack. M2 concurrent writes dedup. M3 config absent-safe + LiveConfig. L1/L2 /route survival + rollback orphans confirmed harmless.

**Round 1 — Lessons-aware (8):** P1 willpower honesty (BLOCKER) → stated explicitly. P7 supervision tiers → declared table. B24 gate-latency (BLOCKER) → off critical path. P10/B23 orphaned deferrals → risk-classified + commitment registered. L6 missing 2 of 7 side-effects dimensions → all 7 present. ELI16 companion (prerequisite) → shipped 4,657 chars. lessons-engaged frontmatter → added. Signal-vs-authority on ArcCheck → confirmed compliant.

**Round 2 — all angles:** CONVERGED. Security+adversarial: 0 residual, 0 new. Scalability+integration: 0 material (2 non-material PR notes, folded). Lessons-aware: 0 residual, 0 new; explicitly re-verified the decision-reopen routing respects signal-vs-authority (feeds the *existing* authority, doesn't create a new blocker, "non-droppable" governs delivery not adjudication) and the ELI16 companion is substantive.

## Convergence verdict

**Converged at iteration 2 on all internal angles (security, scalability, adversarial, integration, lessons-aware). No material findings in the final round.**

**One step remains and is BLOCKED in this environment: the external cross-model review (GPT / Gemini / Grok via /crossreview).** No external API keys are present, no provider is configured, and the crossreview skill is not callable in this session. Per the lesson that external review catches Claude-family blind spots, this is a genuine value-add that should run before final approval — but it cannot be faked with Claude sub-agents without defeating its purpose. The spec is internally converged and ready for either (a) external crossreview in a session that has it, then approval, or (b) approval on internal convergence alone if the user accepts the tradeoff.


## Iteration Update — v8→v14 (post-Justin pushback, conversational evidence rewrite)

After v7 converged CLEAN with all 7 internal reviewers and GPT 5.5 (rounds 1-6 above), Justin reviewed the spec and pushed back hard on its use of explicit `/pin` and `/confirm` user-facing commands. His direction: "instar users should never have to be aware of what commands to call... the system should be intelligent enough to track what needs to be tracked and leverage data as it comes... the agent IS the interface."

This required a full architectural rewrite. The v8→v14 arc replaced the binary pinned/extracted model with **continuous confidence + multi-signal evidence accumulation**, drawing on Letta/Mem0/Zep memory-tier patterns. Trust authority is now a confidence threshold the agent reasons against, not a command the user types. Conversational confirmation by the agent (asking "is this still right?" mid-reply when about to act on uncertain ground) replaces the explicit `/confirm` command.

GPT 5.5 rounds 7-13 are documented in detail in the external review file. The arc found 4 SERIOUS rounds of real architectural holes that Claude-internal reviewers had not caught (politeness laundering by agent self-references, refId mis-attachment on user "yes" without pending-confirmation record, decay-formula inconsistency, schema-vs-rule drift between event payloads and the weights table) followed by 2 MINOR rounds tightening internal-consistency wording. Final v14 verdict: **CLEAN**.

**Key v14 invariants (vs v7):**
- No user-facing commands. Acceptance test asserts agent outputs never contain `/pin`, `/confirm`, `/supersede`, `/refocus`, `/retract`, `/promote`.
- Confidence is continuous [0.0, 1.0], not discrete pinned/extracted.
- Tier boundaries non-overlapping: observation `c < 0.3`, tentative `0.3 ≤ c < 0.7`, authoritative `0.7 ≤ c ≤ 1.0`. Items move between tiers as evidence accumulates; no user action toggles tier.
- Authority gating: an item cannot reach the authoritative tier without at least one user-authored episode (the rule that closes the politeness-laundering hole).
- Per-message dedup: every accumulating event carries `sourceMessageId`; projection dedupes by `(refId, sourceMessageId)` so a single user message that both re-references and affirms counts as one episode.
- Decay arithmetic precise to ±0.005: `confidence(t) = c × exp(-(ln(2)/180) × max(0, t-30))` with grace period through day 30; tier-transition test uses formula-exact classification, not rounded display values.
- PendingConfirmation records have TTL (5 turns or 24h), lexical anchor, retry-with-sharpening (cap 2), queue depth 3 with dedup-by-refId, TTL-at-dequeue.
- Operator-emergency recovery paths still exist but are NOT user-facing and require separate operator-admin auth.

**Status:** v14 CLEAN. Awaiting Justin's `approved: true` for Phase 1 source implementation.


---

# Appendix B — External (GPT 5.5) review history

# GPT 5.5 External Review History — Topic Intent Layer

Five rounds of cross-model review via Codex CLI subscription path. Each round addressed in a spec revision, then re-reviewed. Converged at round 5.


## Round 1 (on v2 — first external pass) — Verdict: SERIOUS ISSUES

**Review**

Architecturally, the spec is detailed but still assumes too much local context: `sharedIntelligence`, SemanticMemory, Integrated-Being Ledger, response-review/tone-gate, LiveConfig, sentinel scan, `/route`, “substantive turn,” and “existing outbound authority” are treated as known stable primitives. For an outside implementer, the key correctness property is delegated to opaque existing systems. The spec should define the authority contract: inputs, outputs, failure behavior, timeout behavior, and whether it can be bypassed.

The design is not obviously the only one. It ignores serious alternatives: event-sourced topic logs with derived projections, append-only decision ledgers, explicit user-pinned decisions, workflow/task-state engines, CRDT-backed shared state for multi-machine use, or a simpler “decision register + retrieval” model. The LLM-heavy arc classifier/extractor/checker stack may be overbuilt for the GCI failure, which could be addressed by durable explicit decisions plus retrieval before drafting.

Industry-pattern engagement is shallow. This is basically conversation memory plus task/decision state, but the spec does not compare against Letta/MemGPT, Mem0, Zep, Cognee, LangGraph memory/state, OpenAI/ChatGPT Memory-style scoped memories, or agent workflow state stores. It should say what it borrows, rejects, and why.

Major failure modes: “user-confirmed” is underspecified and dangerous. If inferred from “agent acting on an explicit user statement,” confirmation may be laundered from ordinary conversation without an explicit accept/pin action. Last-writer-wins on JSON is weak for multi-machine semantic state; it can silently discard arcs. “Fail open” plus “log every bypass” is operationally fragile unless someone reviews the logs. Header fencing does not reliably prevent model instruction following; it reduces risk but is not a security boundary. The outbound authority may become overloaded with ambiguous LLM verdicts and silently normalize false positives.

Language is locally dense. “Arc,” “open thread,” “literal-only,” “decision-reopen,” “substantive turn,” “reopen-grade weight,” and “willpower-based” are not industry terms. Some are useful, but they need crisp operational definitions.

Claude-family blind spots are visible: too much faith in structured JSON, classifier verdicts, safety fences, consent/provenance labels, and high-context LLM adjudication. The spec repeatedly routes ambiguity to another model instead of using simpler deterministic mechanisms: pinned decisions, explicit supersede commands, append-only audit trails, retrieval-ranking, or UI-visible state.

Also: cost math is hand-wavy; acceptance tests rely heavily on golden fixtures from known incidents; no precision/recall targets; no degradation UX; no clear data retention/privacy story for plain-text JSON.

**Verdict: SERIOUS ISSUES**

Top-3 must-fix items:

1. Define the outbound authority and `user-confirmed` semantics precisely; require explicit confirmation for reopen-grade decisions.
2. Replace last-writer-wins JSON with append-only/evented state or conflict detection; silent semantic loss is unacceptable.
3. Add an alternatives/industry-pattern section justifying why this LLM-gated memory layer beats simpler decision registers, workflow state, or existing memory systems.


---

## Round 2 (on v3, SERIOUS)

**Second-Round Review**

1. **Must-fix: outbound authority + `user-confirmed` semantics** — **RESIDUAL.** Pinned vs extracted is much clearer, and “no implicit confirmation” fixes the main laundering hole. But `decision-reopen-acknowledged → authority routes to a supersede event` appears to let an agent-authored draft mutate durable decision state without a user `/confirm` or `/supersede`. That contradicts “durable, authority-bearing state requires deterministic capture.”

2. **Must-fix: replace last-writer-wins JSON** — **RESIDUAL.** Append-only JSONL is directionally right, but “concurrent writes are safe because append-only” is not enough. The spec needs atomic append/locking semantics, event IDs, corruption handling, and explicit conflict surfacing. Timestamp+machineId tiebreaker is still silent active-projection conflict resolution, even if audit history remains.

3. **Must-fix: alternatives / industry-pattern justification** — **RESOLVED.** The section now meaningfully compares ChatGPT Memory, MemGPT/Letta, Mem0, Zep, Cognee, LangGraph state, ledgers, CRDTs, and the simpler decision-register alternative.

Other prior observations:

- **Outbound authority contract undefined** — **Mostly resolved**, but authority failure still “sends original draft,” which weakens reopen-grade protection.
- **Header fencing oversold as security** — **RESOLVED.** It now correctly says risk reduction, not boundary.
- **Cost math hand-wavy** — **RESIDUAL.** Metrics exist, but no concrete token/latency budget, per-topic ceiling, model-cost estimate, or degradation threshold.
- **No precision/recall targets** — **RESOLVED.** Baselines are explicit.
- **No degradation UX** — **RESIDUAL.** Telemetry exists, but user/operator UX on degraded mode is vague: who sees it, where, and what action is expected?
- **LLM-as-authority over-reliance** — **Mostly resolved**, except automatic `decision-reopen-acknowledged` supersession is a regression.
- **Local jargon needs operational definitions** — **Partially resolved.** Better, but terms like “substantive turn,” “open thread,” “goal-correctness,” and “near-miss” still need testable definitions.

User additions:

- **Hybrid deterministic-vs-LLM model per layer** — **RESOLVED.** The table is clear and useful.
- **First-class observability** — **Mostly resolved.** Good metrics, diagnostics, probes, and CI targets. Residual: failure surfaces are read-only/diagnostic, not tied to operational playbooks or visible degradation behavior.

New material issues v3 introduces:

- **Automatic supersession hole:** acknowledged reopen can seemingly create durable `supersede` state from agent text.
- **Append-only concurrency overclaim:** JSONL append is not automatically safe across processes/machines.
- **Conflict policy still hides semantics:** active projection chooses a winner instead of surfacing “conflicted decision state.”
- **Authority fallback may preserve the exact failure:** if authority times out, original draft sends despite missing ArcCheck.
- **Default-on rollout is aggressive** for a memory/authority-adjacent feature still relying on new classifiers and unclear degradation UX.

**Verdict: SERIOUS ISSUES**

Top must-fix items: require explicit user confirmation for supersede/reopen-grade state changes; specify real append atomicity/conflict surfacing semantics; define concrete cost/degradation budgets and UX.


---

## Round 3 (on v4, SERIOUS)

**11-Item Re-Review**

1. `decision-reopen-acknowledged → supersede event`: **RESOLVED.** v4 explicitly says no durable `supersede` is committed from draft text; only user action changes decision state.

2. Append-only concurrency overclaim: **RESIDUAL.** Better, but still overclaims. `fs.appendFileSync` + advisory lock is local-only, while “cross-machine writes go through server” is an architectural requirement, not a storage guarantee. Tests still say “two machines append concurrently → both events preserved,” which contradicts “direct file writes unsupported” unless the test is server-mediated. Need specify the single-writer API’s idempotency, retry semantics, and duplicate `eventId` handling.

3. Cost math hand-wavy: **RESIDUAL.** v4 adds metrics and budgets conceptually, but still no concrete token ceilings, monthly budget numbers, p99 latency targets, model-specific expected costs, or degradation thresholds beyond rollout fail-open `<5%`. The original gap asked for concrete budgets.

4. Authority fallback sends original draft: **RESOLVED.** Decision reopen / pending confirmation now holds for user action by default when authority is unavailable.

5. Degradation UX vague: **RESOLVED.** Dashboard banner, operator Telegram notification, and in-conversation confirmation prompts are concrete enough.

6. Local jargon definitions: **PARTIAL / RESIDUAL.** Much improved, but some definitions still depend on classifier judgment: “equivalent framing,” “acknowledging,” “advancing,” “unanswered probe,” and “tie-back markers” are not fully testable. Good enough for spec direction, not yet implementation-tight.

7. Automatic supersession hole on acknowledged reopen: **RESOLVED.** Same as item 1; no auto-supersession.

8. Append-only concurrency overclaim: **RESIDUAL.** Same as item 2; local atomic append plus server-single-writer assumption needs a sharper contract.

9. Conflict policy hides semantics: **RESOLVED.** v4 surfaces conflicts, removes reopen-grade weight, exposes diagnostics, and requires `/resolve`.

10. Authority fallback may preserve the failure: **RESOLVED.** High-value reopen cases no longer fail open to original draft by default.

11. Default-on rollout aggressive: **MOSTLY RESOLVED.** Staged echo soak → one opt-in agent → default-on is conservative enough. Minor concern: final absent-safe default remains `enabled: true`; that is acceptable only if phase gates are enforced in code/config, not just process.

**New Material Issues**

- Open thread durability is inconsistent. Header shows `openThreads`, but glossary says open threads are “only durable after a `pin` event,” while storage has no `pin` shape for open threads and extractor emits them as arc state. This undermines `literal-only` detection.

- Quarantine handling can silently drop valid events after one corrupt/truncated line. Skipping a bad line may make later supersede/confirm events refer to missing refs. Need partial-write recovery and projection error semantics.

- `/resolve <refId> <eventId>` is introduced but absent from event schema, routes list, and tests.

- ArcCheck “off critical path” conflicts with “authority must consider signal” and authority timeout governing whole chain. If the signal is mandatory input, it is on the effective send path.

**Verdict: SERIOUS ISSUES**

Top must-fix items: concrete budget/latency ceilings; single-writer/idempotent append contract; open-thread durability/schema consistency; corruption recovery semantics; reconcile ArcCheck critical-path language.


---

## Round 4 (on v5, SERIOUS)

1. **Append-only concurrency: RESOLVED.** Single-writer API, duplicate `eventId` idempotency, retry-with-same-id, `serverSeq`, lock/O_APPEND, and standby `409` rejection are concrete.

2. **Cost math: RESIDUAL.** It now has ceilings/budgets/latency/degradation thresholds, but some math is wrong: extraction at 4k in / 1k out with $0.80/$4 per Mtok is ~$0.0072, not ~$0.0058; validator is ~$0.0020, not ~$0.0016. Monthly “worst case” numbers also need recomputation or a stated input/output mix.

3. **Open thread durability inconsistency: RESOLVED.** `openThreads[]` are now explicitly part of `extract` events, regenerated per extraction, observation-only, not pinnable, not authority-bearing.

4. **Quarantine handling: RESOLVED.** Truncated tail, mid-log corruption, dangling refs, and missing referenced `eventId` all have explicit recovery/degradation behavior; no silent partial-state.

5. **`/resolve <refId> <eventId>` schema/routes/tests: RESIDUAL.** Schema and route are present, but acceptance tests still only say “multi-machine” generically. There is no explicit `/resolve` test or conflict-resolution projection test.

6. **ArcCheck critical-path framing: RESOLVED.** The spec now admits ArcCheck affects whether/when a message ships and frames it as parallel send-prep plus existing tone-gate, not truly off-path.

7. **Local jargon / classifier judgment: RESIDUAL.** Glossary is better, but `literal-only` still depends on classifier judgment for “acknowledging,” “advancing,” and “tie-back markers” by paraphrase. `acknowledged-pending-confirmation` also allows “equivalent framing the classifier detects.” Testable examples/negative fixtures are needed.

**New Material Issues**

- **Internal inconsistency remains around multi-machine conflicts.** The older storage section says competing cross-machine events are surfaced and resolved; the newer single-writer contract says standby writes fail fast, making those conflicts mostly impossible except protocol violation/failover. Clarify the actual conflict model.

- **Event reference model is muddled.** `confirm {refId}` says “requires pin event first,” but confirmation is supposed to promote extracted refs. Extract events do not define `refId` for extracted established items, only `arcId/statedGoal/openThreads`. The schema needs a clear shape for extracted refs that can later be confirmed.

**Verdict: SERIOUS ISSUES**

Top must-fix: fix cost calculations, add explicit `/resolve` tests, and define extracted-ref identity/confirmation schema cleanly.


---

## Round 5 (on v6, MINOR ISSUES)

1. **Cost math:** RESOLVED. Per-call arithmetic is now correct and explicitly states the input/output mix.

2. **`/resolve` conflict test:** RESOLVED. v6 adds a concrete conflict fixture, projection assertion, ArcCheck no-weight assertion, resolve route call, conflict clearing, and auth check.

3. **Classifier-dependent jargon:** RESOLVED. Glossary now has positive/negative examples plus fixture-path and label-match requirements for `literal-only` and `acknowledged-pending-confirmation`.

4. **Multi-machine conflict contradiction:** RESOLVED. v6 clarifies normal writes are single-server/awake-only; conflicts arise only from failover split-brain, out-of-band edits, or restore merge. That makes the conflict path rare but coherent.

5. **Event reference model / `confirm {refId}`:** RESOLVED. `extract` now emits `extractedRefs[{refId,...}]`; `confirm` requires a prior extracted ref and materializes SemanticMemory only on confirm.

**NEW material issues**

- **Minor cost-governance inconsistency:** per-call math is fixed, but budget dollar estimates still do not follow the same stated rates. At $0.80/$4 per Mtok, `200,000` tokens is at most `$0.80` if all output, not `~$1.50`; `5,000,000` tokens is at most `$20`, not `~$40`. Conservative overstatement, but still internally inconsistent.

- **Minor terminology drift:** several sections still say ArcCheck is “off critical path,” while the v5 clarification correctly says it participates in the outbound chain in parallel and affects when/if the message ships. Not a design blocker, but the stale phrase should be removed to avoid reintroducing the old ambiguity.

**Verdict: MINOR ISSUES**

Top must-fix items: align the monthly budget dollar estimates with the stated rates, and remove/replace remaining “off critical path” wording.


---

## Round 6 — FINAL (on v7, CLEAN)

1. **Budget dollar estimates: RESOLVED.** The per-topic math now matches the stated rates: 200K tokens is about `$0.22-$0.25` at a 90/10 input/output mix, with `$0.80` worst-case all-output. Agent-wide 5M tokens is about `$5.60`, so `~$5` is close enough for budget framing; `$20` all-output ceiling is correct.

2. **“Off critical path” terminology: RESOLVED.** The design now uses the honest framing: ArcCheck runs concurrent with send-prep, feeds the tone-gate, and is part of the outbound chain without adding a second serial LLM round-trip. The only remaining occurrence is historical metadata about the prior fix, not operative design language.

**NEW material issues:** None found.

**Verdict: CLEAN**

---

## Round 7 (on v8 — conversational evidence model rewrite, SERIOUS)

v8 replaced v7's explicit `/pin`/`/confirm` commands with continuous confidence + multi-signal evidence accumulation after Justin pushed back ("instar users should never have to learn commands; the agent IS the interface"). GPT 5.5 flagged real holes that 5 Claude reviewers missed:
- Agent-originated re-references could "launder" a single LLM extraction up to authoritative confidence (politeness laundering).
- A user "yes" without a pending-confirmation record could attach to the wrong refId.
- Decay math was self-inconsistent (half-life claim didn't match formula).
- Industry-pattern attributions (Letta auto-tier, Zep time decay, ChatGPT Memory) were overstated.

## Round 8 (on v9, SERIOUS — internal-consistency residuals)

v9 made user-authored episodes the unit of evidence, added strict PendingConfirmation records with TTL/sharpening/lexical anchor, fixed decay math, and corrected industry-pattern claims. GPT identified residuals:
- Stale v8 confidence test scenario contradicted v9 weights table.
- Event-schema comments stated different deltas than the weights table.
- Same-message-multi-signal double-count not addressed.
- Queued-confirmation lifecycle underspecified.

## Round 9 (on v10, SERIOUS — narrower)

v10 fixed the stale test, updated event-schema comments, added per-message dedup rule, specified queue lifecycle. GPT residuals:
- Decay arithmetic intermediate values inconsistent (day 60: 0.37 was wrong, formula gives 0.356).
- Per-message dedup schema-incomplete (only `reference` carried `sourceMessageId`).
- Tier boundary overlap at exactly 0.7.

## Round 10 (on v11, SERIOUS — small)

v11 fixed arithmetic precision, added `sourceMessageId` to affirmation/conversational-confirm/contradiction, made tier boundaries non-overlapping (`0.3 ≤ c < 0.7` tentative, `0.7 ≤ c ≤ 1.0` authoritative). GPT residuals:
- `extract` event still missing `sourceMessageId` on extractedRefs.
- Glossary section restated old overlapping tier ranges.
- Conflict-surfaced test used ≥0.6 while conflict-marking rule fires at ≥0.7.
- Day-104 assertion fragile against ±0.005 tolerance.

## Round 11 (on v12, MINOR)

v12 added `sourceMessageId` to extractedRefs, aligned the glossary tier ranges, raised the conflict test to ≥0.7, rewrote the tier-transition test against the exact formula. GPT residual:
- Tier-transition wording claimed "comfortably outside ±0.005 tolerance" — not true (day 106 is within ±0.005 of 0.300).

## Round 12 (on v13, MINOR — internal contradiction)

v13 removed the tolerance framing and asserted tier classification only. GPT residual:
- Per-day classifications had a contradiction: text said `observation at t=105` but parenthetical computed `tentative`.

## Round 13 — FINAL (on v14, CLEAN)

v14 corrected the per-day classifications to match the formula exactly:
- `t = 104`: `c ≈ 0.3009` → tentative
- `t = 105`: `c ≈ 0.2997` → observation
- `t = 106`: `c ≈ 0.2986` → observation

Exact crossing at `t* ≈ 104.7`. GPT verdict: **CLEAN**. No new issues found in v14.

**Convergence summary across the v8→v14 rewrite arc:** the external GPT pass surfaced 4 SERIOUS rounds of real holes that Claude-internal reviewers had not caught (politeness-laundering, refId mis-attachment, decay inconsistency, schema-vs-rule drift, boundary ambiguity), then 2 MINOR rounds tightening internal-consistency wording. Final state is internally consistent: weights table matches event-schema comments, per-message dedup is schema-enforced via `sourceMessageId` on every accumulating event, tier boundaries are non-overlapping, decay arithmetic is precise to ±0.005, tier transitions assert against formula-exact classification not rounded display.

