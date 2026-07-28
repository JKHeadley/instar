# Convergence Report — Idle-Error Detection: Tail-Gated, Frame-Discriminated Signal (CMT-1785)

## Cross-model review: codex-cli:gpt-5.5

Real external (non-Claude) review ran on EVERY round and succeeded: GPT-tier (codex-cli,
gpt-5.5) AND Gemini-tier (gemini-cli, gemini-2.5-pro), via the agent's own CLI logins. Final
round both returned **MINOR ISSUES** with no material findings. This is the clean RAN state.

## ELI10 Overview

When one of the agent's sessions goes quiet at its prompt, the system tries to guess *why* — if
it stalled on a temporary API error, a recovery helper nudges it back to life instead of waiting
15 minutes to kill it. The old guess was a blunt text search: "does an error word appear anywhere
in the last chunk of the screen?" That fired on errors that had already scrolled by, and on the
agent merely *talking about* an error — kicking off needless recovery on healthy sessions.

This change makes the guess precise: the error word now has to be in the live region right above
the prompt AND on a line the tool actually emitted as an error (led by the tool's own bullet
marker, or carrying the "API Error" frame), not just mentioned in passing. The recovery helper it
feeds does nothing destructive — at most a gentle nudge it then re-checks — so even a wrong guess
is cheap, and the change can only make the trigger *pickier*, never more trigger-happy.

The tradeoff: being pickier means a genuinely-broken session could occasionally be missed and fall
back to the slower 15-minute safety net. The design fights that head-on (it widened how much of the
screen it reads after a real-bytes test proved the error gets pushed up by the input box, and it
emits a record every time it suppresses, so a wave of real misses becomes visible) and the one-line
revert is the immediate operator lever if a future Claude UI change ever fools it.

## Original vs Converged

The original spec was a reasonable sketch that **would have shipped a net-negative feature**. Five
review rounds turned it into something correct:

- **It would have under-fired on the MOST COMMON real error.** The first design matched lines that
  *begin with* the error token — but real Claude errors render as `⏺ API Error:` / `  ⎿  API Error:`
  (glyph-prefixed), and the test corpus used bare strings that never occur. The converged design
  defines an exact glyph-strip rule and pins tests to the REAL captured fixtures already in the repo.
- **It read too little of the screen.** "Keep capture at 30 rows" was wrong: the repo's own
  rate-limit detector already learned (a 2026-05-30 incident) that Claude's input box renders 15-25
  rows *below* the error, pushing it out of a small window — which is why that detector reads 45 rows.
  The converged spec matches that 45-row budget.
- **It overclaimed a safety contract that didn't exist.** The draft said the recovery actuator
  "verifies before respawn." The actuator never respawns — it nudges, verifies, and at worst sends a
  notice. The corrected account is both honest and *stronger* (nothing destructive happens at all).
- **It would have re-logged every 5 seconds, leaked memory, and copied fragile logic three times.**
  Review caught a per-tick log storm, a session-death memory leak, and that the shared tail helper was
  being copied rather than extracted. All fixed.
