# Convergence Report — Unified Self-Action Backpressure Primitive (Increment B)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's own codex CLI on EVERY round (rounds 1–9), each a
clean `status: ok` run — this is the clean RAN state. Honest disclosure on the second family: gemini-cli
(gemini-2.5-pro) ran clean on rounds 1–5 (verdicts MINOR throughout, including "v4 corrections decisive"),
then DEGRADED on timeout on every attempt in rounds 6–9 as the spec grew past ~1300 lines (one retry per
round; recorded per-round, never papered over). The spec-level flag is the clean `codex-cli:gpt-5.5` under
the any-round-success rule — which codex satisfied on all nine rounds, and gemini satisfied through round 5.
No round ran without at least one genuine outside-the-Claude-family opinion.

## ELI10 Overview

Instar is good at checking "is this one action correct?" and had no check for "is the agent about to do
this same kind of action thousands of times in a row?" Every time the agent acts on *itself* — spawn a
helper, send a notice, restart a session, swap accounts, retry — that action was individually fine but had
no shared brake on *frequency* under pressure. Twenty separate runaway-loop incidents since April share
that one root. This spec builds the missing brake: one in-process chokepoint (`SelfActionGovernor`) that
every self-action passes through for permission before it fires, answering `allow` / `coalesce` / `queue`
— and it never silently drops work.

The hard part is the *relief* actions — killing a stuck process, recovering a dead run. You can't just
rate-limit those (blocking the thing that relieves pressure deadlocks the system), but you can't let them
run unbounded either (the real incident: a reaper firing 17,503 identical kills a day). The converged
design threads the needle: genuinely-effective relief gets its *speed limit* relaxed, but a hard *count*
ceiling always applies — scaled to the live population so a big legitimate cleanup fits while a runaway is
caught — and "the process died" is never mistaken for "it's actually fixed."

Nothing changes day-to-day while the machine is healthy: the brake ships watch-only and each action class
is switched to enforcing one at a time, by the operator, after its own soak. What changes permanently is
that the *next* self-action anyone builds inherits a bound by construction instead of earning one after
its own incident.

## Original vs Converged

Originally (v1), the design read the 5-entry test registry as live emit paths, made "fail open" the error
posture, returned a yes/no answer, and treated relief as a blanket never-denied lane. Nine rounds later,
the load-bearing differences:

- **The count ceiling is the load-bearing bound, and relief only ever gets RATE relief.** The
  effectiveness-gated bypass relaxes speed, never counts; ineffective relief (a kill that "succeeds" while
  its target respawns) is caught at the per-target ceiling by construction. The relief budget is
  census-scaled (a fraction of the live population, clamped by a hard constant) because no static number
  sits between "worst-case legitimate mass cleanup" and "flood."
- **A human action always wins — structurally, not rhetorically.** Operator actions ride a separate
  privileged lane that requires a genuinely human credential (dashboard PIN / verified sender / mandate —
  the server's internal Bearer token, which the agent itself holds, does NOT count), bypasses every
  ceiling, is exempt even from the broken-governor backstop, and is always audited with volume-anomaly
  paging. Reviewers caught — against deployed code — that the original wording would have let any
  Bearer-holder (including a runaway agent loop) stamp itself human, and that the emergency backstop
  would have paced the operator's own mass emergency-stop.
- **The brake survives what it guards against.** All admission state is durable with event-aware,
  leading-edge flushing (a crash-loop bouncing faster than any timer still ratchets the budget), defined
  loud dispositions for missing/corrupt state, and a process-global anchor so an accidentally double-loaded
  module graph cannot run two budgets.
- **The overflow queue got brakes of its own.** Both growth axes capped, drain re-validates the
  controller's own eligibility plus an incarnation fence (a queued kill can never fire on a healthy
  successor that reused the name), in-memory-by-design crash semantics with restart-shed honesty, and a
  defined terminal when even the enqueue fails.
- **Identity is bound, not claimed.** Controller identity — the policy/privilege selector — is
  authenticated end-to-end: per-controller handles minted once (process-global), a lint that scans handle
  *usage* codebase-wide, file↔controller binding, marker uniqueness, and sink-side identity pinning. The
  two unbounded lanes (`respawn-recovery`, `eternalSentinel`) are a closed allowlist whose members must
  name the external cap that owns their give-up, driven to its trip point by a fixture.
- **Reuse instead of rebuild.** v6 planned a standalone distributed lease store on the stated premise that
  no shippable primitive existed; round 5 re-grounded against the deployed dist and found the sum-of-leases
  modules had shipped two versions earlier — the plan became "compose the shipped modules behind a new
  wiring gate," with the honest correction (rounds 6/8) that they are pure-but-UNWIRED, that the shipped
  ledger itself never prunes (a bug we'd have inherited), and that exactly ONE issuer per account may exist
  regardless of which features are on.
- **Every notice the governor raises carries the Self-Heal-Before-Notify contract.** Six operator notices,
  each with dedupe-key, severity, latency ceiling, remediation, and audit row; transient self-healing
  episodes never ping the operator.
- **Honesty clauses throughout**: what the observe window does and doesn't bound (including the
  storming-green-field sub-case and its inverse nudge), what the PIN tier is and isn't, which valves are
  phone-completable, what a coordinated local-file deletion can still do, and which residuals are accepted
  by name.

