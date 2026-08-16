# Gemini 3.1 Pro Review: TELEGRAM-MARKDOWN-RENDERER-SPEC.md

**Model**: gemini-3.1-pro-preview
**Date**: 2026-04-24
**Focus**: full document

---

## Raw Model Response

### 1. Overall Assessment
- **Score**: 9/10
- **Status**: CONDITIONAL APPROVAL
- **Summary**: Exceptionally mature, battle-tested specification. Addresses complex edge cases in distributed systems (GitSync), security (ReDoS, IDN homoglyphs, auth gating), and operational safety (hot-reloadable config rollbacks). Architectural decision to place formatter *after* LLM rewrite gates and *before* length-splitting is correct. Needs minor adjustments re: regex limitations, retry idempotency, and data-store scaling.

### 2. Critical Issues (Must Fix)

**Issue 1: Broken Link Regex for URLs with Parentheses**
- **What**: Step 10's regex `\[([^\]\n]+)\]\(([^)\n]+)\)` stops at first closing paren.
- **Why it matters**: Fails on Wikipedia-style URLs like `[Entity](https://en.wikipedia.org/wiki/Entity_(computer_science))`; truncates URL and leaves trailing garbage.
- **Suggested fix**: Use balanced-paren pattern or `\[([^\]\n]+)\]\(([^>\s\n]+)\)`; alternatively swap to a small AST parser for links.
- **Section**: Markdown conversion rules → Step 10.

**Issue 2: Idempotency Key Collision on 400 Plain-Retry**
- **What**: Plain-retry uses raw text with the same raw-derived idempotency key as the failed send.
- **Why it matters**: Downstream dedup may drop the retry or return the cached 400.
- **Suggested fix**: Suffix the key on fallback: `${originalIdempotencyKey}:fallback-plain`.
- **Section**: Pipeline ordering → Plain-retry fallback AND Idempotency.

**Issue 3: Length-Splitter Re-entry on 400 Plain-Retry**
- **What**: Spec doesn't state that raw text used in plain-retry must re-enter the length-splitter.
- **Why it matters**: Raw text may exceed 4096-char cap; retry could fail with 400-too-long.
- **Suggested fix**: Explicitly route fallback text through length-split before Bot API call.
- **Section**: Pipeline ordering → Plain-retry fallback.

### 3. Strengths
- Pipeline ordering (formatter last, after rewrite gates) — strongest arch decision.
- Rollback strategy — hot-reloadable config flip beats code revert.
- Security posture — distinct `escapeHtmlText` vs `escapeHtmlAttribute`, WHATWG URL parsing, strict internal caller allowlist for `html` mode.
- ReDoS defenses — 32KB guard + Vitest fuzz.
- GitSync trust boundary — ignoring `alreadyFormatted` on receiver keeps sender authoritative.

### 4. Gaps & Missing Elements
- Template double-escape UX — legitimate `<` or `&` in user names renders as entities users see literally.
- MessageStore bloat — JSON-backed store with `rawText + sentText + modeApplied` ~doubles message payload.
- Rate limit on retry — spec doesn't say whether plain-retry consumes additional token from per-chat queue.

### 5. Industry Comparison
- Regex vs AST — industry standard is AST (marked.js, markdown-it). Regex acceptable for Telegram's small HTML subset.
- URL sanitization — aligns with OWASP best practices.
- Separation of concerns — classic Hexagonal pattern; platform formatting at edge.

### 6. Scalability Assessment
- Phase 1 (10-50): flawless.
- Phase 2 (50-500): regex protected by 32KB cap; JSON MessageStore starts straining from doubled payloads.
- Phase 3 (500-5000): MessageStore needs migration to SQLite/Postgres.

### 7. Recommendations (Prioritized)
1. Update the link regex to handle parens in URLs (Wikipedia case).
2. Patch the 400 retry pipeline — route fallback raw text through length-splitter AND suffix idempotency key with `:fallback-plain`.

[RESPONSE TRUNCATED AT 4000-TOKEN OUTPUT CAP]

---

## Subagent Analysis

- Gemini's review is substantive and specific; three critical issues are genuine technical problems.
- Paren-in-URL finding is a high-value catch not surfaced by prior internal reviewers — Wikipedia-style URLs are common in agent output.
- Idempotency-key collision on plain-retry is the most consequential finding.
- Gap findings (MessageStore bloat, rate-limit on retry, template double-escape UX) each deserve a one-line spec addendum.
- Score 9/10 CONDITIONAL aligns with internal-reviewer consensus.
- NOTE: Subagent reported Write/Bash permission denial for original output path; content persisted by orchestrator.
