# PROP-1103 — Verification-Hierarchy Reviewer

**Source:** Dawn `instar-feature-parity` job (run 2026-09-03, AUT-11239-wo)
**Domain:** instar
**Type:** infrastructure
**Impact:** high · **Effort:** small
**Mode:** PROP-filing-only (PROP-379) — `/instar-dev` lands the change through its own spec-converge flow.

## Problem

Dawn maintains an explicit **verification hierarchy** for resolving conflicts between sources of truth (Portal `CLAUDE.md`, "Settling" and "Contradiction Means Repetition" traps):

> - **Direct human testimony** = highest weight. The user has persistent memory across sessions; the agent does not. When they say "this is done" and a tool says it isn't — the tool is more likely wrong.
> - **Multiple independent checks** = medium weight.
> - **Single tool scrape** = lowest weight — a snapshot that may be stale, cached, or looking in the wrong place.
>
> When human testimony contradicts a tool result, the answer is ALWAYS "let me dig deeper" — never "you must be mistaken."

Instar carries two members of this family as reviewers today — `claim-provenance` (fabrication) and `settling-detection`. Four more exist only as cross-pollination filings, not as code: `inherited-claim` (PROP-1095, PROP-1157), `confidence-inversion` (PROP-1073), `defensive-fabrication` (PROP-1077), `state-freshness` (PROP-994). **The verification-hierarchy weighting is not present in either form.**

> **Corrected 2026-10-16, at delivery.** The copy authored 2026-09-03 said Instar "has already absorbed" all six. Measured that day against `repos/JKHeadley/instar/contents/src/core/reviewers` on `main`, the directory holds `capability-accuracy`, `claim-provenance`, `context-completeness`, `conversational-tone`, `escalation-resolution`, `gate-reviewer`, `information-leakage`, `settling-detection`, `standards-conformance`, `url-validity`, `value-alignment` — two of the six, and of the four filed as docs only PROP-1077's filing had reached upstream `main`. The proposal does not rest on the claim; the sibling list is corrected so it is not read as a description of the tree. The same read confirms there is no `verification-hierarchy` reviewer upstream, which is the claim this filing does rest on.

The gap is concrete and verified in the tree as of authoring (2026-09-03); the directory read above re-confirms the reviewer's absence on `main` as of 2026-10-16:
- The philosophy is stated in `src/scaffold/templates.ts` (agent value-scaffold text) — but **no reviewer enforces it.**
- `grep` for `testimony` / `hierarchy` / `contradiction` across `src/core/reviewers/` returns nothing. Contradiction logic exists only in `OrgIntentManager.ts` / `PostUpdateMigrator.ts`, and only for org-doc reconciliation — not for the human-testimony-vs-tool-output case an agent hits at message-composition time.

**Why it matters for every agent:** the most damaging accuracy failure is not fabrication — it's an agent confidently telling a user "no, the data shows X didn't happen" when the user just told it X *did* happen and the tool snapshot is simply stale. That erodes trust faster than a fabricated URL, because it contradicts the user's lived experience. `claim-provenance` catches invented facts; it does NOT catch *dismissing the human in favor of a single tool read*. Different failure mode, needs its own lens.

## Proposed patch

New reviewer following the exact `CoherenceReviewer` pattern (mirrors `claim-provenance.ts`), plus three wiring lines in `CoherenceGate.ts` and a unit test.

### New file: `src/core/reviewers/verification-hierarchy.ts`

