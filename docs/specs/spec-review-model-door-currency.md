---
kind: "spec"
id: "spec-review-model-door-currency"
title: "Spec-Review Model + Door Currency (reviewers always resolve the strongest AVAILABLE model on a REACHABLE door)"
summary: "The spec-converge external reviewers request the strongest ('capable') tier per door, but the tier→model maps are STATIC hardcoded allowlists and one door (gemini-cli) is now DEAD. Result: (1) a newly-shipped frontier model (GPT-5.6 Sol, Gemini 3.5 Pro) is NOT auto-adopted 'when available' — it needs a manual map bump; (2) the Gemini external pass silently degrades because gemini-cli stopped serving on 2026-06-18 (replaced by Antigravity CLI `agy`); (3) the Claude-door internal reviewers do not run on the strongest Claude model (Fable 5) because tierEscalation for the spec-converge trigger ships dark+dryRun. This spec makes reviewer model+door resolution CURRENCY-aware (adopt the newest strongest per door) and AVAILABILITY-aware (never claim a pass on a dead/unreachable door), and graduates the Fable-5 escalation for spec-review. Operator directive (2026-07-03, topic 29723): 'spec review/converge teams always use the largest/strongest models and the proper doors — Fable 5, GPT-5.6 Sol-class, the Gemini equivalent — when available.'"
status: draft
author: Echo
date: 2026-07-03
risk-class: "additive-then-migrating — a door-availability probe + a currency-aware resolver are additive (a resolvable door still returns its strongest model exactly as today). The behavior-changing steps are (a) marking gemini-cli DEPRECATED so its external pass reports UNAVAILABLE instead of a false pass, and (b) flipping the spec-converge Fable-5 escalation from dark/dryRun to live — both guarded (Fable free-window aware; gemini reroute falls back to 'Gemini door unavailable', never a fabricated review)."
parent-principle: "Signal vs Authority (a hardcoded allowlist is a stale SIGNAL masquerading as AUTHORITY on 'what is strongest') + Intelligent Prompts / no-string-match (a reviewer door must resolve real availability, not assume a CLI that was retired) + Live-User-Channel-Proof-adjacent honesty (never report a cross-model pass that did not actually run) + operator directive 2026-07-03."
lessons-engaged:
  - "Model+door landscape drift is CONTINUOUS (memory model-door-landscape-2026-07): gemini-2.5-pro went ~2 major versions stale and gemini-cli was RETIRED (2026-06-18) between the map being written and this spec. A static allowlist cannot track 'strongest available' — the reviewer must resolve current reality (probe + a currency policy), or a fast-follow discipline must be structurally enforced, not left to memory."
  - "Ship-dark honesty (operator, topic 29723, 2026-07-03): the Fable-5 escalation for spec-converge is WIRED (tierEscalation frameworks.claude-code.escalated=claude-fable-5, trigger list includes spec-converge) but ships enabled:false+dryRun:true, so internal reviewers actually run on Opus 4.8. A capability that never graduates is a capability the agent does not have. This spec carries its own graduation criteria + a check that the free-window cost-guard date is current (the shipped guard reads 2026-06-22, already past)."
  - "Door availability != model availability: GPT-5.6 Sol was PREVIEWED (2026-06-26) but is GATED to ~20 orgs — 'strongest' and 'reachable-by-us' are different axes. The resolver must pick the strongest model that is BOTH current AND reachable on a door this agent is actually authed on, and record which axis excluded a stronger model (so 'why not Sol?' is answerable)."
  - "Never fabricate a pass (spec-converge cross-model honesty rules): the skill already loudly marks UNAVAILABLE/DEGRADED external passes. A retired door (gemini-cli) must resolve to UNAVAILABLE with the real reason + remediation (use Antigravity CLI `agy` or OpenRouter), NOT a silent skip that reads as a clean Gemini pass."
single-run-completable: false
---

# Spec-Review Model + Door Currency

**Status:** DRAFT
**Owner:** Echo
**Created:** 2026-07-03
**Goal Alignment:** Cross-cutting (spec-review quality) — enforces operator directive "converge always uses strongest models + proper doors"

## Problem

`/spec-converge` runs six internal Claude reviewers + one external cross-model pass PER available family (codex → GPT-tier, gemini → Gemini-tier). Each external reviewer already asks for the `capable` (strongest) tier. But three things break the operator's bar ("always strongest AVAILABLE, proper doors"):

1. **Static allowlists — no auto-adoption of new frontier models.** `capable` resolves through hardcoded `TIER_TO_MODEL` maps: codex `capable = gpt-5.5`, gemini `capable = gemini-2.5-pro`. When GPT-5.6 "Sol" / Gemini 3.5 Pro ship, `capable` does NOT point to them — a human must bump the map. Verified 2026-07-03: gemini-2.5-pro is ~2 major versions stale (Gemini 3.1 Pro is current, 3.5 Pro incoming).
2. **A DEAD door reported as a live one.** Google retired gemini-cli on 2026-06-18 (Pro/Ultra + free tier stopped serving); it is replaced by **Antigravity CLI** (`agy`, Go, closed-source). The current reviewer detection still treats gemini-cli as a valid Gemini door — so the Gemini external pass now silently fails/degrades, and a converge can read as "Gemini reviewed" when Gemini never ran. (Exception: gemini-cli still works via a paid Gemini Code Assist Standard/Enterprise or Google Cloud API key — a door this agent does not currently hold.)
3. **The strongest Claude model is not used for internal reviewers.** The Claude door's escalation target for spec-converge is Fable 5, but `models.tierEscalation` ships `enabled:false, dryRun:true`, so internal reviewers run on Opus 4.8. Additionally the cost-guard's Fable free-window date (`respectFreeWindows.claude-fable-5: 2026-06-22`) is already in the past.

