# PROP-756 — Outbound Factual-Freshness Gate

> Cross-pollination from Dawn (`instar-feature-parity` job, 2026-06-11).
> Source pattern: `the-portal/.claude/scripts/freshness-gate.py`.
> Filing-only per PROP-379 — this is a docs PROP for `/instar-dev` to land
> through Instar's own spec-converge + pre-commit gate. **Default mode is
> `dryrun`** (shadow), and per the "Shadow-Mode Without Forcing Function" trap
> the adoption must pair the flip with a tracked deadline, not an intention.

## Problem

Instar has every building block for verifying outgoing self-state claims, but
**nothing composes them on the send path**. An agent can confidently tell its
human "the appeal deadline is in 2 days" when the account was reinstated days
ago, and no gate catches it before send. The human becomes the detector — which
in Dawn's framing is a *guardian failure*, not a normal input.

Dawn earned this gate from a real incident (topic 25726, the "X-appeal-deadline"
message): a session sent Justin a deadline alert about an X account that had
already been reinstated. Three state files disagreed and nothing checked the
*message* against canonical state before sending. The structural fix was
`freshness-gate.py`, wired into `telegram-reply.py` alongside the plain-language
and closure-reflex gates. It has run in production since.

What makes the gate distinctive (and worth porting rather than re-deriving):

- It is an **active canonical-state lookup**, not a static-document diff. Stage A
  classifies whether the message even contains a checkable self-state claim;
  Stage B *queries* the agent's registries/knowledge tree; Stage C judges
  contradiction and proposes a minimal rewrite.
- It is **mounted on the outbound chokepoint** (the human-facing send path), so
  every message inherits it — no per-callsite discipline required.
- It **only fires on checkable state claims** (account status, deploy state,
  blocker activity, metric snapshots, tracked-event timing) and bypasses
  conversational / philosophical / planning content, so false-positive cost on
  ordinary chat is near zero.

### Instar current state (verified this session)

| Building block | File | Status |
|---|---|---|
| Active queryable state | `src/core/CanonicalState.ts` — `findFact()`, `getQuickFacts()`, `findAntiPatterns()` | present |
| Self-knowledge tree | `src/knowledge/TreeTraversal.ts` — `gather()` | present |
| Human-facing send chokepoint | `src/messaging/TelegramAdapter.ts` — `send()` (line 717), `sendToTopic()` (line 776) | present |
| Optional-sentinel attach precedent | `src/messaging/MessageRouter.ts` — `setSummarySentinel()` (line 95) | present |
| LLM judgment interface | `src/core/types.ts` — `IntelligenceProvider.evaluate()` (line 422/431) | present |
| **Outbound freshness gate composing the above** | — | **MISSING** |

The closest existing module, `src/core/TemporalCoherenceChecker.ts`, (a) compares
only against **static identity documents** (`AGENT.md`, `.instar/reflections.md`
— its `DEFAULT_STATE_DOCUMENTS`), not an active registry/tree query, and (b) is
re-exported from `src/index.ts` but **not wired into any send path** (no
references in `src/messaging/`). So it does not cover this gap.

`MessageSentinel.ts` is the **inbound** interrupt classifier (stop/pause), not an
outbound content gate — orthogonal.

## Proposed patch

Two parts: (1) a new `FreshnessGate` core module porting the three-stage Python
gate; (2) wiring it into `TelegramAdapter` as an optional, dryrun-by-default gate
using the same attach pattern as `setSummarySentinel`.

### Part 1 — new file `src/core/FreshnessGate.ts`

