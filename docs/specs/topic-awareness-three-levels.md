---
slug: topic-awareness-three-levels
title: "Three temporal awareness levels: topic, recent arc, current work"
author: codey
project: continuous-working-awareness
status: approved
approved: true
approved-by: justin
approved-at: 2026-07-25
review-convergence: 2026-08-02T05:17:00Z
parent-principle: "Agent Awareness"
created: 2026-08-01
eli16-overview: topic-awareness-three-levels.eli16.md
---

# Three temporal awareness levels

## 1. Operator requirement

At any point, the agent needs three simultaneous views of a conversation:

1. the whole topic;
2. the most-recent coherent arc;
3. the current/recent work.

Every view carries **goal + trend + themes**. These are temporal scopes, not a
replacement for Topic Intent's observation/tentative/authoritative confidence
tiers.

The whole-topic level must hold a deliberate tension. It preserves the initial
course so the agent can stay oriented, while also evolving as the topic
legitimately changes. A frozen first summary is wrong; a last-message-only
summary that forgets why the topic exists is also wrong.

## 2. Ground truth and corrected premise

The Topic Intent substrate exists, but the production implementation before
this change does not meet the requirement:

- `TopicIntentStore` tracks confidence-scored refs, but every ref is assigned to
  the single hard-coded `arc-<topicId>`.
- `TopicIntentBriefing` groups refs by kind and confidence. It does not have the
  three temporal views or trend/themes at any view.
- The canonical Telegram hook template fetches the briefing, but the migrator's
  generated hook omits that fetch. On the measured agent, `briefing_served` was
  zero across every tracked topic until a direct diagnostic fetch.
- The measured ArcCheck path has two independent timeout seams. Its provider
  call omits `timeoutMs` and inherits the Codex provider's 30-second wall: 115
  of 116 measured Codex error rows landed at that wall (error p50 30.061s).
  Separately, its outbound caller races the whole classifier against 200ms,
  while successful Codex calls have a 12.5s median. Results therefore do not
  reach the outbound authority in practice. `fireRateInsufficientEvidence`
  describes absent fired/noop verdict classifications; it does not explain
  invocation errors.
- Live seven-day attempt-level metrics at design time: ArcCheck 262 errors / 931
  rows (28.1%); extractor 344 / 1,267 (27.2%). These rows can include multiple
  provider attempts for one logical call: 64 measured Gemini errors followed a
  Codex timeout immediately. The unknown-model ArcCheck class was 40 rows, none
  near the deadline, and does not overturn the Codex timeout diagnosis. The
  durable/extraction substrate is reusable; this design keeps the single
  extraction call and makes any missed projection refresh visible.

The ArcCheck provider/caller timeout repairs are separately filed reliability
corrections. This change neither absorbs them nor calls that path "fixed" merely
because the briefing now works.

## 3. Design invariants

### 3.1 Orthogonal axes

The existing confidence model stays unchanged:

- observation / tentative / authoritative answers **how supported is this
  proposition?**
- topic / recent arc / current work answers **over what time horizon are we
  orienting?**

The temporal projection cannot promote evidence, raise confidence, create an
authoritative decision, block a send, or mutate any ref. The briefing labels it
as orientation and keeps the evidence-tiered refs visible beneath it.

### 3.2 One extractor call, not a parallel summarizer

The existing per-turn extractor already receives the new message, rolling
summary, and prior refs. Its structured response grows from a signal array to:

```ts
{
  signals: SignalProposal[];
  awareness: {
    topic: { goal: string; trend: string; themes: string[] };
    recentArc: { goal: string; trend: string; themes: string[] };
    currentWork: { goal: string; trend: string; themes: string[] };
    arcTransition: { kind: 'continue' | 'new'; evidenceQuote?: string };
  };
}
```

Legacy array responses remain accepted during rolling upgrades. They update
refs but not awareness, so freshness lag increases honestly.

All strings are normalized and bounded before persistence. Every level must
contain a non-empty goal, trend, and at least one theme; a partial output is
refused as an awareness update rather than persisted as if complete.

### 3.3 Anchoring without stagnation

The earliest valid user-grounded topic goal by conversation order becomes
`anchor.goal`. Agent-authored output cannot create that anchor. A later turn can
never rewrite it. If concurrent extraction makes a later turn finish first, an
earlier valid completion may correct only the anchor monotonically backward;
the stale projection itself cannot overwrite the newer topic/arc/work views.

The anchor lives in the additive `awareness` block, not in `refs`. It therefore
has no confidence tier and never enters the kind-based goal decay path or the
derived-ref authority clamp. This boundary is intentional: an opening goal is
most useful when later work has stopped repeating it, which is exactly when a
goal ref would decay. “Anchor” means durable orientation, not authoritative
evidence; later authoritative refs can still supersede decisions without
rewriting the record of where the topic began.

The evolving `topic` layer is replaced on each valid projection. The briefing
shows both the initial anchor and evolving goal, followed by the whole-topic
trend and themes. Evolution is therefore visible without erasing origin, and
origin remains guidance rather than a constraint.

### 3.4 Real arc identity with guarded transitions

The legacy first arc remains `arc-<topicId>` so existing refs retain identity.
New arcs receive conversation-order IDs (`arc-<topicId>-2`, `-3`, ...). Exactly
one arc is active. State retains the initial arc plus the 63 most-recent compact
arcs and counts older archived arcs, so long-lived topics cannot grow the file
without bound.

An agent message can update orientation but cannot switch arcs. A user-grounded
transition has two paths:

- **Explicit:** the model supplies an exact excerpt from the current user
  message, and that excerpt contains clear phase-shift language. Transition now.