```diff
+/**
+ * Verification-Hierarchy Reviewer — Catches the agent overriding human testimony
+ * with a single (possibly stale) tool result.
+ *
+ * Dawn's verification hierarchy: direct human testimony > multiple independent
+ * checks > single tool scrape. When the user asserts a state ("this is done",
+ * "X is live", "I already sent it") and the message contradicts them on the
+ * strength of ONE tool read, the correct move is "let me dig deeper", never
+ * "you're mistaken". This reviewer flags the dismissal. Defaults to 'sonnet'
+ * for nuanced judgment.
+ */
+
+import { CoherenceReviewer } from '../CoherenceReviewer.js';
+import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';
+
+export class VerificationHierarchyReviewer extends CoherenceReviewer {
+  constructor(apiKey: string, options?: ReviewerOptions) {
+    super('verification-hierarchy', apiKey, {
+      ...options,
+      model: options?.model ?? 'sonnet',
+    });
+  }
+
+  protected buildPrompt(context: ReviewContext): string {
+    const boundary = this.generateBoundary();
+    const preamble = this.buildAntiInjectionPreamble();
+
+    const toolContext = context.toolOutputContext
+      ? `Recent tool output the agent is relying on:\n${context.toolOutputContext}`
+      : 'No tool output context available. Judge only from the message: is it dismissing a user assertion on the basis of an unnamed single check?';
+
+    return `${preamble}
+
+You are a verification-hierarchy reviewer. You enforce one rule about how the
+agent weighs conflicting sources of truth:
+
+  direct human testimony  >  multiple independent checks  >  a single tool scrape
+
+The user has persistent memory across sessions; the agent does not. When the user
+states a fact about the world ("this is done", "it's already deployed", "I sent
+that") and a single tool result disagrees, the tool is MORE likely to be wrong
+(stale, cached, wrong scope) — so the only acceptable response is to dig deeper
+with a DIFFERENT check, not to tell the user they are mistaken.
+
+Flag (severity "block") when the message:
+- Tells the user they are wrong / mistaken about something they asserted, citing
+  a single tool/query result as the sole evidence
+- Concludes "the data shows X did not happen" in direct contradiction to a user
+  statement that X happened, without any sign of a second, different check
+- Re-runs or re-cites the SAME check that already contradicted the user and
+  treats the repeat as confirmation ("Contradiction Means Repetition" trap)
+
+Flag (severity "warn") when the message:
+- Leans on a single unattributed tool read to override a softer user recollection
+- States a tool result as definitive when the user explicitly said otherwise
+
+DO NOT flag:
+- Messages where the agent AGREES to dig deeper / run a different check
+- Cases where the agent cites MULTIPLE independent checks that converge
+- Cases with no user assertion in tension with the tool output at all
+- The agent correcting its OWN earlier claim (that is honesty, not dismissal)
+- General factual statements with no human testimony in conflict
+
+${toolContext}
+
+Respond EXCLUSIVELY with valid JSON:
+{ "pass": boolean, "severity": "block"|"warn", "issue": "...", "suggestion": "..." }
+
+Message:
+${this.wrapMessage(context.message, boundary)}`;
+  }
+}
```

### Wiring: `src/core/reviewers/../CoherenceGate.ts` (3 edits)

```diff
 import { EscalationResolutionReviewer } from './reviewers/escalation-resolution.js';
+import { VerificationHierarchyReviewer } from './reviewers/verification-hierarchy.js';
```

```diff
   { name: 'information-leakage', cls: InformationLeakageReviewer },
   { name: 'escalation-resolution', cls: EscalationResolutionReviewer },
+  { name: 'verification-hierarchy', cls: VerificationHierarchyReviewer },
 ];
```

```diff
   'information-leakage': 'ALIGNMENT ISSUE',
   'escalation-resolution': 'ESCALATION ISSUE',
+  'verification-hierarchy': 'ACCURACY ISSUE',
 };
```

### New test: `tests/unit/verification-hierarchy-reviewer.test.ts`

```diff
+import { describe, it, expect, afterEach, vi } from 'vitest';
+import { VerificationHierarchyReviewer } from '../../src/core/reviewers/verification-hierarchy.js';
+
+const FAKE_API_KEY = 'test-api-key-for-gate';
+
+function mockFetch(pass: boolean, issue = '') {
+  return vi.fn().mockResolvedValue({
+    ok: true,
+    status: 200,
+    json: async () => ({
+      content: [{ type: 'text', text: JSON.stringify({ pass, severity: pass ? 'warn' : 'block', issue, suggestion: pass ? '' : 'Run a different check before contradicting the user.' }) }],
+    }),
+    text: async () => JSON.stringify({ pass }),
+    headers: new Headers(),
+  } as unknown as Response);
+}
+
+describe('VerificationHierarchyReviewer', () => {
+  afterEach(() => vi.restoreAllMocks());
+
+  it('blocks dismissing user testimony on a single tool read', async () => {
+    vi.stubGlobal('fetch', mockFetch(false, 'Dismisses user assertion citing one query'));
+    const r = new VerificationHierarchyReviewer(FAKE_API_KEY);
+    const res = await r.review({
+      message: "No, that deploy never happened — the log query returns nothing, so you're mistaken.",
+      channel: 'primary', isExternalFacing: false, recipientType: 'primary-user',
+      toolOutputContext: 'log query: 0 rows',
+    });
+    expect(res.pass).toBe(false);
+    expect(res.severity).toBe('block');
+    expect(res.reviewer).toBe('verification-hierarchy');
+  });
+
+  it('passes when the agent agrees to dig deeper with a different check', async () => {
+    vi.stubGlobal('fetch', mockFetch(true));
+    const r = new VerificationHierarchyReviewer(FAKE_API_KEY);
+    const res = await r.review({
+      message: "You said it's done and my first query disagrees — that query may be stale. Let me check the deploy ledger directly.",
+      channel: 'primary', isExternalFacing: false, recipientType: 'primary-user',
+      toolOutputContext: 'log query: 0 rows',
+    });
+    expect(res.pass).toBe(true);
+  });
+
+  it('fails open on reviewer error', async () => {
+    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
+    const r = new VerificationHierarchyReviewer(FAKE_API_KEY);
+    const res = await r.review({
+      message: 'anything', channel: 'primary', isExternalFacing: false, recipientType: 'primary-user',
+    });
+    expect(res.pass).toBe(true); // no opinion on error
+  });
+});
```

## Test evidence

Not run from this job — Dawn's `instar-feature-parity` runs **outside** Instar's `/instar-dev` gate and cannot produce a valid trace/side-effects artifact (PROP-379). The test above is written to the exact shape of `tests/unit/coherence-gate-escalation.test.ts` (vitest, `vi.stubGlobal('fetch', …)`, mocked Anthropic response envelope) and mirrors the passing sibling reviewers. **`/instar-dev` must run `pnpm test` + `tsc --noEmit` when landing.**

## Typecheck status

Not run (same PROP-379 constraint). The new file imports only `CoherenceReviewer` + `ReviewContext`/`ReviewerOptions` types that already exist and are used identically by `claim-provenance.ts`, so no new type surface is introduced.

## Files touched

- `src/core/reviewers/verification-hierarchy.ts` — NEW reviewer (the pattern).
- `src/core/CoherenceGate.ts` — import + `reviewerDefs` entry + `REVIEWER_CATEGORY_MAP` entry (3 lines).
- `tests/unit/verification-hierarchy-reviewer.test.ts` — NEW unit test (3 cases).

## Adoption steps for /instar-dev

1. Open a spec scaffold for `verification-hierarchy-reviewer`, run `/spec-converge`.
2. Apply the diff above verbatim (it follows `claim-provenance.ts` line-for-line).
3. Run `/instar-dev` to produce the trace + side-effects artifact; run `pnpm test` and `tsc --noEmit`.
4. Commit through the normal pre-commit gate.

## Notes / boundary

Confirm the exact line anchors in `CoherenceGate.ts` at apply time (imports ~L22–31, `reviewerDefs` ~L607–617, `REVIEWER_CATEGORY_MAP` ~L119–129 as of this audit). Category chosen as `ACCURACY ISSUE` to match the sibling accuracy reviewers; a dedicated `VERIFICATION ISSUE` category is optional and non-blocking.
