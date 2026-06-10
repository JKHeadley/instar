# Convergence Report — Model-Tier Escalation Policy

**Spec:** `docs/specs/FABLE-MODEL-ESCALATION-SPEC.md` · **ELI16:** `docs/specs/model-tier-escalation.eli16.md`
**Author:** Echo · **Converged:** 2026-06-09 · **Iterations:** 4

## ELI10 Overview

We got access to a new, much smarter (and ~2x more expensive) Claude model, **Fable 5**. A live
test proved it only beats our normal model (**Opus 4.8**) on genuinely hard, long, big-codebase
work — on everything else they tie, so paying double is wasted. This spec is the machinery that
**automatically** uses the expensive model only when the work is actually hard (designing a
spec/project, or running a long build/autonomous job) and otherwise stays on the cheap model —
swapping back on its own for normal conversation. It's built into hooks so the agent never has to
"remember" to do it, and it's **framework-agnostic**: Codex, Gemini, and Pi plug in the same way
the day they ship their own ultra models, and are completely unaffected until then.

The whole design is about spending the 2x **only where it helps, never by accident** — so most of
the spec is guardrails: spend caps, a limit on how many sessions can use the expensive model at
once, a stay-inside-your-subscription-billing rule (no surprise pay-per-use bills), and operator
alerts. It ships **off for the fleet, on for the dev agents** (so we dogfood it), behind a dry-run
and a live-proof gate.

## Original vs Converged (what review actually changed)

The original spec rested on three mechanisms that **don't exist in the codebase** — review caught
all three before a line of code was written:

1. **"Just launch the session on the expensive model."** The interactive Claude launcher silently
   ignores the model flag (only the headless/codex launchers honor it). → The build now has an
   explicit, named code change to fix that, and launch-time escalation became the **primary,
   robust** path (which also dissolved a whole class of "how do we switch back?" problems — a
   launched build session just *ends* when done).

2. **"A hook swaps the model mid-conversation."** Hooks can't do that — they emit text, they don't
   drive the session. → Mid-session swapping was narrowed to one case (designing a spec inside a
   live chat), moved to a real **server-side endpoint** with auth, and wrapped in a **verify-it-
   actually-worked** check that falls back to the safe model if it can't confirm — and won't be
   turned on at all until proven live.

3. **"Check the session's model to confirm the swap."** The status API reports the model a session
   was *launched* with, never the live one. → The spec now requires tracking the live model
   honestly, and explicitly flags that the independent "read the real current model" capability
   has to be *established and proven* (it may not exist), degrading to launch-time-only if not.