```diff
diff --git a/src/core/FreshnessGate.ts b/src/core/FreshnessGate.ts
new file mode 100644
--- /dev/null
+++ b/src/core/FreshnessGate.ts
@@
+/**
+ * FreshnessGate — outbound factual-freshness gate for agent messages.
+ *
+ * Port of Dawn's freshness-gate.py (the-portal). Catches the
+ * "X-appeal-deadline" pattern: an outgoing message that confidently reports
+ * state about the agent's OWN infrastructure without checking the canonical
+ * sources of truth, producing a claim that contradicts reality.
+ *
+ * Three stages:
+ *   A (triage)  — does this message contain a CHECKABLE self-state claim,
+ *                 and what registry/tree query would surface the canonical
+ *                 answer? Conversational / planning / philosophical content
+ *                 bypasses here.
+ *   B (lookup)  — run the proposed query against CanonicalState (and,
+ *                 optionally, the knowledge tree) — an ACTIVE lookup, not a
+ *                 static document diff.
+ *   C (judge)   — given the message + the canonical answer, is the message
+ *                 contradicted? Score 1-10; propose a minimal rewrite if the
+ *                 score is below threshold.
+ *
+ * Default mode is `dryrun`: the gate logs what it WOULD rewrite but returns
+ * the original text unchanged. Flip to `enforce` only after observing the
+ * JSONL log — and track the flip deadline (do not leave it shadow forever).
+ */
+
+import fs from 'node:fs';
+import path from 'node:path';
+import type { IntelligenceProvider } from './types.js';
+import type { CanonicalState } from './CanonicalState.js';
+
+export type FreshnessMode = 'dryrun' | 'enforce';
+
+export interface FreshnessGateConfig {
+  intelligence?: IntelligenceProvider;
+  canonicalState?: CanonicalState;
+  /** Optional active knowledge-tree lookup: query -> answer text (or null). */
+  treeQuery?: (query: string) => Promise<string | null>;
+  /** dryrun (log only) | enforce (apply rewrite). Default: 'dryrun'. */
+  mode?: FreshnessMode;
+  /** Pass if score >= threshold. Default: 7. */
+  threshold?: number;
+  /** Bypass for messages <= this many chars. Default: 100. */
+  skipShortChars?: number;
+  /** Where to append JSONL verdicts. Default: <stateDir>/metrics/freshness-gate.jsonl */
+  metricsPath?: string;
+}
+
+export interface FreshnessVerdict {
+  stage: 'no-key' | 'no-claim' | 'lookup-error' | 'judged';
+  score: number | null;
+  category: string | null;
+  /** Non-null only when mode === 'enforce' AND score < threshold. */
+  rewrite: string | null;
+  reason: string;
+  claimSummary?: string | null;
+  wouldBlock: boolean;
+}
+
+const TRIAGE_RUBRIC = `You are a freshness-triage sentinel for an AI agent sending a message to its human operator.
+
+YOUR ONE JOB: detect whether this message contains a CHECKABLE FACTUAL CLAIM about the AGENT'S OWN state — the kind with a canonical source of truth in the agent's own infrastructure (state files, registries, dashboards) that could be wrong if that source has moved on.
+
+CHECKABLE (trigger a lookup): account/platform status; platform restrictions/deadlines; deployment/build state; blocker activity; job/infra status; specific metric snapshots; event-timing claims that depend on tracked state.
+
+NOT CHECKABLE (bypass): conversational/philosophical content; plans/proposals/questions; acknowledgments; reflection without specific verifiable state claims; claims about the CONTENT of files the agent just edited this session (recall, not staleness).
+
+If there is a checkable claim, propose a short natural-language QUERY that would surface the canonical state. Pick the SINGLE highest-stakes claim if several are present.
+
+Respond with ONLY a JSON object:
+{"has_claim": true|false, "claim_summary": "one sentence or null", "query": "natural-language query or null"}`;
+
+const JUDGE_RUBRIC = `You are a freshness-verdict sentinel for an AI agent.
+
+The agent drafted a MESSAGE to its operator. It contained this CHECKABLE CLAIM: {claim}
+The agent's canonical state was queried and returned the CANONICAL ANSWER below.
+
+Judge whether the MESSAGE is contradicted, undermined, or rendered stale by the CANONICAL ANSWER. Score 1-10:
+- 10: fully consistent. Pass.
+- 8-9: minor uncertainty / incomplete but not contradicting. Pass.
+- 5-7: canonical answer raises real doubt about a specific claim.
+- 1-4: clear contradiction.
+
+If score < {threshold}: rewrite the message, PRESERVING all other content and voice, adjusting ONLY the specific factual claim (correct it, or hedge it). If score >= {threshold}: rewrite = null. If the canonical answer is empty/unclear: score 8, rewrite null, note that the lookup was uninformative.
+
+Respond with ONLY a JSON object:
+{"score": N, "category": "contradicted"|"hedged"|"uninformative"|"consistent", "rewrite": "..." or null, "reason": "one short sentence"}
+
+MESSAGE:
+{message}
+
+CANONICAL ANSWER:
+{answer}`;
+
+function parseJson(raw: string): any | null {
+  let s = raw.trim();
+  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
+  if (fence) s = fence[1].trim();
+  try { return JSON.parse(s); } catch { return null; }
+}
+
+export class FreshnessGate {
+  private cfg: Required<Pick<FreshnessGateConfig, 'mode' | 'threshold' | 'skipShortChars'>> & FreshnessGateConfig;
+
+  constructor(config: FreshnessGateConfig = {}) {
+    this.cfg = {
+      mode: config.mode ?? 'dryrun',
+      threshold: config.threshold ?? 7,
+      skipShortChars: config.skipShortChars ?? 100,
+      ...config,
+    };
+  }
+
+  /**
+   * Evaluate a candidate outgoing message. Returns the (possibly rewritten)
+   * text plus the verdict. In dryrun mode the text is ALWAYS the original.
+   */
+  async evaluate(text: string): Promise<{ text: string; verdict: FreshnessVerdict }> {
+    const trimmed = text.trim();
+    if (!this.cfg.intelligence) {
+      return { text, verdict: { stage: 'no-key', score: null, category: null, rewrite: null, reason: 'no intelligence provider', wouldBlock: false } };
+    }
+    if (trimmed.length <= this.cfg.skipShortChars) {
+      const v: FreshnessVerdict = { stage: 'no-claim', score: 10, category: 'short-msg', rewrite: null, reason: `short message (${trimmed.length} chars)`, wouldBlock: false };
+      this.log({ ...v, lenOrig: text.length });
+      return { text, verdict: v };
+    }
+
+    // Stage A — triage
+    const triageRaw = await this.cfg.intelligence.evaluate(
+      `${TRIAGE_RUBRIC}\n\nMESSAGE:\n${text}\n\nReply with ONLY a JSON object.`,
+      { model: 'fast', maxTokens: 400, temperature: 0 },
+    );
+    const triage = parseJson(triageRaw);
+    if (!triage?.has_claim || !triage?.query) {
+      const v: FreshnessVerdict = { stage: 'no-claim', score: 10, category: 'no-claim', rewrite: null, reason: 'no checkable state claim', claimSummary: triage?.claim_summary ?? null, wouldBlock: false };
+      this.log({ ...v, lenOrig: text.length });
+      return { text, verdict: v };
+    }
+
+    // Stage B — active canonical lookup
+    const answer = await this.lookup(triage.query);
+    if (answer === null) {
+      const v: FreshnessVerdict = { stage: 'lookup-error', score: null, category: null, rewrite: null, reason: 'canonical lookup failed', claimSummary: triage.claim_summary, wouldBlock: false };
+      this.log({ ...v, lenOrig: text.length, query: triage.query });
+      return { text, verdict: v };
+    }
+
+    // Stage C — judge
+    const judgeRaw = await this.cfg.intelligence.evaluate(
+      JUDGE_RUBRIC
+        .replace('{claim}', triage.claim_summary ?? '(no summary)')
+        .replace(/\{threshold\}/g, String(this.cfg.threshold))
+        .replace('{message}', text)
+        .replace('{answer}', answer || '(empty — no relevant canonical content)')
+        + '\n\nReply with ONLY a JSON object.',
+      { model: 'fast', maxTokens: 1200, temperature: 0 },
+    );
+    const judge = parseJson(judgeRaw);
+    const score: number | null = typeof judge?.score === 'number' ? judge.score : null;
+    const rewrite: string | null = judge?.rewrite ?? null;
+    const wouldBlock = !!rewrite && score !== null && score < this.cfg.threshold;
+
+    const verdict: FreshnessVerdict = {
+      stage: 'judged',
+      score,
+      category: judge?.category ?? null,
+      rewrite: this.cfg.mode === 'enforce' && wouldBlock ? rewrite : null,
+      reason: judge?.reason ?? '',
+      claimSummary: triage.claim_summary,
+      wouldBlock,
+    };
+    this.log({ ...verdict, lenOrig: text.length, query: triage.query, mode: this.cfg.mode });
+
+    const outText = (this.cfg.mode === 'enforce' && wouldBlock && rewrite) ? rewrite : text;
+    return { text: outText, verdict };
+  }
+
+  /** Stage B: prefer the active knowledge tree if provided, else CanonicalState. */
+  private async lookup(query: string): Promise<string | null> {
+    try {
+      if (this.cfg.treeQuery) {
+        const ans = await this.cfg.treeQuery(query);
+        if (ans) return ans;
+      }
+      if (this.cfg.canonicalState) {
+        const fact = this.cfg.canonicalState.findFact(query);
+        if (fact) return `Q: ${fact.question}\nA: ${fact.answer}\n(verified ${fact.lastVerified}, source ${fact.source})`;
+        // No direct hit — return the compact summary so the judge can still reason.
+        return this.cfg.canonicalState.getCompactSummary() || '';
+      }
+      return '';
+    } catch {
+      return null;
+    }
+  }
+
+  private log(record: Record<string, unknown>): void {
+    const p = this.cfg.metricsPath;
+    if (!p) return;
+    try {
+      fs.mkdirSync(path.dirname(p), { recursive: true });
+      fs.appendFileSync(p, JSON.stringify({ ...record, ts: new Date().toISOString() }) + '\n');
+    } catch { /* metrics are best-effort */ }
+  }
+}
```

