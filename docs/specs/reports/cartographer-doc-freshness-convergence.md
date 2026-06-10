# Convergence Report — Cartographer Doc-Freshness Enforcement (spec #2)

## ELI10 Overview

Spec #1 built a "map" of the codebase — every folder and file gets a short
plain-English note, plus a git fingerprint so the map can tell which notes have
drifted from the code. This spec (#2) is the part that actually keeps the notes
*written and up to date over time*, without becoming the kind of runaway
background process that has burned this project before (big AI bills, CPU
starvation, a feedback loop that tripped the global safety breaker 96 times a day).

It does that in three cheap tiers: (1) when an agent edits code it refreshes that
one note for free; (2) a quiet background "sweep" finds stale notes with a single
git command and re-writes only a few per run, using a small model routed **off the
main Claude account** so it never spends Claude quota; (3) a CI check that fails
only if overall freshness *drops*, never per-change nagging.

It ships **off by default**, behind two separate switches — one to enable it, and a
distinct one to acknowledge that turning it on sends your source code to an outside
model provider. The convergence review's job was to make sure that, before any code
is written, this design can't quietly cost you money, leak your code, or fill the
map with confident-but-wrong notes.

## Original vs Converged

The first draft was already careful, but review found that several of its central
*safety claims were not actually true against the real code it builds on* — the
most important kind of finding, because the spec "passes" while standing on a flaw.

- **"It never spends your Claude quota" was false.** The real model router
  *defaults to falling back to Claude* when the off-Claude model isn't set up. The
  original spec assumed the opposite. Converged: the sweep now runs a live check
  each cycle and **refuses to write anything** (rather than silently running on
  Claude) if it would land on Claude — across all three ways that misconfiguration
  can happen.
- **On two machines it would have done everything twice.** The background loop
  wasn't tied to the "which machine is in charge" lease, so an active-active setup
  would double both the AI bill and the amount of source code leaving your box.
  Converged: only the lease-holding machine does the writing.
- **"Fresh" overstated the truth.** A note matching the code's fingerprint was
  called "fresh," which reads like "correct" — but a plausible-but-wrong note is
  immortal until the code changes. Converged: "fresh" now explicitly means
  *fingerprint-current, not verified-correct*, the system surfaces a confidence
  signal, and it re-checks a small sample over time.
- **The quality check graded itself.** The validator was going to ask the same weak
  model "is this summary valid?" over the same attacker-influenceable input.
  Converged: the real check is now **deterministic** (does the summary name symbols
  that actually exist in the code?), with any AI opinion demoted to a side signal.
- **Summaries were an injection vector.** They're later read by a future navigator
  feature; a malicious file could steer a summary that then carries instructions.
  Converged: summaries are treated as untrusted *on output too* — quoted as data,
  never spliced into a prompt as instructions.
- **A green score could hide rot.** The freshness ratio ignored never-written and
  failed notes, so a small well-kept set could mask a large undocumented backlog.
  Converged: the CI floor now also tracks and fails on a *growing* backlog.
- **Egress was buried in a config doc.** Converged: a separate, explicit
  acknowledgement switch, plus a concrete secrets-exclusion list and a rule that
  only committed (never just-typed) content is ever read.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, lessons-aware | ~25 (incl. 2 critical: off-Claude-is-really-Claude; spec-#1-not-on-disk) | Full v2 rewrite: routing probe, lease-gating, deterministic validator, output-injection isolation, egress-ack gate, backlog metrics, foundation-contract section, per-tick spend cap, reentrancy guard, mid-tick CPU re-sample, on-node cross-tick state, eternal-sentinel re-escalation, generateClaudeMd pairing, getHostPressure-is-new |
| 2 | lessons-aware (1) | 1 (NEW-1: router method is `for()` not `preview()`; `available` hardcoded true on Claude-default) | Corrected the probe API + pinned the `IntelligenceRouter` contract; folded 3 non-material clarifications (re-validation budget, inline-fresh skip) |
| 3 | lessons-aware (1) | 1 (NEW-3: `fallback` is operator-global config, not a per-call `evaluate()` arg) | Corrected the binary-missing guard to the `for()` probe's `available===false`; reframed global `fallback:'none'` as a deployment precondition; reconciled all 3 locations |
| 4 | (converged) | 0 | none |

Security, scalability, adversarial, and integration all reached convergence at
iteration 2 (priors resolved, only non-material nits). Iterations 3–4 were driven
solely by the lessons-aware reviewer's source-level audit of the model-router API
the off-Claude guarantee depends on — each round caught one real mismatch between
the spec's described API and the actual `IntelligenceRouter`, and each was a
one-to-two-location documentation correction, not a design change.

## Full Findings Catalog (material findings)

**Iteration 1 (round 1) — ~25 material, by reviewer:**

- *Security:* egress secrets-exclusion under-specified/untested; no whole-repo
  egress volume/consent bound; injection isolation stops at the leaf (child
  summaries re-consumed un-isolated); validator self-grades on untrusted-influenced
  model; tier-1 write under-validated/sticky/no-rate-bound; off-Claude silent
  misroute-to-Claude; content read from working-tree not committed blob;
  encoded-traversal untested. → all addressed in v2 §Security, §Tier 1, §Tier 2.5/2.7/2.9.
- *Scalability:* missing tick reentrancy guard; node-count bound doesn't bound
  per-tick *spend*; `LlmAbortedError` preemption undefined; CPU sampled once per
  tick not mid-tick; cross-tick per-node state vs reset-each-tick cursor
  contradiction (risked losing the dir-amplification guard). → v2 Reentrancy,
  §Tier 2.3/2.8/2.10.
- *Adversarial:* dir child-digest lets a bad child certify ancestors fresh; "fresh"
  overstates authority (wrong-but-validated note immortal); self-grading validator;
  tier-1 verbatim+sticky; no injection-scrub of summary *output* (→ spec #5);
  CI ratchet gameable via trivial summaries / grace flooding. → v2 §Naming, §Tier 1,
  §Tier 2.9, §Security, §Tier 3.
- *Integration:* **CRITICAL** multi-machine N× egress/spend (poller not
  lease-gated); hard dependency on unmerged spec #1 (deploy-order coupling);
  CI ratchet never wired into a workflow + initial floor unspecified; CLAUDE.md
  block depends on spec #1's marker; `getHostPressure` extraction is new work
  touching SessionReaper; job-category registration silent-Claude-burn needs a
  guard test. → v2 §Tier 2 lease-gating, §Foundation contract + merge-order gate,
  §Tier 3 wiring, §Migration.
- *Lessons-aware:* **C1 CRITICAL** off-Claude "no silent degradation" invariant
  false against the live router; **C2 CRITICAL** spec #1 not on disk (every
  primitive an assumed contract, L3 risk); **H1** CI ratchet brittle blocking
  authority (P2); **H2** freshness ratio hides local rot; **H3** registration
  necessary-not-sufficient (3 silent paths); **M1** breaker notify-once-forever
  (P19 eternal-sentinel); **M2** tier-1 less-validated than sweep; **M3**
  getHostPressure extraction new. → all addressed in v2.

**Iteration 2 — 1 material:** NEW-1 — routing probe named `router.preview()`; the
real resolver is `router.for()` returning `{component, category, framework,
available}`, with `available` hardcoded `true` on a Claude-default resolve.
Resolution: corrected to `router.for()`, refusal tests the `framework` field, and
`IntelligenceRouter` pinned in the Foundation contract. (Security/scalability/
adversarial/integration reported only non-material nits — re-validation budget
accounting, inline re-author churn, `egressScope` enforcement point, deny-glob
residual — folded in as clarifications.)

**Iteration 3 — 1 material:** NEW-3 — the spec described `fallback:'none'` as a
per-call `evaluate()` argument; in source `fallback` is the operator-global
`componentFrameworks.fallback` read live via `resolveConfig()`, not settable
per-call. Resolution: the binary-missing path is guarded by the `for()` probe's
`available === false` (run each tick before egress); global `fallback:'none'`
reframed as a deployment precondition for the mid-tick-race window; all three
locations reconciled and verified byte-accurate against source.

**Iteration 4 — 0 material:** confirmed NEW-3 resolved on all sub-points,
internally consistent, byte-accurate to `IntelligenceRouter.ts` / `types.ts`.

## Convergence verdict

**Converged at iteration 4.** No material findings in the final round, verified
against live source. The spec is ready for user review and approval.

**Convergence method note:** this was an *abbreviated* convergence — the external
cross-model reviewers were skipped because the GPT/codex CLI is not installed on
the host and the Gemini CLI's API returned a transient invalid-content error. The
five internal reviewers (security, scalability, adversarial, integration, and the
mandatory lessons-aware pass) ran every round. The lessons-aware reviewer's
one-layer-below source audit is what carried iterations 2–4 — exactly the
circular-self-verify defense it exists to provide.

**Build precondition (carried forward):** the spec's Foundation-contract section
pins every assumed `CartographerTree` (spec #1) and `IntelligenceRouter` signature;
spec #2 must not merge before spec #1 (PR #1041) lands on `main`, and a defensive
test asserts the `cartographer` config key exists. Any signature drift discovered
at build is a fold-in, not a surprise.
