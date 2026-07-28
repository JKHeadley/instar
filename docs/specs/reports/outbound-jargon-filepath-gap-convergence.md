# Convergence Report — Outbound gate: close the jargon + raw-file-path gaps

*Spec: `docs/specs/outbound-jargon-filepath-gap.md` · slug `outbound-jargon-filepath-gap` · author
echo · tracked as ACT-749 · converged 2026-06-10 over 3 review rounds.*

## ELI10 Overview

This morning a background reminder reached you that broke two of your rules: it used developer
jargon, and it pasted a raw file path you can't click instead of a real link. You asked for a
structural fix, not a promise.

The surprising thing I found: a guard already checks every message I send you, and it already
knows how to block raw file paths and flag jargon. So the real question was "why did this slip
past the guard that should have caught it?" — and the answer turned out to be deeper than two
small holes.

The root cause: the system couldn't tell an *automated* message (a background reminder/alert) from
a *conversation* with you. Both were judged by the same lenient bar — the bar that (correctly) lets
me talk about technical internals when we're chatting. So a background alert got the chatty bar
instead of a strict one. The fix makes that distinction structural: the scheduler automatically
stamps "this is automated" onto every background-job message at the moment the job starts — the
background model does nothing and can't forget. Then automated messages get the strict bar
(jargon flagged, raw paths blocked with an "publish a link / describe it" message), while my normal
conversation with you keeps the smart, lenient judgment so I never over-block my own legitimate
messages.

## Original vs Converged (what the review changed)

My first draft had a genuinely weak core that a five-reviewer round tore into — correctly:

1. **It relied on the background job *remembering* to label itself "automated."** That's the exact
   willpower trap that caused the problem (the same model that ignored the rules wouldn't reliably
   remember to label itself either). The converged spec makes the label structural — stamped into
   the job's environment by the scheduler, not typed by the model.

2. **It claimed a safety property that was factually false.** I said the deterministic backstop
   would run "even when the message-gate is bypassed." A reviewer checked the code and showed the
   existing backstop it was modeled on is *itself* skipped in those bypass cases. The converged spec
   states the truth and honestly names what is and isn't covered (and adds a visible breadcrumb so a
   silent regression can't hide).

3. **It invented a message category that didn't exist** and assumed a rule would treat it strictly —
   but no such rule existed. The converged spec actually threads the new category through every place
   it must live and extends the real jargon rule to cover it.

4. **It under-specified the safety details** (a path-matching pattern that could hang the server, an
   error path that could crash and drop a message, a way a secret next to a path could leak into
   logs). The converged spec pins all of these down with concrete, tested requirements.

5. **It missed migration paths** (the script-update mechanism wouldn't actually reach existing
   agents; a second place jobs are launched; a fallback in the script that would silently drop the
   label). All now fixed and named.

The honest scope change: this grew from "patch two holes" into "make the automated-vs-conversation
distinction structural." That's larger, but it's the only version that actually closes the
incident — which is why it's flagged for your explicit confirmation (Open Question 2).

## Iteration Summary

| Round | Reviewers | Outcome |
|-------|-----------|---------|
| 1 | security, adversarial, scalability, integration, lessons-aware (5 internal) | major redesign: willpower-kind → structural; ~5 distinct must-fix classes |
| 2 | all 4 must-fix reviewers re-run on the rewrite | lessons + integration CONVERGED; adversarial + scalability NOT-CONVERGED with explicit named conditions (both body-builders, second spawn lane, relay-forward, raw-curl residual) |
| 3 | adversarial, scalability (confirmation) | both CONVERGED — 0 new material findings |

## Full Findings Catalog (condensed)

**Round 1 (initial):**
- CRITICAL (adversarial, lessons) — the `messageKind:'automated'` label was model-declared willpower; `INSTAR_JOB_SLUG` read but never set. → structural scheduler env injection.
- HIGH (lessons) — the localhost-guard precedent is NOT bypass-proof (factually wrong claim). → honest §2.4 + named residual.
- MEDIUM (integration, lessons) — `automated` enum + consuming rule don't exist. → thread the union (4 sites) + extend B12.
- MEDIUM (security, scalability) — `detectRawFilePath` ReDoS/over-broad-match/leak + the floor could 500 the route. → pinned linear regex + indexOf prescreen + URL-exclusion + bounded match + fail-OPEN floor.
- HIGH (integration) — telegram-reply.sh SHA allowlist missing the live SHA; jargon scope; config home. → concrete §5.
- (lessons) — re-justify the deterministic floor by cost-asymmetry, not "no legitimate reading"; scope jargon to non-reply.

**Round 2 (verify the rewrite):** security/lessons/integration CONVERGED; adversarial (raw-curl evasion overstates "model-proof"; wrong `:1452` cite) + scalability (python-fallback body-builder drops kind; relay-hop must forward kind) NOT-CONVERGED with explicit conditions; lessons also caught the second spawn env lane (rerouted-interactive / subscription-path).

**Round 3 (targeted edits + confirmation):** all conditions met — both body builders, both spawn env blocks, relay-forward, raw-curl residual + breadcrumb, B2/B12 precision, SHA precision, `:8286` cleanup. Adversarial + scalability re-confirmed CONVERGED, 0 new material.

## Cross-model (external) reviewer posture

`skipped-abbreviated` — full internal panel (security, adversarial, scalability, integration, and
the mandatory lessons-aware pass) across three rounds; external GPT/Gemini/Grok skipped per the
abbreviated path for a focused single-subsystem change. The lessons-aware + adversarial passes
caught the load-bearing findings (the willpower trap and the false bypass-proof claim).

## Convergence verdict

**Converged at iteration 3.** No material findings in the final confirmation round. The design is
sound and honest: the automated bar is structural (scheduler-injected, model-proof on the mandated
relay path), the one deterministic block is scoped to automated kinds and justified by
cost-asymmetry, the conversational path stays soft (over-block avoidance), and the residuals
(raw-curl, proxy/system-template) are named, not hidden. Ready for user review and `approved: true`.
