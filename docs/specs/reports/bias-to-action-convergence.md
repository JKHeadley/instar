# Convergence Report — Standing-Authorization signal for B17_FALSE_BLOCKER

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex CLI, `gpt-5.5`) ran successfully in rounds 1 and
3 (round 2 degraded on timeout). The spec received genuine non-Claude external review;
codex's final verdict was MINOR ISSUES, its one standing point (FLOOR/scope lean on LLM
judgment) being the deliberate Body-and-Mind design the internal lessons reviewer
independently confirmed is constitutionally correct.

## ELI10 Overview

On 2026-06-27 the operator told me to fix the release pipeline "on your own" and gave
explicit preapproval. I fixed the urgent part, then for the bigger structural fix I
stopped and asked "ready for your go-ahead to build?" — and waited, making him chase me.
He'd already said yes. His feedback: build structural enforcement so I stop assuming
something is his job and waiting.

The first design I drafted added a whole new check. The review process caught that this
was wrong twice over: the behavioral-code slot I picked (B20) was already taken, and —
more importantly — I don't need a new check at all. There's already a gate ("B17 / never
a false blocker") whose entire job is to catch me handing a doable task back to the user.
It missed my failure only because it doesn't yet know when the operator has *already
granted* the authority — so "can I build this?" looked like a fair question even though he
already answered it. So the real fix is to teach the existing gate one new fact: whether
the verified operator already authorized this exact thing.

The dangerous direction — training me to *skip* an approval I actually needed — is
structurally blocked: the gate never applies this to anything irreversible, costly,
out-of-scope, or policy-sensitive (it always asks for those), it only counts a grant that
actually covers the specific action, and it only trusts a grant proven to come from the
verified operator (never a forwarded message, never another person, never my own words).
It ships observe-only first (just records what it *would* do) so we can measure it before
it ever changes a message.

## Original vs Converged

- **Originally** a new behavioral code `B20_ASK_WHEN_AUTHORIZED` + a new constitutional
  article. **Converged:** no new code (B20 is taken; this is genuinely B17's surface) and
  no new article — it's the missing clause of the existing "Never a False Blocker"
  standard, reconciled with the tracked `agent-autonomy-ratchet` (which *grants* authority;
  this catches *under-use* of authority already held).
- **Originally** a grant's mere existence made `present:true`. **Converged:** scope/recency
  match to the asked action is a FIRING PRECONDITION (a grant for task A can't fire on task
  B), and the look-back window is bounded (40 operator msgs or 24h).
- **Originally** "verified-operator only" was asserted but rested on `fromUser` (any inbound
  human) and couldn't exclude forwarded messages on the real substrate. **Converged:**
  resolve the operator uid via `TopicOperatorStore.asVerifiedOperator` and match on
  `telegramUserId`; persist a `forwarded` flag on the message log (both ingress paths) and
  count a grant ONLY when proven non-forwarded — a legacy/unknown row never counts
  (fail-safe). Missing uid is non-attributable, never a wildcard.
- **Originally** FLOOR classification was contradictorily both unit-testable and gate-judged.
  **Converged:** FLOOR is the gate's judgment (integration-tested, Body-and-Mind), with an
  explicit under-fire bias (when uncertain, don't fire).
- **Security hardening:** `evidenceQuote` rendered as boundary-quoted untrusted DATA
  (identical to `renderRecentMessages`) + secret-scrubbed; a regression test asserts
  standing-authorization can never flip a B1–B7/B15 leak HOLD; the observe-only log stores
  a source enum + phrase token + uid HASH, never raw operator content.

## Iteration Summary

| Round | Reviewers who flagged material findings | Material findings | Cross-model |
|-------|------------------------------------------|-------------------|-------------|
| 1 | adversarial, lessons, decision-completeness, security (+ codex, gemini) | ~12 (B20 collision; new-article-not-warranted; scope-match missing; identity-bleed via fromUser; evidenceQuote injection; FLOOR ownership; look-back window) | codex-cli:gpt-5.5 (ran), gemini-2.5-pro (ran) |
| 2 | security (forwarded-substrate gap) | 1 blocker + 1 minor; decision-completeness/lessons/adversarial CONVERGED | both degraded (timeout) |
| 3 | (converged — security CONVERGED) | 0 blocking (1 safe-direction wiring advisory folded) | codex-cli:gpt-5.5 (ran, MINOR) |

## Full Findings Catalog

### Round 1 (material — all folded into the rewrite)
- **B20 code collision** (`B20_INTERNAL_ID_LEAK` exists) → no new code; extend B17.
- **New article not warranted** (single incident; overlaps tracked `agent-autonomy-ratchet`)
  → no new article; missing clause of "Never a False Blocker"; reconciled.
- **Scope/staleness not a firing condition** (grant for A fires on B → trains skipping a
  needed approval) → D3/D4 make scope-match a firing precondition.
- **Identity bleed** (`fromUser` = any inbound human) → D6 verified-operator uid only.
- **evidenceQuote injection** into the leak-holding LLM → D7 boundary/untrusted rendering +
  HOLD-can't-flip regression.
- **FLOOR ownership contradiction** → D5 gate-judged (integration), under-fire bias.
- **Look-back window unspecified** → D9 bounded (40 msgs / 24h).
- **Observe-only log raw content** → D8 enum + token + uid hash.
- **Judge-by-meaning** (not a phrase list) → detector is signal-only, B17 LLM judges by
  meaning (honors "Intelligent Prompts — An LLM Gate Must Not String-Match").

### Round 2 (material)
- **Forwarded-substrate gap** (the message log doesn't persist Telegram forward markers, so
  a forwarded operator message is indistinguishable from a grant) → D10: persist `forwarded`
  + fail-safe (count only proven-non-forwarded; unknown never counts). Missing uid →
  non-attributable (D6).

### Round 3 (non-material — folded)
- Two-ingress-path wiring + explicit-`forwarded:false` requirement (safe direction; inert
  if missed, never a false grant) → folded into D10's implementation note + wiring tier.
- codex MINOR: FLOOR/scope lean on LLM judgment — the deliberate Body-and-Mind design.

## Convergence verdict

**Converged at round 3.** No material finding remains: the security reviewer's round-2
blocker (forwarded-substrate) is resolved on the real substrate, decision-completeness and
lessons-aware and adversarial all returned CONVERGED in round 2, and the round-3 codex
external returned MINOR-ISSUES-only with every earlier critical/major folded. The
worst-direction risk (suppressing a needed approval) is structurally contained by the FLOOR
carve-out + scope-match precondition + verified-operator-only resolution + under-fire bias +
observe-only rollout. All build-time decisions are frontloaded (D1–D10); `## Open questions`
is empty. Ready for operator approval and the (observe-only, dev-gated-dark) build.