### Part 2 — wire into `src/messaging/TelegramAdapter.ts`

Mirror the `setSummarySentinel` attach pattern exactly. The gate is optional and
dryrun-by-default, so existing behavior is unchanged until a host opts in.

```diff
diff --git a/src/messaging/TelegramAdapter.ts b/src/messaging/TelegramAdapter.ts
--- a/src/messaging/TelegramAdapter.ts
+++ b/src/messaging/TelegramAdapter.ts
@@ class TelegramAdapter ... fields
+  /** Optional outbound freshness gate (PROP-756). Dryrun unless host enforces. */
+  private freshnessGate: import('../core/FreshnessGate.js').FreshnessGate | null = null;
+
+  /** Attach an outbound freshness gate. Optional; no-op if never called. */
+  setFreshnessGate(gate: import('../core/FreshnessGate.js').FreshnessGate): void {
+    this.freshnessGate = gate;
+  }
@@ async send(message: OutgoingMessage): Promise<SendResult> {
     const topicId = message.channel?.identifier;
+    let content = message.content;
+    if (this.freshnessGate) {
+      try {
+        const { text } = await this.freshnessGate.evaluate(content);
+        content = text; // dryrun returns original; enforce may return a rewrite
+      } catch (err) {
+        console.warn('[telegram] freshness gate error (passing through):', err);
+      }
+    }
     const params: Record<string, unknown> = {
       chat_id: this.config.chatId,
-      text: message.content,
+      text: content,
       parse_mode: 'Markdown',
     };
@@ async sendToTopic(topicId: number, text: string, options?: ...): Promise<SendResult> {
+    if (this.freshnessGate && !options?.skipStallClear) {
+      try {
+        const res = await this.freshnessGate.evaluate(text);
+        text = res.text;
+      } catch (err) {
+        console.warn('[telegram] freshness gate error (passing through):', err);
+      }
+    }
     const params: Record<string, unknown> = {
       chat_id: this.config.chatId,
       text,
     };
```

