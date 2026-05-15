# Convergence Report — Token-Burn Detection and Auto-Heal

**Spec**: `docs/specs/token-burn-detection-and-self-heal.md`
**ELI16 Companion**: `docs/specs/token-burn-detection-and-self-heal.eli16.md`
**Date**: 2026-05-15
**Convergence status**: iteration 1 complete; iteration-2 internal review pending; **external cross-model reviewers (GPT / Gemini / Grok) deferred** to Justin's pre-implementation review window.
**Final approval gate**: Justin's `approved: true` tag in the spec's frontmatter.

---

## ELI10 Overview

We're building a watcher inside every instar agent that catches the kind of bug we caught manually today — a single piece of the agent quietly burning a huge share of the token budget — and reacts to it without needing the user to notice the bill.

The watcher does five things:
1. Notices when one specific code path is eating an outsized share of the budget.
2. Sends a Telegram message to the user explaining what's happening and what it'll cost if untouched.
3. (Where it's safe to do so) automatically slows that path down so the bleeding stops while the user reads the message.
4. After a few minutes, double-checks that the slowdown actually worked.
5. Sends a follow-up message — "I caught it, I slowed it, here's the before-and-after" — so the user gets confirmation, not another bill.

The tradeoff is the usual one: act too aggressively and you slow down something legitimate; act too cautiously and you miss the bleed. We bias toward caution — auto-slow only kicks in for code paths the system already knows about (instar's own jobs, scheduled tasks, and known sentinels). Anything unfamiliar — a hook a user installed, an extension nobody on the instar team wrote — gets an alert but no automatic slowdown, because the agent doesn't know what it's doing yet and doesn't get to silently strangle work the user might have wanted.

The user is the final gate on every irreversible decision. The watcher can slow things; only the user can permanently disable a code path.

## Original vs Converged

The first draft of this spec had a simpler shape: detector emits a signal → an "intelligent gate" decides → throttle fires → alert sent. The four-reviewer audit (security, scalability/performance, adversarial, integration) found ~100 issues, of which ~14 were CRITICAL or HIGH. The major shape changes from the audit:

**1. We no longer add a new "blocking gate" layer.** The first draft proposed a Phase-6 "universal IntelligenceProvider gate" that would consult the BurnDetector's threshold-cross signal before letting any LLM call through. Reviewers correctly flagged this as a signal-vs-authority violation — the BurnDetector is a brittle threshold, and brittle thresholds are forbidden from holding blocking authority. The converged spec routes everything through the existing Remediator V2 dispatch (which already has signed context, audit log, trust elevation, capability HMAC). No new authority surface is created; the detector emits, the existing authority decides.

**2. The Telegram buttons are now principal-bound.** The first draft assumed "the user taps a button → the action happens." Reviewers pointed out: anyone in any Telegram chat the bot is in could tap the button. The converged spec signs the button's data with the agent's capability key over `(action, attributionKey, signalId, principal)`, verifies the tapper's user_id is in the authorized list, and checks the signal-id is fresh (no replays).

**3. The config and override files are now signed.** The first draft wrote throttle decisions to `.instar/jobs.json.throttle-overrides` as plain JSON, and let the config be edited by anyone with file access. Reviewers flagged: if anything else on the box can write to those files, anyone can fabricate throttles or disable detection entirely. The converged spec signs every throttle-override entry with the capability key, and routes config edits through a principal-authorized API path.

**4. The phases land in a different order.** The first draft built detector first, throttle primitive last. Reviewers pointed out: this creates a regression window where the detector emits signals but nothing exists to act on them, AND a chokepoint refactor is the riskiest piece of work and therefore should land first when nothing else depends on it being right. The converged spec ships the chokepoint + actuator first, then the detector, then the runbook.

**5. The data model now has an attribution_key column.** The first draft left attribution as a computed thing the detector figured out on-the-fly. Reviewers pointed out: computing it after the fact loses the source-side context (which component made the call) and requires the detector to walk every event repeatedly. The converged spec writes attribution_key on every TokenLedger write, with an index, and backfills legacy events once at init.

**6. The cold-start case is now handled.** The first draft assumed a 7-day baseline existed. It doesn't, on day 1 of any agent. The converged spec runs absolute-share-only for the first 7 days while the baseline collects.

**7. The bypass paths are explicitly closed.** The first draft assumed every LLM call flows through `IntelligenceProvider`. Reviewers pointed out: raw HTTP and direct Anthropic SDK use can bypass it. The converged spec adds a lint rule blocking raw-HTTP-to-LLM, AND treats unattributable spend (telemetry without a known key) as an alert-only signal — observable even if not throttleable.

**8. The self-reinforcing-loop trap is closed.** Reviewers asked: what if the runbook's own LLM call to generate the alert message gets attributed to the offender and throttled? The converged spec tags runbook-internal LLM calls with an exempt attribution key, bounded to N=1 per signal.

Everything else from the original draft (motivating incident, goal, attribution-key shape, threshold defaults, verification, narrative-tone Telegram messages, opt-in shape) survived review with only minor wording changes.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Status |
|-----------|--------------|-------------------|--------|
| 1 | security, scalability/performance, adversarial, integration | ~100 total (~14 CRITICAL/HIGH) | Addressed in rewrite |
| 2 | (pending — see below) | TBD | Pending |
| External (GPT/Gemini/Grok) | Deferred | TBD | Justin's pre-implementation review window |

The spec-converge skill's design intent is to iterate internally until convergence (no material new findings in a round). For this spec, iteration 2 is held pending Justin's review of the iteration-1 rewrite — the practical reason being that this spec proposes a sizable architectural change (chokepoint refactor + new Remediator runbook + data-model change + capability-HMAC additions) and Justin's "is this the right shape at all?" decision dominates any further reviewer churn. Iteration 2 + external cross-model review will run after Justin's first-pass feedback.

## Convergence verdict

**Iteration 1 complete; further iteration deferred to post-approval review.** The four iteration-1 reviewers found substantive structural issues; all CRITICAL and HIGH findings have been resolved in the rewrite. The spec is ready for Justin's review.

**No code lands until `approved: true` is in the spec's frontmatter.** The `/instar-dev` pre-commit gate enforces this structurally — without that tag, no Phase 1 work can be committed to the instar repo.

## How to Use This Report

Justin's path:
1. Read the ELI16 companion first (short, plain-English, ~6 KB).
2. Read this report's "Original vs Converged" section for what changed in the audit.
3. Read the full spec if anything in the above raised a question.
4. Either tag the spec `approved: true` in its frontmatter (which I will do on your instruction; you do not have to edit the file yourself), or send the specific concern via Telegram for another iteration.

If you (Justin) prefer the external cross-model pass (GPT / Gemini / Grok) before approval, say so — that's a real ~1-hour additional check that I deferred to fit the autonomous window, and re-running it is a single command.
