# Convergence Report — Topic Profile (sticky per-topic framework / model / thinking-mode)

**Spec:** `docs/specs/TOPIC-PROFILE-SPEC.md` · **ELI16 companion:** `docs/specs/TOPIC-PROFILE-SPEC.eli16.md`
**Converged:** 2026-06-11, round 16 · **Author:** Echo

## ELI10 Overview

Today, when you talk to me in a Telegram topic, which AI brain answers you (Claude or Codex), which
model size, and how hard it "thinks" are mostly decided by global settings — and if you want one
particular conversation to behave differently, that wish doesn't stick. This spec gives every topic
a **profile**: you say "use Codex here" or "make this topic think harder," and that choice is saved,
survives restarts and machine moves, and stays until you change it.

The hard parts the review process spent sixteen rounds on are the honest edges: switching brains
mid-conversation can lose context (so the spec is explicit about exactly when a change is lossless
vs. loses recent history, and it tells you instead of pretending); a settings change that arrives
while the topic is busy must not silently kill in-progress work; a profile that consistently fails
to launch must not strand the topic (a circuit breaker reverts to the last working settings and
keeps your parked wish recoverable); and every change must be attributed (who asked), announced
(you see what changed), and undoable in one word.

The main tradeoffs: the feature ships dark on the fleet and live on me (the dev agent) behind a
dry-run canary, so the riskiest machinery is watched against real traffic before it takes the
controls; and the existing `/route` command keeps working everywhere exactly as today — the new
machinery only takes over after the canary passes.

## Original vs Converged

- **Originally**, the spec claimed a "verified operator" security guarantee. Review showed the
  platform's binding is "last authorized sender wins," which can't deliver that — the converged
  spec states the real protection honestly: attribution + audit + disclosure + undo for authorized
  users, hard refusal only for unauthorized ones.
- **Originally**, health signals (canary drift, swap failures) raised attention items — the exact
  alert-flood pattern the operator rejected on 2026-06-10. The converged spec routes every health
  signal to silent maturation-track metrics with fix-vs-report heuristics, and migrates FABLE's
  existing noisy alerts as an in-scope sub-task.
- **Originally**, dry-run and the dark flag were two loosely-described knobs. Three full rounds
  (10–12) were spent discovering and fixing the ways they interacted: the shipped `/route` command
  would have silently broken under the dry-run flag; the spec simultaneously promised "never a
  silent mid-work kill" and routed both shipped configs through a legacy path that kills busy
  sessions (now scoped honestly); and the dry-run shadow's lifecycle across the canary flip was
  unspecified (now pinned: shadow intents are never auto-promoted, ever).
- **Originally**, the undo snapshot shifted on every write. A chain of findings (R7-4, R9-1, R10-2,
  R14-2) converged on one invariant: **undo always restores what the operator last saw disclosed** —
  through coalescing windows, rate-cap overflows, no-change transfers, and shadow-only transfers.
- **Originally**, the config block prescribed a literal `enabled: false` — a shape the dev-agent
  dark-gate lint (PR #1056, merged mid-convergence) structurally refuses. The converged spec
  registers the feature in `DEV_GATED_FEATURES` and lets the gate resolve dark-on-fleet/live-on-dev.
- **Five design forks** were resolved: tier-escalation interaction (Justin, 2026-06-10: a baseline
  pin never disables the heavy-work mandate) and four by Echo under Justin's standing autonomy
  directive (2026-06-11): local-model store stays adjacent this release; the CodexResumeMap capture
  ships as a prerequisite sub-task so both frameworks are zero-loss from day one; thinking-mode is
  a 5-level enum; busy framework switches refuse-until-idle with a "switch now" override.

## Iteration Summary

| Round | External | Material findings | Theme |
|-------|----------|-------------------|-------|
| 1 | yes | 27 | Initial multi-angle audit (operator-binding honesty, store design, swap matrix) |
| 2 | yes | 24 | Mechanism gaps (multi-machine, locking, resume maps) |
| 3 | yes | ~34 | Fleet regressions (/route dark-flag), auth wiring, breaker attribution |
| 4 | yes | ~33 | Skew, durability, validation clamps |
| 5 | yes (Gemini) | 8 | Alert-routing directive compliance; transfer races |
| 6 | yes | 11 | Clock-skew, undo durability, sink existence |
| 7 | yes (clean) | 9 | Flush rollback, cancel durability, honest operator scope |
| 8 | yes (clean) | 3 | Sentence-level reconciliations |
| 9 | yes (clean) | 1 | Overflow-regime undo cadence |
| 10 | yes (1 finding) | 3 | dry-run × /route; no-delta REPLACE; parked-pin lifecycle |
| 11 | yes (clean) | 1 | Framework-respawn regime governance (verified live code) |
| 12 | quota-walled | 7 | Regime-scoping blast radius of round 11's carve-out |
| 13 | waived | 4 | Recovery-door gaps; dark-gate lint collision (PR #1056) |
| 14 | waived | 3 roots | Recovery writes vs second knob; shadow-fate disclosure; Decision-Completeness gate (PR #1058) |
| 15 | waived | 3 | External-coverage honesty (PR #1059); recovery application arm; carrier clause |
| 16 | waived | **0 — CONVERGED** | All five internal reviewers clean |

## Full Findings Catalog

Every finding, its severity, the reviewer(s) who raised it, and the resolution taken is recorded
in the spec itself: `docs/specs/TOPIC-PROFILE-SPEC.md` §15 ("Round-N findings → resolutions"
tables, rounds 1–16). That ledger is the authoritative catalog — each row names the section the
fix landed in, and each fix cites its finding id inline at the patch site.

Process artifacts filed upstream rather than absorbed: [JKHeadley/instar#1060](https://github.com/JKHeadley/instar/issues/1060)
(Decision-Completeness heading-regex gap — found, not exploited) and
[JKHeadley/instar#1063](https://github.com/JKHeadley/instar/issues/1063) (operator
externals-waiver vs the PR #1059 mandatory-externals gate — no honest interaction path existed;
this report's coverage note is the manual version of the proposed fix).

## External-Coverage Scope (honest stamp boundary)

External cross-model review last saw this spec at **round 11** (Gemini: CLEAN — its fourth
consecutive clean read; it reviewed every externals round from 1 through 11, landing findings in
rounds 5–6 and 10). Rounds 12–16 ran **without externals**: Gemini was terminally quota-walled
mid-round-12, codex/grok CLIs are not installed on this machine, and the operator explicitly
waived externals for the remainder (Justin, 2026-06-11: "the cross model review is additional, not
required"). Any external-coverage flag on this spec's convergence therefore attests to the
round-11 body only; rounds 12–16 (the regime-scoping, recovery-write, shadow-fate, and decisions
folds) are covered by the five internal perspectives alone.

## Convergence verdict

**Converged at iteration 16.** Zero material findings from all five internal reviewers in the
final round (security, scalability, adversarial, integration, lessons-aware — the structurally
mandatory lessons pass included a final foundation audit and ELI16 truth check). Iterations 11–16
ran past the 10-iteration cap under explicit operator approval ("yes, please continue to
completion", 2026-06-11). The spec is ready for operator review and approval: read the ELI16
(`docs/specs/TOPIC-PROFILE-SPEC.eli16.md`), then approve via the `approved: true` frontmatter tag.
Nothing gets built until then.