Review also added the safety spine the original lacked: a **subscription-billing-only** invariant
(the cost-doubling feature can never wander onto a pay-per-token API), **fail-closed-to-cheap**
everywhere, **crash-safe** spend leases (a dead session can't permanently wedge the budget),
**anti-flapping** (no rapid expensive/cheap thrashing), **once-per-episode** spend counting, a
**dedup-keyed** operator alert when a long run blows its cap, and the **no-dark-ship-on-dev-agents**
rule (it ships enabled on Echo/Codey, gated behind the live-proof).

## Iteration Summary

| Round | Reviewers who flagged | Material findings | Spec changes |
|-------|----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, lessons-aware (5 internal; externals attempted, unavailable) | ~30 (incl. 6 CRITICAL "mechanism-does-not-exist") | Full re-architecture → launch-time primary, server-side narrow swap, security hardening, subscription invariant, de-escalation rework |
| 2 | security, adversarial, integration | ~8 new (lease release, canary oracle, accounting, daily-cap-on-long-run, build target, knownModelIds, `:name`, audit) — scalability **converged**; lessons content-converged | Lease crash-safety, accounting-fails-toward-counting, mid-run cap monitor, build-target note, §5.2 change list, ELI16 companion added |
| 3 | adversarial, integration | 4 new (count-once-per-episode, Attention dedup, capture-pane oracle not asserted, reap-log build-target) — security + lessons + scalability **converged** | Once-per-episode counting, dedup-keyed alert, oracle deferred to canary, build-target reap-log note |
| 4 | (none) | **0** — adversarial + integration **converged** | none |

## Full Findings Catalog (by round, condensed)

**Round 1 — CRITICAL:** claude interactive launcher ignores `--model` (Int-C1); `UserPromptSubmit`
hook cannot run a `/model` swap (Int-C2); `GET /sessions` reports launch model, never live (Int-C3);
subscription-billing-envelope invariant never engaged (Less-C1); de-escalation keyed on events that
never fire during long autonomous runs (Adv-C1); model-id → tmux send-keys with no validation =
keystroke injection (Sec-F1). **Round 1 — HIGH:** mode-state untrusted write surface (Sec-F2/F3);
prompt-injection cost-DoS via LLM intent check (Sec-F4); swap-endpoint auth unspecified (Sec-F5);
TTL re-arms without clearing cause (Adv-C2); stuck flag on hard session death (Adv-H1); concurrent
double-spend TOCTOU (Adv-H2); quota fail-open (Adv-H3); "in /autonomous" ≠ hard work (Adv-H4); silent
down-swap failure (Adv-H5); LLM check on hot path / unbounded latency (Scal-C1/H2, Less-H3); cold-
cache flap at 2x (Scal-H3/H4); no-dark-ship-on-dev-agents (Less-H1); config-clobber guard (Less-H2);
multisession key collision (Less-H4); frameworkDefaultModels type (Int-H1); multi-machine state
(Int-H2); no skill-exit event (Int-H3/Less-C2). **Resolved:** launch-time-primary pivot + §5.1
closed-enum/regex + §5.3 server endpoint + §7 subscription invariant + §5.4 re-derive-live + §6 hot-
path budget + §10 migration/dev-enable + full §12 map.

**Round 2 — new:** lease lacks release/expiry → crash deadlock (Sec-N3/Adv-NEW-1); canary oracle
unspecified (Sec-N2); canary-fail accounting dodges budget (Adv-NEW-2); daily cap doesn't bind a
launched multi-day run (Adv-NEW-3); build cites v1.3.x-only components from a v1.2.62 checkout
(Int-NEW-1); knownModelIds net-new, absent from change list (Int-NEW-2); `:name` validation (Sec-N1);
live-input collision (Sec-F6); audit hygiene (Sec-F7); ELI16 companion missing (Less, hard blocker).
**Resolved in v3:** crash-safe lease, independent oracle, fail-toward-counting, mid-run BurnDetector
monitor, build-target note, §5.2(c), ELI16 written (3,701 chars).

**Round 3 — new:** count-once-per-episode to prevent budget drain via retries (Adv-NEW-5); Attention
item needs dedup key (Adv-NEW-7); spend continues until operator acts — disclose (Adv-NEW-6); capture-
pane "model badge" parse not verified-feasible, defer to canary (Int-NEW-1); reap-log close event is
v1.3.x-only (Int-NEW-3); BurnDetector lacks per-session ultra-token / cap-crossing today (Int-NEW-2).
**Resolved in v4:** all six (§5.3, §8, build-target note).

**Round 4:** zero new material findings. Converged.

## External cross-model round — waiver (recorded per /spec-converge)

The external GPT/Gemini/Grok round was **attempted, not skipped**: Gemini returned HTTP 429
`MODEL_CAPACITY_EXHAUSTED` (Google-side capacity), and the codex/grok CLIs are not installed on this
machine. Per the skill's abbreviated-convergence clause, externals may be waived when unavailable
**provided the lessons-aware pass runs** — it ran all four rounds (the primary anti-circular check,
since the author ran convergence). This waiver is recorded here as the condition of acceptance.

## Convergence verdict

**Converged at iteration 4.** No material findings in the final round. All five internal review
perspectives (security, scalability, adversarial, integration, lessons-aware) reached zero-new-
material-findings; the ELI16 companion is present (3,701 chars); the external round is a documented
waiver. The spec is ready for **user review and approval**. Per process, the `approved: true` tag is
the operator's step — nothing builds until Justin approves the converged spec.