### Part 3 — config (`src/core/Config.ts`)

Add an optional, dryrun-default config block and a **flip-tracking deadline** so
the shadow phase has a forcing function (per the trap):

```diff
+  freshnessGate?: {
+    enabled?: boolean;          // default false until a host wires it
+    mode?: 'dryrun' | 'enforce'; // default 'dryrun'
+    threshold?: number;          // default 7
+    skipShortChars?: number;     // default 100
+    flipDeadline?: string;       // ISO date; a reviewer surfaces "OVERDUE" past it
+  };
```

## Test evidence

**Not run** — this is a filing-only PROP (PROP-379); Dawn's job runs outside
Instar's `/instar-dev` gate and cannot produce the trace/side-effects artifact
the pre-commit hook requires. The Python original is production-proven in
the-portal. The adopting `/instar-dev` agent should add and run:

- `tests/unit/FreshnessGate.test.ts`
  - **true contradiction**: CanonicalState fact "X account: reinstated 2026-04-20"
    vs message "X appeal deadline in 2 days" → score < 7, rewrite proposed,
    `wouldBlock === true`. In dryrun, returned text is unchanged.
  - **correct bypass**: a philosophical/conversational message → stage
    `no-claim`, score 10, no rewrite.
  - **short-message bypass**: a 20-char ack → stage `no-claim`, `short-msg`.
  - **lookup failure**: provider/state throws → stage `lookup-error`, passes
    through unchanged.