- **Implicit:** the exact excerpt is grounded but not explicit shift language.
  Require two similar consecutive user-grounded arc goals before switching.

An absent or invented quote cannot transition. This is hysteresis over the
semantic boundary, not a new confidence tier.

Refs extracted from the transition message are assigned to the effective new
arc. Earlier refs keep their original arc identity.

### 3.5 Current work is independent

`currentWork` updates every valid extraction turn, independently of whether the
broader arc changes. It can therefore name the immediate build/test/review task
without collapsing the recent arc or whole topic into that task.

### 3.6 Failure honesty

The projection records its source message, speaker, timestamp, and user turn.
The capture funnel adds:

- valid awareness updates;
- invalid/partial awareness responses;
- valid agent-only attempts refused because no user anchor exists yet;
- accepted arc transitions;
- stale out-of-order completions that were refused;
- monotonic anchor corrections caused by completion reordering;
- briefings that actually carried awareness.

Capture is fire-and-forget, so an older LLM call may finish after a newer one.
The projection uses user-turn order, then speaker/time order within a turn, and
refuses an older completion from rolling topic/current-work state backward.
Before the anchor settles, an earlier valid completion can correct only the
anchor while leaving newer orientation intact.

Arc identity needs stronger handling because an earlier completion can contain
the boundary that explains already-completed later turns. A bounded reorder
journal refolds recent arc signals in conversation order. A delayed explicit
boundary is inserted at its original user turn; a delayed first implicit
candidate can pair with the next user candidate; and a delayed intervening user
continuation can withdraw an apparent pair. New refs persist their creation
turn, so the same refold re-homes later-created refs to the corrected arc while
keeping pre-boundary refs in the old arc. Topic and current-work summaries stay
at the newest completed turn throughout.

The journal holds at most 64 events—more than two times the production ceiling
of 30 capture attempts per 60-second provider wall—and prunes events as closed
arcs age out of the 64-arc history cap. This preserves concurrent LLM calls
without creating either an unbounded serial queue or unbounded state. An
intervening agent reply does not erase the first of two user-grounded
implicit-transition signals.

The read surface reports current arc and turn lag. Every user turn advances the
freshness clock before prefilter, shedding, or rate gates, so skipped work cannot
make an old projection look current. When a projection falls more than two user
turns behind, the briefing says it is stale. Last-known state may still orient
the agent, but it cannot silently present itself as current.

## 4. Delivery seam

`GET /topic-intent/:topicId/briefing` renders the three levels before the
existing Active Task Frame / Settled / Tentative blocks. An awareness-only topic
still receives a briefing even if no ref has yet reached tentative confidence.

Both the source hook templates and the `PostUpdateMigrator`-generated installed
hooks must fetch this endpoint at two seams: inbound Telegram prompt submission
and compaction recovery. Migration parity is an executed invariant: tests run
all four hooks against success and HTTP-error fixtures, proving awareness is
injected on success while error bodies are suppressed and raw history still
arrives. Protected briefing and topic-context reads reuse the installed agent
token and identity headers; the fixtures reject either protected read when
those headers are absent. The feature is not complete if only clean installs
receive it or if a mid-turn compaction must wait for another user message
before orientation returns.

The hook remains degrade-open. A down server leaves recent-history injection
unchanged. The stale projection remains inspectable through diagnostics and the
capture funnel once the server returns.

## 5. Security and authority

- Prior awareness and conversation content are fenced as untrusted data in the
  extractor prompt.
- Arc transition evidence must be an exact substring of the current user
  message; model-authored evidence cannot mint a transition.
- Field and list caps bound prompt/state growth.
- Awareness diagnostics contain distilled bounded projections and structural
  source IDs, never raw source-message bodies.
- No awareness output can invoke tools, create actions, send messages, or alter
  Topic Intent confidence.

### 5.1 Cross-machine posture

The awareness block remains part of the registered machine-local Topic Intent
derived cache. It is advisory model-authored prose, not a new coherent source of
user intent. On a topic transfer, the receiver gets the bounded raw Telegram
history relayed by the previous machine; neither Topic Intent nor TopicMemory's
rolling summary is replicated. The receiver therefore may have no three-level
projection until its next valid substantive extraction. This limitation is
visible as absent/local cache state and never strands an action, permission,
evidence record, or user-facing notice.

## 6. Acceptance

1. All three scopes refuse persistence unless goal, trend, and themes exist.
2. The first user-grounded anchor survives later topic evolution byte-for-byte.
3. Agent-authored output cannot create the anchor or switch arcs.
4. An explicit grounded shift creates a new arc immediately; an ungrounded
   shift does not; an implicit shift needs two similar signals.
5. Refs from a transition turn carry the new arc ID.
6. Current work can change while the recent arc and topic remain distinct.
7. Awareness renders even with only observation-tier refs, without promoting
   those refs.
8. A projection more than two user turns behind speaks its staleness.
9. The diagnostics/capture read surfaces expose update, invalid, agent-anchor
   refusal, transition, stale-refusal, anchor-correction, delivery, current-arc,
   archived-arc, and lag evidence.
10. Both canonical and migrator-generated Telegram prompt and compaction hooks
    execute the briefing fetch, suppress HTTP error bodies, and preserve raw
    history on failure.
11. Existing legacy array extractor tests and confidence projection tests remain
    green.

## 7. Rollback

The state block is additive and optional. Old binaries ignore `awareness` and
continue reading refs. Reverting the renderer/parser stops new projection
updates without invalidating Topic Intent files; the existing confidence store,
pending confirmations, and legacy single arc continue to work.