- **It mis-cited its own governing principle** ("An LLM Gate Must Not String-Match" — which doesn't
  apply; there's no LLM gate here). Reframed correctly under Signal-vs-Authority: the string list is a
  *permitted signal*, and this is a precision improvement, not a de-brittling of an authority.

## Iteration Summary

| Iteration | Reviewers (internal / external / gate) | Material findings | Spec changes |
|-----------|----------------------------------------|-------------------|--------------|
| 1 | 6 internal (security, scalability, adversarial, integration, decision-completeness, lessons-aware) + codex + gemini + Standards-Conformance Gate | ~14 | Full rewrite: glyph-aware frame discriminator, tail 8→15 + whole-window scan, shared `liveTail` extraction, foundation-honesty §4, structured counters, principle reframe, multi-machine wording |
| 2 | codex + gemini + Standards-Conformance Gate (externals mandatory, body changed) | 4 | Two-tier BEGINS-WITH grammar (fixed a self-contradiction); E2E test added; parser-realness engaged; `tracked-followups` populated; guardian-canary tracked |
| 3 | 4 internal (adversarial, lessons-aware, decision-completeness, security+integration) + codex + gemini + Gate | 4 | Capture 30→45 (input-box chrome); §4 rewritten (no respawn); `liveTail` return contract + characterization test; `idleErrorClassified` cleared on session-death path |
| 4 (converged) | internal convergence-verifier (code-grounded) + codex + gemini + Gate | 0 material | none — codex/gemini returned non-material refinements already engaged; verifier returned [] |

**Standards-Conformance Gate:** ran every round. Round 2 flagged 3 (Testing-Integrity E2E-N/A,
Scrape/Parser-Fixture-Realness, No-Deferrals/empty-tracked-followups) — all resolved by round 3
(0 non-ok at rounds 3 and 4). **Process honesty:** round 2 ran external + gate only (no internal
panel); round 3 ran a focused 4-reviewer internal set (the six perspectives collapsed to four
agents — security+integration combined); the lessons-aware and decision-completeness reviewers ran
in every internal round (the non-skippable pair). The cross-model external pass ran and SUCCEEDED on
all four rounds (never degraded, never unavailable).

## Full Findings Catalog

**Iteration 1 (material, all resolved):**
- CRITICAL (adversarial): real error lines are glyph-prefixed (`⏺`/`⎿`); begins-with + bare-string
  tests would under-fire the commonest form → exact glyph-strip rule + real-fixture corpus.
- HIGH (adversarial): tail=8 exhausted by post-error render → raised to 15 + whole-window scan.
- HIGH (adversarial/security/codex): structured codes appear in benign content (incl. this repo's own
  source) → uniform frame discrimination, no blanket match-anywhere.
- HIGH (lessons): `liveTail` copied not extracted (3 divergent copies) → shared `paneTail.ts`.
- HIGH (decision-completeness): strictness table 2/11 patterns unmapped → exhaustive grammar.
- HIGH (lessons): recovery authority never audited → §4 foundation-honesty subsection.
- MEDIUM (lessons): parent-principle misattributed → reframed under Signal-vs-Authority.
- MEDIUM (security/integration/decision-completeness): per-tick suppression log storm → once-per-episode.
- MEDIUM (adversarial/codex): under-fire strands autonomous runs → first-class cost + canary.
- MEDIUM (lessons P18): no canary/drift artifact → structured counters + drift test.
- LOW: ANSI-vs-glyph framing, multi-machine wording, "non-empty line" undefined → all clarified.

**Iteration 2 (material, all resolved):**
- MEDIUM (codex): frame grammar "contains API Error/Error:" self-contradicted the suppress-prose test
  → precise two-tier BEGINS-WITH grammar.
- Gate: Testing-Integrity (E2E N/A) → real e2e lifecycle test added. Scrape/Parser-Fixture-Realness →
  engaged explicitly (real captured fixtures). No-Deferrals (empty `tracked-followups`) → populated.
- MEDIUM (gemini): canary depends on out-of-scope guardian → made a tracked high-priority follow-up.

**Iteration 3 (material, all resolved):**
- HIGH (adversarial): 30 PHYSICAL-row capture < the 15-25 rows of input-box chrome above the prompt
  (repo's own 45-row precedent) → capture raised to `RATE_LIMIT_SETTLED_CAPTURE_LINES` (45) + chrome test.
- HIGH (lessons/security): §4 overclaimed "verify-before-respawn" — actuator never respawns → rewritten
  to the accurate (and stronger) nudge→verify→notice + zombie-kill-veto account; Decision-points + ELI16
  corrected.
- MEDIUM (lessons/decision-completeness): shared `liveTail` return type (`string[]` vs existing `string`)
  breaks "no behavior change" → explicit `.join('\n')` migration + characterization test.
- MEDIUM (security/integration): `idleErrorClassified` leaks on session-death path → cleared in BOTH the
  re-arm block AND `sessionComplete` (full `errorNudgedSessions` lifecycle parity).

**Iteration 4 (non-material, engaged — convergence):**
- codex: Tier-B "ownership" honesty (already covered by the accepted-residual note); canary-alerting first
  deploy (bounded-exposure + revert lever stated); `stripLineLead` export caution.
- gemini: high-complexity/brittle-integration (the systemic concern, acknowledged + `tracked-followups` (3)).
- internal verifier: [] — all four iteration-3 fixes verified consistent and grounded in the real code
  (RateLimitSentinel has no respawn; 45-row precedent; `liveTail` returns string; sessionComplete@L743).

## Convergence verdict

**Converged at iteration 4.** No material findings in the final round; both external families ran and
succeeded every round; the Standards-Conformance Gate is 0 non-ok; `## Open questions` is `*(none)*`.
The spec is ready for approval and build. The convergence process changed the design materially — most
importantly, it prevented shipping a feature that would have under-fired on the most common real error
form (a net-negative for the very liveness it set out to protect).