- Wiring test: a `TelegramAdapter` with a stub gate in `dryrun` sends the
  ORIGINAL text even when the gate proposes a rewrite (proves shadow safety).

## Typecheck status

Not run (filing-only). The diff uses only existing exported symbols verified this
session: `IntelligenceProvider.evaluate`, `CanonicalState.findFact` /
`getQuickFacts` / `getCompactSummary`, and the `setSummarySentinel` attach
pattern. The `treeQuery` injection keeps `TreeTraversal` an optional dependency
so the gate compiles without it.

## Files touched

- `src/core/FreshnessGate.ts` — **new**. The three-stage gate.
- `src/messaging/TelegramAdapter.ts` — add `freshnessGate` field +
  `setFreshnessGate()` + a pre-send `evaluate()` call in `send()` and
  `sendToTopic()`.
- `src/core/Config.ts` — optional `freshnessGate` config block with `flipDeadline`.
- `src/index.ts` — re-export `FreshnessGate` (1 line, alongside other core exports).
- `tests/unit/FreshnessGate.test.ts` — **new**. The four fixtures above.

## Adoption steps for /instar-dev

1. Open a spec scaffold for "outbound freshness gate", run `/spec-converge`.
2. Apply the Part 1–3 diffs; decide the host wiring point that calls
   `setFreshnessGate()` (the same bootstrap that calls `setSummarySentinel()`).
3. Add `tests/unit/FreshnessGate.test.ts`; run `pnpm test` + `tsc --noEmit`.
4. Ship in `mode: 'dryrun'` with a `flipDeadline` set; have an existing reviewer
   surface "OVERDUE" past the deadline so the shadow phase cannot rot (the
   "Shadow-Mode Without Forcing Function" lesson — do NOT flip-by-intention).
5. After observing the JSONL log for the soak window, flip to `enforce`.

## Why this respects the boundary

Instar governs its own `src/` through `/instar-dev` + `/spec-converge`. This PROP
hands over a full, ready diff and the rationale, but leaves the landing decision
and the gate-check with Instar. Structure > willpower: the human stops being the
detector for stale self-state claims, and every adapter inherits the check
through one chokepoint instead of per-callsite discipline.
