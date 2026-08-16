# Business Model Analysis: GitHub Collaboration Monitor (Sentinel)

**Review ID**: 20260329-171130
**Round**: 2
**Reviewer**: Business Model Analyst

## Approval Status

**APPROVE** (conditional on one operational clarification)

Round 2 revisions resolved every business concern from Round 1. The cost ceiling is now defined, the scope is explicitly acknowledged as Echo-only with a documented generalization path, and audit logging is in place.

---

## Round 2 Changes Assessment

### Cost Ceiling and Budget Controls — RESOLVED

- `maxReviewsPerRun: 5` caps Opus invocations per cycle
- `maxTokenEstimate: 200,000` gates spawning before it happens
- Token estimation formula documented (~4 tokens/diff line)
- Overflow behavior specified: items queue with notification rather than silently dropping

At worst-case 1,000-line diffs, a single Stage 2 run consumes ~20K input tokens. At Opus pricing (~$15/MTok input), that's ~$0.30/run maximum, ~$0.60/day. Monthly ceiling: ~$18/month. Realistic cost (most scans find nothing): under $5/month. Negligible relative to value.

### Echo-Only Scope Notation — RESOLVED

The spec now states: "The architecture is parameterizable — repo name, identity, and thresholds are all configurable — so it can graduate to a general capability if validated." Correct sequencing.

### Audit Logging — RESOLVED

Every decision writes to `.instar/logs/github-review-decisions.jsonl` with full signal context. Minimum viable audit trail. Enables shadow-mode validation and retrospective misclassification analysis.

---

## Build vs. Buy Analysis

**GitHub Copilot Code Review** shipped an agentic architecture on March 5, 2026 — full repository context, automatic review on every PR, CLI integration. Available to all Copilot Pro+ subscribers. 12,000+ organizations run it automatically.

**CodeRabbit** offers unlimited public/private repos free (rate-limited to 3 back-to-back reviews, then 4/hour). Pro is $24/developer/month.

**Build remains justified** despite competitive maturation, for structural reasons:

1. Instar-specific context: Neither tool knows about the trust model, security-sensitive paths, or architectural conventions
2. Agent-native integration: The value is the full pipeline — scan, classify, notify, skip ledger, trust tracking — not just review comments
3. EchoOfDawn as collaborator with repository history, not an anonymous bot
4. Copilot review is closed — no instar job integration, no Telegram relay, no trust model
5. CodeRabbit free tier rate limits constrain burst scenarios and cannot integrate with instar infrastructure

**Honest counterargument**: If Justin ends up ignoring Telegram notifications and just checking GitHub, this delivers no incremental value over CodeRabbit free. The shadow-mode requirement (5 correct recommendations before auto-merge) ensures build cost doesn't compound into operational risk.

---

## Remaining Open Question

Which Telegram topic receives GitHub notifications is unresolved (spec lists it as an open question). Operational, not architectural — resolve before first live scan.

---

## Recommendations

| Priority | Recommendation |
|----------|---------------|
| Operational | Decide Telegram topic before first live scan |
| P3 | Monitor Copilot code review evolution — if it adds instar-context awareness, reassess build vs. buy |
| P3 | Track actual API costs in first 30 days to validate the theoretical cost model |

---

## Score: 8 / 10 (up from 6/10 in Round 1)

+2 points for: P0 cost ceiling fully resolved, scope documentation accurate and honest, audit trail specified.

-2 points for: build vs. buy value depends on the full pipeline actually being used (execution risk if integration value isn't realized); Copilot's March 2026 agentic review launch meaningfully narrows the differentiation window.

---

Sources:
- [CodeRabbit Pricing](https://www.coderabbit.ai/pricing)
- [Copilot code review agentic architecture](https://github.blog/changelog/2026-03-05-copilot-code-review-now-runs-on-an-agentic-architecture/)
- [Request Copilot code review from GitHub CLI](https://github.blog/changelog/2026-03-11-request-copilot-code-review-from-github-cli/)
- [60 million Copilot code reviews and counting](https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/)