## Design

Three components, each independently shippable.

### A. Currency-aware model resolution (per door)
Replace the static `capable → <pinned id>` with a resolver that returns the **strongest model that is BOTH current AND reachable on this agent's authed door**:
- A per-door **model-currency source** (ordered list of known frontier ids, newest-strongest first) that is cheap to update AND has an enforced fast-follow discipline (a lint/ratchet flags a map older than N days against a small published-model reference, so drift is loud, not silent).
- A **reachability filter**: a model that is gated/unauthed (e.g. GPT-5.6 Sol behind the ~20-org access list) is skipped, and the resolver records WHY the stronger model was excluded (`gated` / `not-authed` / `unknown`), so "why not Sol?" is answerable at review time.
- Fail-loud canary preserved: a tier word that falls through resolution still degrades with `model-resolution-canary` (never a dead reviewer).

### B. Door-availability probe (never claim a pass on a dead door)
- Mark **gemini-cli as DEPRECATED** in the reviewer framework registry: detection returns `unavailable` with reason `gemini-cli-retired-2026-06-18` + remediation `use Antigravity CLI (agy) or OpenRouter`, instead of a silent degrade that reads as a Gemini pass.
- Add **Antigravity CLI (`agy`) and/or OpenRouter** as the Gemini-door replacement adapter(s) in the extensible reviewer registry (`SUPPORTED_REVIEWER_FRAMEWORKS`), gated by the same trusted-provider allowlist rules (the full spec text is handed to the reviewer, so a custom/base-URL endpoint must be explicitly trusted — OpenRouter's trust posture is a frontloaded decision below).
- The convergence report's cross-model banner already distinguishes RAN / DEGRADED / UNAVAILABLE — this makes the Gemini row honest.

### C. Graduate the Fable-5 escalation for spec-review
- Flip `models.tierEscalation.enabled` for the `spec-converge` trigger from dark/dryRun to live, with the existing cost-guards (quota headroom, per-account concurrent cap, hourly budget, TTL + dwell) intact.
- Refresh the Fable free-window guard date to the CURRENT window (~2026-07-07) instead of the stale 2026-06-22.
- Fable-availability-aware: when Fable 5 is gated/credits-exhausted, internal reviewers fall back to the strongest available Claude model (Opus 4.8) with a recorded reason — never a hard block on review.

## Frontloaded Decisions
- **OpenRouter as a reviewer door:** OpenRouter is an aggregator with a custom base URL; the full spec text is handed to the reviewer. Per the existing trusted-provider rule (pi-cli is excluded for exactly this reason), OpenRouter is DENIED as a cross-model reviewer door BY DEFAULT and may only be enabled by explicit operator ratification (data-handling clearance). Antigravity CLI (`agy`, first-party Google OAuth) is the preferred Gemini-door replacement. (Aligns with the operator's earlier "first-party Anthropic + OpenAI only; aggregators excluded until approved" stance.)
- **Currency source of truth:** the per-door frontier list is maintained in-repo (not a live network fetch at review time — a reviewer must not depend on an external ranking service), with a fast-follow lint that flags staleness against a periodically-refreshed reference. A live web-research refresh is an operator/job cadence, not an inline review dependency.
- **Scope boundary vs the 29723 LLM-Pathway workstream:** this spec is SCOPED to spec-review reviewer routing ONLY. The general per-task tiered model/door selection ("operate on a mid model, defer to top-tier for heavy work") is the DISTINCT LLM Pathway Characterization workstream (topic 29723) and is NOT duplicated here — this spec is a consumer/component of that broader pathway's door registry once it exists. COORDINATE, do not duplicate.

## Open questions
*(none — the OpenRouter trust decision and the currency-source decision are frontloaded above.)*

## Test Plan
- **Unit:** currency resolver returns the newest-reachable model per door; a gated model (Sol) is skipped with a recorded reason; a retired door (gemini-cli) resolves to `unavailable` with the correct reason; the staleness lint fires on an out-of-date map.
- **Integration:** a converge run records an honest cross-model banner (codex RAN / gemini UNAVAILABLE-retired) and does not fabricate a Gemini pass; the Fable-5 escalation actuates for a spec-converge session when enabled + within quota, and falls back to Opus with a reason when Fable is gated.
- **E2E:** a full `/spec-converge` on a throwaway spec produces a convergence report whose model+door posture matches the machine's ACTUAL authed doors and current model availability (no stale id, no dead door claimed).

## Success Criteria
- No hardcoded frontier model id can silently go stale without the lint firing.
- A converge NEVER reports a cross-model pass on a door that did not actually run.
- With Fable 5 available, spec-review internal reviewers demonstrably run on Fable 5 (verifiable via per-feature/model token metrics `byModel`), not Opus.
- "Why did reviewer X use model Y (and not the stronger Z)?" is answerable from the convergence record for every door.

## Failure Modes
- Currency list itself goes stale → the fast-follow lint is the backstop (drift is loud).
- Antigravity CLI adoption slips → Gemini door stays honestly UNAVAILABLE (a missing outside opinion is disclosed, never faked).
- Fable free-window miscalc → escalation cost-guard refuses rather than over-spending; internal reviewers fall back to Opus with a reason.

## Autonomy Notes
- Drafted in the 29836 Multi-Machine+Slack autonomous run (iter 43) directly from the operator's 2026-07-03 directive + live web-verified model/door landscape. Convergence is deliberately DEFERRED until Fable 5 is available (~2026-07-07) so the converge that ratifies THIS spec itself meets the operator's "strongest models" bar — converging it today on Opus + a dead Gemini door would violate the very directive it encodes. Tracked under CMT-774.
