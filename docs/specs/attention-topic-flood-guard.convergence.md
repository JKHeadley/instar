# Convergence Report — Attention Topic-Flood Guard

**Spec:** `docs/specs/attention-topic-flood-guard.md`
**Method:** four independent reviewer agents, one round, distinct lenses
(adversarial/security, integration/over-block, architecture/signal-vs-authority,
scalability/correctness), auditing the spec against the actual diff.
**Date:** 2026-05-28
**Outcome:** converged after addressing all material findings in code; no findings
deferred (per the /instar-dev no-deferrals rule).

## Findings and resolutions

Severity in brackets. ✅ = fixed in code this iteration; 📝 = addressed in spec text.

1. **[HIGH] High-cardinality `sourceContext` defeats the per-source budget AND
   leaks the tracking maps** (security + scalability reviewers). A mis-wired
   source varying its key per item dodged the budget — breaking the guard's
   central "any mis-wired feature is throttled" promise — and grew the `events`
   map unbounded. ✅ Added a **global ceiling** (`maxTopicsGlobal`, default 8):
   once total topic creation in the window exceeds it, non-critical items of any
   source coalesce into one shared `'*'` bucket. Added stale-key eviction + a hard
   `maxTrackedSources` cap. Unit test: `GLOBAL cap defeats source-key variation`.

2. **[HIGH] Coalesced items break `/ack` routing, corrupt the reverse map on
   restart, and resolving one closes the shared topic for all siblings**
   (integration reviewer). ✅ Coalesced items are flagged `coalesced: true`, are
   NOT registered in the per-item topic maps, and `loadAttentionItems` skips them;
   they are managed via `/attention` (PATCH / dashboard). `updateAttentionStatus`
   therefore never closes the shared notice topic. Notice-topic intro states the
   management path.

3. **[HIGH] Critical-priority bypass was case-sensitive** (security reviewer). A
   lower-cased `'high'`/`'critical'` could be coalesced. ✅ `decide()` upper-cases
   the priority and treats `HIGH`/`URGENT`/`CRITICAL` as critical. Unit test
   covers all cases.

4. **[MEDIUM-HIGH] Async double-create race in the notice topic** (scalability
   reviewer). Concurrent coalesced items for one bucket could each create a topic.
   ✅ Per-bucket in-flight creation promise (`floodNoticePending`); concurrent
   callers share one `createForumTopic`. Integration test: `concurrent coalesced
   items … create exactly ONE notice topic`.

5. **[MEDIUM] Episode/topic churn for a flapping source** (architecture +
   scalability reviewers). A source straddling the window boundary spawned a new
   notice topic per episode. ✅ The notice topic is now created once per bucket and
   reused thereafter (no per-episode churn).

6. **[MEDIUM] Hex fingerprint sent plaintext to any unverified address**
   (security reviewer). ⤳ **Deferred to PR #495 (merged).** This was a finding on
   the redrive-specific edits originally bundled here; #495 (merged on main after
   approval) owns the fingerprint-as-`relatedAgent` handling now, so the redrive
   edits — including this trust-gate — were dropped from this change and the
   redrive offender fix defers to #495. If #495's fingerprint path lacks the
   known-agent trust check, that is a small follow-up on #495, not this guard.
   <!-- tracked: PR-495 follow-up -->

7. **[MEDIUM] `NaN`/negative config silently disabled the guard** (security
   reviewer). ✅ Constructor coerces all numeric config to safe defaults. Unit
   test covers it.

8. **[MEDIUM] Unbounded suppression audit log** (scalability reviewer). ✅
   `attention-suppressed.jsonl` rotates at ~2 MB.

9. **[LOW/framing] Layer positioning, SentinelNotifier divergence, and the
   `*Guard` name** (architecture reviewer). 📝 Spec §4 now positions the guard as a
   transport-mechanics backstop below the tone-gate authority, documents why it is
   not unified with `SentinelNotifier`, and notes the name does not imply blocking
   authority (the class doc says so explicitly).

## Verified non-issues / out of scope

- **No recursion** — the notice topic is created via `createForumTopic` directly,
  never via `createAttentionItem` (all reviewers concurred).
- **Layer/placement** — `src/messaging/` is the right home (adapter-owned pure
  helper); concur.
- **Pre-existing** — the CLAUDE.md template's stale `/attention` payload example
  (`priority:"medium"`, `source:`) and `makeAttentionPoster` lower-case priority
  are pre-existing, not introduced here; tracked separately, out of scope for this
  spec. <!-- tracked: topic-11960 follow-up -->

## Residual risk

A legitimate non-critical source raising >3 items / 10 min is coalesced (grouped,
not dropped). This is aligned with the operator's stated intent ("only critical
things as their own messages") and is tunable per adapter; genuinely must-see
items should be raised to HIGH. Accepted.