## Iteration Summary

| Round | Panel | Material findings | Outcome |
|---|---|---|---|
| 1 | adversarial + scalability (initial grounding) | 4 CRITICAL + ~8 MAJOR | v2 grounding rewrite (registry misread, fail-open wrong, three-way Admission, controller-id keying) |
| 2 | 6 internal + codex(SERIOUS) + gemini(MINOR) | 3 CRITICAL + ~14 MAJOR | v3 (relief bypass redesign, non-convergence demoted, pool-shared gating) |
| 3 | 6 internal + codex(MINOR) + gemini(MINOR) | 1 CRITICAL + ~9 MAJOR | v4 (count ceiling = hard floor always; closed eligibility set) |
| 4 | 6 internal + codex(SERIOUS→fixed) + gemini(MINOR) | 1 real miss + ~8 MAJOR | v5 (FD2 fail-open drift; N=1 carve-out; target-granularity invariant) |
| 5 | 6 internal + codex(MINOR) + gemini(MINOR, last clean) | ~6 MAJOR groundings | v6 (guard-posture polarity, registered-count trigger, deriveTargetKey, lease handoff) |
| 6 | 6 internal + codex(MINOR) + gemini(timeout) | ~11 distinct MAJOR | v7 (Standards A/B new-lens + grounding drift: composed shipped lease modules, principal provenance, durable state, queue completion, census scaling) |
| 7 | 6 internal + codex(MINOR) + gemini(timeout) | 5 one-sentence-pin MAJORs | v8→v9 (principal exempt from errored path, floor non-overridable, leading-edge flush, demoted value source, unified posture) |
| 8 | 6 internal + codex(SERIOUS=meta repeats) + gemini(timeout) | 2 mechanism-pin MAJORs | v10 (codebase-wide handle-usage lint scan; process-global single-mint keying) |
| 9 | 6 internal + codex(SERIOUS=meta repeats) + gemini(timeout) | 0 material | **CONVERGED** (round-9 minors: 2 folded editorially, 8 enumerated as required companion clauses) |

Standards-Conformance Gate: ran every round (51 standards). Its recurring parent-principle flag was
grounded each round as a stale-local-registry false positive (the canonical registry names this spec as the
parent standard's follow-on increment); its two round-8 flags (No-Unbounded-Loops, Mobile-Complete) were
engaged and answered in-body. Decision-completeness converged five consecutive rounds; final tag counts:
frontloaded=15, cheap-tags=4, contested-cleared=4, contested-rejected=0. Internal reviewers ran on
claude-fable-5 for rounds 5–9 (D7 per-round-model disclosure); rounds 1–4 ran under the authoring session's
prior model per their in-spec provenance.

## Full Findings Catalog

The verbatim, per-finding catalog — every reviewer, every finding, severity, original text, and the exact
resolution taken — is retained IN the spec itself as its provenance sections, one per round:
`## Round-1 review findings` through `## Round-9 convergence-check findings` in
`docs/specs/unified-self-action-backpressure.md`. Approximately 120 distinct findings were folded across
nine rounds; every fold is tagged in-body with its finding id (e.g. `folds SEC6-2/ADV6-1`), so any
normative clause traces back to the finding that produced it, and each round's section records which prior
folds the panel re-verified as genuine (fold-verification was mandatory from round 6 on; grounding was
against the DEPLOYED dist v1.3.780 and the CANONICAL registry/principles index at JKHeadley/main — the
stale-local-copy trap having itself produced two false leads that rounds 5 and 6 caught and documented).

Reviewer-perspective totals across rounds 5–9 (the convergence-check phase of this skill run): security
3 MAJOR + 12 MINOR; scalability 3 MAJOR + 10 MINOR; adversarial 9 MAJOR + 9 MINOR; integration 7 MAJOR +
12 MINOR; lessons-aware 3 MAJOR + 9 MINOR; decision-completeness 0 MAJOR + 4 MINOR (converged every
round); codex 5 clean runs (new findings folded; recurring meta themes engaged in-body); gemini 1 clean
run + 4 timeouts (all recorded).

## Convergence verdict

Converged at iteration 9 (within the 10-iteration cap). All six internal reviewers CONVERGED on v10 with
zero material findings in the final round; the two final-round editorial minors were folded in place and
the remaining eight are enumerated in the spec's Status head as REQUIRED COMPANION CLAUSES for the
normative implementation companion (the implementation authority, produced with the build PR). Open
questions: zero. The spec is ready for user review and approval — `approved: true` remains the operator's
step after reading this report and the ELI16 overview, and building remains gated on both tags plus the
companion.
