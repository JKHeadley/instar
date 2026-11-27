# PROP-1055 — Consent-artifact invariant on the Telegram send path

**Source:** Dawn `instar-feature-parity` job (2026-08-13), cross-pollinated from
Dawn's lesson `feedback_reviewed_text_is_the_consent_artifact`.
**Impact:** high · **Effort:** small · **Type:** infrastructure

## Problem

Dawn's hard-won principle: **the reviewed text is the consent artifact.** Human/
gate approval attaches to the *literal reviewed bytes*; every apply/publish path
must deliver that content without silent re-composition. The reviewed artifact is
the source of truth, and what ships must equal what was approved (only
presentation markup may differ).

Instar violates this on the Telegram send path. The CoherenceGate + reviewers
approve the candidate response as GitHub-flavored markdown in `params.text`. Then,
decoupled and downstream, `applyTelegramFormatter` (`src/messaging/TelegramAdapter.ts:4146`)
replaces those approved bytes with `formatForTelegram(...)` output before the Bot
API call:

```ts
const result = formatForTelegram(stripped.text as string, mode);
const outgoing = { ...stripped, text: result.text };  // approved bytes replaced
```

The transform is deterministic, but **nothing asserts it is content-preserving.**
The only safety net is a *400-error* plain-retry fallback — a formatter/escaping
regression or an over-eager lint rewrite that produces valid-but-altered HTML
sends 200 OK, and the user receives text no gate ever saw. There is:

- No invariant that delivered visible content == approved visible content.
- No persisted consent artifact / fallback to the approved bytes on drift.
- No reviewer covering it (checked all 10 in `src/core/reviewers/`;
  none address byte/content preservation) and it is distinct from PROP-994
  (state-freshness reviewer).

## Proposed patch

Three files. A pure `consentArtifact.ts` helper, a metrics counter, and a
send-time invariant in `applyTelegramFormatter` that — on genuine content drift —
falls back to sending the **approved text verbatim** (plain, no `parse_mode`) so
the worst case is exactly the bytes the gate approved, never a mutated render.

**New file `src/messaging/consentArtifact.ts`:**

```ts
/**
 * Consent-artifact invariant for the Telegram send path.
 * Cross-pollinated from Dawn's `feedback_reviewed_text_is_the_consent_artifact`:
 * the reviewed text is the source of truth; the delivered content must equal it
 * (only presentation markup may differ). Compares the sorted multiset of visible
 * content tokens on both sides — markdown markers, HTML tags and entity escapes
 * are normalized away, so legitimate formatting differences do not trip it; only
 * genuine content drift does.
 */
const WORD_TOKEN_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}'’._-]*[\p{L}\p{N}])?/gu;

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'",
};
function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (m) => ENTITIES[m] ?? m);
}

/** Reduce rendered Telegram HTML to comparable visible text: surface href/src
 *  URLs (Telegram links carry the URL only in the attribute; markdown carries it
 *  inline), then strip tags and decode the fixed entity set. */
function renderedToVisible(html: string): string {
  const urls: string[] = [];
  const attrRe = /(?:href|src)\s*=\s*"([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(html)) !== null) urls.push(decodeEntities(m[1]));
  const stripped = html.replace(/<[^>]*>/g, ' ');
  return `${decodeEntities(stripped)} ${urls.join(' ')}`;
}

function contentTokens(s: string): string[] {
  return (s.match(WORD_TOKEN_RE) ?? []).map((t) => t.toLowerCase()).sort();
}
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface ContentPreservationResult {
  preserved: boolean;
  approvedTokenCount: number;
  renderedTokenCount: number;
}

/** IMPORTANT: callers must SKIP this on already-signaled lossy paths
 *  (`FormatResult.truncated` / `conversionSkipped`). */
export function assertContentPreserved(
  approved: string,
  rendered: string,
): ContentPreservationResult {
  const approvedTokens = contentTokens(approved);
  const renderedTokens = contentTokens(renderedToVisible(rendered));
  return {
    preserved: arraysEqual(approvedTokens, renderedTokens),
    approvedTokenCount: approvedTokens.length,
    renderedTokenCount: renderedTokens.length,
  };
}
```

**`src/messaging/telegramFormatMetrics.ts`** — add a counter:

```diff
 interface FormatMetricsState {
   formatAppliedTotal: Map<string, number>;
   formatLintIssuesTotal: Map<string, number>;
   formatFallbackPlainRetryTotal: number;
+  formatContentDriftTotal: number; // consent-artifact invariant tripped
 }

 const state: FormatMetricsState = {
   formatAppliedTotal: new Map(),
   formatLintIssuesTotal: new Map(),
   formatFallbackPlainRetryTotal: 0,
+  formatContentDriftTotal: 0,
 };

+/** Consent-artifact invariant tripped: rendered content diverged from approved. */
+export function recordFormatContentDrift(): void {
+  state.formatContentDriftTotal += 1;
+}
+
 export interface FormatMetricsSnapshot {
   formatAppliedTotal: Record<string, number>;
   formatLintIssuesTotal: Record<string, number>;
   formatFallbackPlainRetryTotal: number;
+  formatContentDriftTotal: number;
 }
```
(mirror `formatContentDriftTotal` in `getFormatMetricsSnapshot()` return and reset
it in `resetFormatMetrics()`.)

