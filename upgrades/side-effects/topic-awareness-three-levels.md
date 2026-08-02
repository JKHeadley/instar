# Side-Effects Review — Three temporal awareness levels

**Version / slug:** `topic-awareness-three-levels`
**Date:** `2026-08-01`
**Author:** `codey`
**Second-pass reviewer:** `Kant`

## Summary of the change

This change adds a bounded temporal projection beside Topic Intent's existing
confidence-scored refs. `TopicAwareness.ts`, the extractor, store, capture
funnel, briefing, routes, source hook templates, and `PostUpdateMigrator`
together preserve three simultaneous goal/trend/themes views: whole topic,
most-recent arc, and current work. The initial user-grounded goal is stored as a
non-decaying orientation landmark, while the whole-topic view evolves. The
projection is delivered on inbound Telegram prompts and after compaction. It is
orientation only and cannot grant authority or block an action.

## Decision-point inventory

- `normalizeAwarenessDraft` — **add** — accepts only bounded, complete
  goal/trend/themes triples for all three temporal scopes. This decides whether
  derived cache data is persisted, not whether a user message or agent action
  proceeds.
- `applyAwarenessUpdate` arc transition — **add** — changes derived arc identity
  only after an exact current-user quote with explicit shift language, or two
  similar user-grounded implicit candidates.
- `applyAwarenessUpdate` freshness fence — **add** — refuses an older background
  completion from replacing a newer projection; an earlier user turn may only
  correct the immutable anchor monotonically backward. A bounded reorder
  journal separately refolds arc boundaries and new-ref placement by
  conversation turn.
- Telegram prompt and compaction hooks — **modify** — pass the rendered
  orientation briefing into agent context. Server failure degrades open and
  preserves existing recent-history injection.

---

## 1. Over-block

No user-message or agent-action block/allow surface is added. At the derived
cache boundary, a model response that supplies two complete levels but omits a
goal, trend, or theme from the third is refused in full. That deliberately
discards potentially useful partial orientation rather than persisting a shape
that falsely appears to satisfy all three levels. A genuine explicit arc shift
whose quoted words do not match the bounded shift-language vocabulary will not
switch immediately; it must earn the two-user-turn implicit path instead.

---

## 2. Under-block

The structural checks cannot prove that a fluent model summary is semantically
correct. An exact quote proves grounding in the current user's words, not that
the proposed arc label is the best interpretation. The two-signal similarity
check can still join two lexically similar but meaningfully different goals, or
delay two semantically identical goals phrased with disjoint vocabulary.

Freshness lag exposes skipped or failed extraction after capture sees a user
turn, but it cannot diagnose a missing capture callback that never increments
the topic turn. A machine with no local Topic Intent cache has no historical
three-level projection until a substantive turn is extracted; raw Telegram
history remains the fallback context. No pre-upgrade awareness is backfilled.

---

## 3. Level-of-abstraction fit

The projection belongs beside `TopicIntentStore`, not inside its refs and not
in `ContextHierarchy`. Topic Intent already owns the single per-turn semantic
extraction pass and the briefing; extending that one response avoids a second
LLM call and preserves the existing evidence pipeline. Keeping the opening
anchor outside refs also avoids ref-kind decay and the derived-evidence
authority clamp without weakening either confidence safeguard.

The projection is a context-rich signal producer. Existing confidence tiers
still answer how strongly a proposition is supported; the three temporal
levels answer which horizon the agent is viewing. No parallel authority model
is introduced.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.
- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The model-authored projection is explicitly labelled “orientation, not
authority.” It cannot alter ref confidence, create an authoritative decision,
invoke tools, send messages, or block outbound content. The deterministic
validators only protect the shape and ordering of the derived cache. ArcCheck
remains a separate downstream authority surface and is not changed here.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic decides between competing live signals for an action.
The quote vocabulary and lexical similarity threshold govern bounded derived
state identity only. They cannot authorize or refuse work, override evidence,
or prevent a conversation from evolving; a missed explicit classification
falls to the slower two-user-turn path.

---

## 5. Interactions

- **Shadowing:** the temporal block renders before existing Active Task Frame,
  Settled, Tentative, and Open Threads sections, but does not remove or promote
  any of them. If no awareness exists, existing briefing behavior remains.
- **Double-fire:** no second extraction call is added. The same structured
  response updates refs and awareness once under the Topic Intent topic lock.
- **Races:** capture remains fire-and-forget. User-turn order, speaker order,
  and event time fence stale topic/current-work completions. A 64-event reorder
  journal refolds the arc dimension: delayed explicit/implicit boundaries are
  inserted at their conversational turn, delayed intervening user turns can
  withdraw a false implicit pair, and creation-turn metadata re-homes newer
  refs to the corrected arc. The initial + 63 latest arcs are retained; older
  closed arcs become an additive archive count.
- **Feedback loops:** prior awareness is included only inside a bounded untrusted
  prompt block. Model output cannot quote itself to mint a user-grounded arc
  transition.
- **Shared intelligence capacity:** the existing extractor call keeps its
  60-second budget and its existing queue/rate limits; `maxTokens` rises from
  600 to 1000 for the structured projection. No ArcCheck timeout or caller
  behavior changes in this work.
- **Delivery parity:** clean-install and migrator-generated hooks now fetch the
  same briefing at prompt and compaction seams. `curl -f` keeps HTTP error
  bodies out of context while preserving degrade-open recent history. Tests
  execute all four hooks against success and HTTP-error fixtures. Protected
  briefing and topic-context reads carry the agent token and identity headers;
  the fake server rejects either protected surface if either header is absent.

---

## 6. External surfaces