**`src/messaging/TelegramAdapter.ts`** — imports, return-type field, the invariant,
and a DegradationReporter fire at the `apiCall` call site:

```diff
 import {
   recordFormatApplied,
   recordFormatLintIssue,
   recordFormatFallbackPlainRetry,
+  recordFormatContentDrift,
 } from './telegramFormatMetrics.js';
+import { assertContentPreserved } from './consentArtifact.js';
```

```diff
   outgoingParams: Record<string, unknown>;
   originalParams: Record<string, unknown>;
   didFormat: boolean;
   isPlainRetry: boolean;
+  contentDrift: boolean;
 } {
```

In `applyTelegramFormatter`, after `formatForTelegram`:

```diff
-  const result = formatForTelegram(stripped.text as string, mode);
+  const approvedText = stripped.text as string;
+  const result = formatForTelegram(approvedText, mode);
   recordFormatApplied(result.modeApplied);
   for (const issue of result.lintIssues) {
     recordFormatLintIssue(issue);
   }
+
+  // Consent-artifact invariant: the reviewed text is the source of truth, so the
+  // rendered output must preserve its visible content. Skip on already-signaled
+  // lossy paths. On genuine drift, send the approved text VERBATIM (plain).
+  if (!result.truncated && !result.conversionSkipped) {
+    const check = assertContentPreserved(approvedText, result.text);
+    if (!check.preserved) {
+      recordFormatContentDrift();
+      const plain: Record<string, unknown> = { ...stripped, text: approvedText };
+      delete plain.parse_mode;
+      return { outgoingParams: plain, originalParams: params,
+               didFormat: false, isPlainRetry: false, contentDrift: true };
+    }
+  }
+
   const outgoing: Record<string, unknown> = { ...stripped, text: result.text };
```
(both other `return` sites of the function get `contentDrift: false`.)

At the `applyTelegramFormatter(...)` call in `apiCall`:

```diff
     const sendParams = applyTelegramFormatter(method, params, this.config.getFormatMode?.());
+    if (sendParams.contentDrift) {
+      DegradationReporter.getInstance().report({
+        feature: 'Telegram.Formatter',
+        primary: 'Deliver reviewed text rendered as Telegram HTML',
+        fallback: 'Sent approved text verbatim as plain (no parse_mode)',
+        reason: 'Rendered output failed the consent-artifact content-preservation invariant',
+        impact: 'Formatting dropped for this message; content matches what was approved. Indicates a formatter/escaping regression.',
+      });
+    }
```

## Test evidence

- **Typecheck:** implemented all four edits in the `instar-main` worktree,
  `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` → **exit 0, zero
  errors**. Reverted cleanly afterward (PROP-filing-only; no src commit).
- **Behavioral:** ran the algorithm against 7 cases (standalone mirror) — all
  PASS:
  - `**bold**` → `<b>bold</b>` — preserved ✓
  - `[Anthropic](https://anthropic.com)` → `<a href="…">Anthropic</a>` (full
    sentence) — preserved ✓ (href URL surfaced so link URL is comparable)
  - `a < b && c > d` → `a &lt; b &amp;&amp; c &gt; d` — preserved ✓ (entities)
  - `` `npm test` `` → `<code>npm test</code>` — preserved ✓
  - dropped word (`the quick brown fox` → `the quick <b>fox</b>`) — drift caught ✓
  - injected word (`hello there` → `hello there <b>EXTRA</b>`) — drift caught ✓
- **Not run:** the Instar jest suite (job is PROP-filing-only, outside
  `/instar-dev`). A unit test for `consentArtifact.ts` (the 7 cases above) plus a
  `getFormatMetricsSnapshot().formatContentDriftTotal` assertion should be added
  during adoption.

## Files touched
- `src/messaging/consentArtifact.ts` — new pure helper (the invariant).
- `src/messaging/telegramFormatMetrics.ts` — `formatContentDriftTotal` counter.
- `src/messaging/TelegramAdapter.ts` — wire invariant into `applyTelegramFormatter`
  + drift DegradationReporter fire in `apiCall`.

## Adoption steps for /instar-dev
1. Open a spec scaffold for "consent-artifact send-path invariant", run
   `/spec-converge`.
2. Apply the diff above; add `tests/unit/consent-artifact.test.ts` (7 cases +
   metrics-counter assertion).
3. Run `/instar-dev` to produce trace + side-effects artifact; commit through the
   normal gate.

## Design notes / boundaries
- **Multiset (order-independent) comparison** is deliberate: HTML may emit the
  href attribute before the link text; sequence comparison would false-positive.
- **Skip on `truncated` / `conversionSkipped`** — those are already-signaled lossy
  paths where token divergence is expected and intentional.
- **Fail toward the consent artifact, not toward silence:** on drift the message
  still sends — as the exact approved bytes, plain. No user-facing message is
  dropped; only the (suspect) formatting is.