Agents receive a new bounded briefing block during Telegram prompt construction
and compaction recovery. Users do not see a new message, command, notification,
or setting. The persistent Topic Intent JSON gains an optional `awareness`
block and additive counters; old binaries ignore it. Diagnostics and capture
metrics expose the current arc, freshness lag, invalid updates, refusals,
transitions, stale completions, anchor corrections, archived-arc count, and
delivered briefings.

Runtime timing remains outside full control because extraction is asynchronous
and LLM-backed. That is why stale state is labelled, old completions are fenced,
and hook delivery fails open. Existing installations receive the generated hook
update automatically.

No operator-facing actions are added. There is no dashboard, approval, secret,
grant, or laptop-only workflow.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN:** this awareness block stays inside the existing
registered `TopicIntentStore` derived cache
(`uncertain-topic-intent-store`, `scope: derived-cache`, `transport: none`,
`grandfathered: true`). It is a nondeterministic, advisory projection over the
conversation, not a new source of user intent or durable authority. Replicating
one machine's model summary as truth would give derived prose more weight than
the underlying conversation and introduce conflict semantics that this feature
does not own.

On a topic transfer, the prior machine relays up to 50 raw Telegram messages to
orient the receiving session. The rolling TopicMemory summary is also
machine-local (`transport: none`) and is not claimed as a cross-machine source.
The local awareness block may therefore be absent until the next valid
substantive extraction, and it may differ transiently from another machine's
projection. Diagnostics and the stale marker make that cache state visible. No
user decision, evidence ref, action, notice, or permission is stranded by the
awareness block. It emits no user-facing notice, so one-voice gating is not
needed, and it generates no URLs.

This does not claim that the existing Topic Intent cache is cross-machine
coherent. It preserves the registry's current derived-cache boundary rather
than silently promoting the new projection to a coherent durable store.

---

## 8. Rollback cost

- **Hot-fix release:** revert the code and ship the next patch.
- **Data migration:** none. The `awareness` block and counters are additive and
  optional; old code ignores them.
- **Agent state repair:** none required. Existing ref evidence, pending
  confirmations, and the legacy first arc remain readable.
- **User visibility:** during rollback agents lose the three-level briefing and
  return to the existing evidence-tiered briefing; no user data or action is
  removed.

---

## Conclusion

The review changed the implementation in nine material ways: the opening goal
was separated from decaying/confidence-clamped refs; completion-order races got
a stale-write fence plus monotonic earlier-anchor correction; the independent
review's lost-boundary reproduction produced a bounded conversation-order
refold and creation-turn ref repair; arc history gained a hard cap; agent replies
no longer erase two-user transition hysteresis; a final pre-anchor inversion
reproduction made the retained initial arc rebase from the monotonic anchor
before history is frozen; every user turn advances freshness before
prefilter/rate/shedding; generated hooks gained executable authenticated
success/error parity tests; and failed briefing fetches no longer inject HTTP
error bodies. The multi-machine claim was narrowed to the actual raw-history
relay, with no claim that TopicMemory or the projection replicates. Independent
compaction review concurs with the corrected result.

---

## Second-pass review (required)

**Reviewer:** Kant
**Independent read of the artifact:** concur

The first pass reproduced lost out-of-order boundaries, identified unbounded
arc history, found assertion-only generated-hook tests, and narrowed an
overstated multi-machine claim. The corrected refold, caps, executable fixtures,
and machine-local prose then exposed two final adversarial cases: an initial arc
created by turn 3 could freeze out a late turn-2 boundary after turn 1 corrected
the anchor, and the generated compaction hook fetched protected raw topic
context without authentication. The implementation now rebases the sequence-1
arc from the monotonic anchor before freezing history and reuses the agent token
and identity for that protected read. The fixture refuses missing credentials.
Kant independently reran the corrected package and concurred with the temporal
ordering, bounded-history, historical-ref, delivery, multi-machine, and
signal/authority analysis.

---

## Evidence pointers

- `tests/unit/TopicAwareness.test.ts` — complete-shape refusal, anchor
  durability, explicit/implicit transitions, agent interruption, stale writes,
  delayed boundary insertion/withdrawal, state caps, and completion-order
  anchor correction.
- `tests/unit/TopicIntent-extractor.test.ts` and
  `tests/unit/TopicIntentCapture.test.ts` — one-call structured extraction,
  legacy compatibility, ref re-homing by creation turn, all-turn freshness, and
  concurrent capture.
- `tests/unit/TopicIntent-briefing.test.ts` — three-level rendering and stale
  labels.
- `tests/integration/topic-intent-capture-routes.test.ts` — observable counters,
  current arc, and lag.
- `tests/e2e/compaction-telegram-context.test.ts` — executes canonical and
  generated prompt/compaction hooks on successful briefing and HTTP-error
  degrade-open paths, with protected endpoints refusing missing authentication.
- First review evidence: 82/82 green before review; reviewer reproduced the
  completion-order boundary loss and identified the unbounded arc list and
  overstated cross-machine/hook claims. Those findings drove the refold, caps,
  executable hook tests, and corrected prose above.
- Final evidence: 97/97 focused tests green after the pre-anchor inversion and
  generated-compaction authentication fixes; TypeScript, `git diff --check`,
  repository lint, and build all pass. The lint command reports only its
  pre-existing report-only controller/parser inventory notices; the local
  build reports only the expected missing release-signing key warning.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `generated-artifact-path-contract-drift`.
- **`closure`** — `gap`. The added end-to-end assertions close this briefing
  delivery instance, but the registered class is still unconfirmed and cannot
  honestly claim class-wide guard closure.
- **`guardEvidence`** — not applicable for gap closure.
- **`gap`** — `ACT-245`, the existing high-priority standards-gap action for a
  class-level generated-artifact contract lint.
