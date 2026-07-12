---
spec: duplicate-build-guard
status: draft
tracks: ACT-592
parent-principle: "Structure beats Willpower"
---

# Duplicate-Build Guard — catch "this is already built / in-flight" before an instar-dev build

## 0. Origin & traceability

Earned from a live incident (2026-07-12, topic 11960): a session built **ACT-562** (LLM-decision provenance wiring, PR #1460) to completion — full instar-dev ceremony, all three test tiers green — and only discovered *at merge time* that **PR #1458** ("LLM-Decision Quality Meter", ACT-1193/1194) had already merged the same substrate to `main`. The two efforts carried different tracking IDs (ACT-562/563/564 vs ACT-1193/1194/1195) and ran in parallel, blind to each other. #1460 was closed as a duplicate; a full session of build was wasted. This spec makes that class of duplication structurally hard to repeat. Tracks **ACT-592**. Parent principle: **Structure beats Willpower** — "check whether the work already exists" must be a gate, not a thing an agent is trusted to remember.

## 1. Problem statement (verified against live source)

The instar-dev flow has NO check for "is this work already on `main` or in an open PR?":
- `skills/instar-dev/SKILL.md` Phase 2 ("Build location re-grounding") verifies the worktree is off *current* `JKHeadley/main` and records `git remote -v` + version — it checks base **freshness**, never **overlap**.
- `skills/spec-converge/SKILL.md` reviews a spec for security/scalability/multi-machine/decision-completeness — never "does this already exist?".
- The pre-commit / pre-push gates (`scripts/instar-dev-precommit.js`, `scripts/pre-push-gate.js`) enforce artifact/trace/spec/deferral discipline — never overlap.

Consequence: an agent (or a second session of the same agent) can spec, converge, build, test, and open a PR for a feature that already shipped, discovering the collision only when git reports conflicts at merge. The cost is a wasted build AND the coherence damage the operator has repeatedly flagged ("things falling through the cracks / duplicate work").

## 2. Scope of THIS increment

Deliver a **duplicate-build detector** that runs early in the instar-dev lifecycle and surfaces a specific, actionable overlap signal. In scope:
- A deterministic overlap check (`scripts/lib/duplicate-build-check.mjs`) given a spec path: extract the spec's declared TARGETS and compare against current `main` + open PRs.
- A build-start advisory (the earliest catch) surfaced by the instar-dev skill's grounding phase.
- A pre-push signal (the enforceable Structure > Willpower layer) that re-runs the check and surfaces overlap before the PR is opened.
- Graceful offline degradation (the open-PR scan needs `gh`/network; absence degrades to a local-only `main` check + a note, never a hard failure).

Out of scope (tracked, not built here): auto-abandoning a build on overlap (the author decides); a cross-agent in-flight registry beyond GitHub open-PR scanning `<!-- tracked: ACT-592 -->`.

## 3. Proposed design

### 3.1 Target extraction (what the spec claims to add)
From the spec being built, derive a TARGET SET, each with a match strength:
- **Decision-point / census identities** (STRONG): if the spec's `## Decision points touched` or a `provenanceCoverage`-style census entry names a decision point that is ALREADY `wired` on `main`, that is a near-certain duplicate. (This exact signal would have fired for ACT-562: the tone gate + CompletionEvaluator points were already in #1458's census.)
- **New exported symbols / substrate files** (STRONG): a spec that declares a new class/module whose name already exists on `main`.
- **Touched src files** (WEAK): overlap of the spec's touched files with files changed by a recent `main` commit or an open PR — a corroborating signal, not conclusive alone.
- **Tracker cross-reference** (STRONG): the spec's `tracks:` ACT id, or its title's feature name, appearing in a merged commit message or an open PR title/body under a DIFFERENT ACT id (the two-IDs-one-effort signature).

### 3.2 The check
`duplicate-build-check.mjs <specPath>` →
- Scans `main` (local, always available): for each STRONG target, is it already present/wired? (grep the census, `git grep` the symbol, `git log` the tracker/feature name.)
- Scans open PRs (`gh pr list --state open --json`): any open PR touching the same STRONG targets or naming the same feature/ACT.
- Emits a structured verdict: `{ overlaps: [{ target, strength, where: 'main'|'pr#N', evidence }], recommendation: 'clear'|'verify'|'likely-duplicate' }`.

### 3.3 Signal vs authority (load-bearing)
This is a **detector that produces a signal**, per `docs/signal-vs-authority.md` — it does NOT hold blocking authority by default. Overlap detection is heuristic (a symbol name can legitimately recur; a file can be touched by unrelated work). The author (agent or human) is the authority who decides "is this genuinely a duplicate?". The build-start surface is advisory; the pre-push surface is where a STRONG exact-match (a census point already `wired` on main) MAY escalate to a hard signal the author must explicitly acknowledge — **[OPEN QUESTION: warn-only vs block-on-strong-match]**.

## 4. Testing (all three tiers)
- Unit: target extraction from a spec; `main` overlap detection (a census point already `wired` → `likely-duplicate`; a novel point → `clear`); offline degradation (no `gh` → local-only verdict + note, never throw).
- Integration: the pre-push signal surfaces a seeded overlap and stays silent on a clean spec.
- E2E / regression: a fixture reproducing the ACT-562-vs-#1458 shape (a spec whose census target is already wired on a fixture `main`) yields `likely-duplicate` — the detector would have caught the real incident.

## 5. Rollout & operations
Ships behind a flag (advisory-first; the pre-push escalation is the graduated step). Offline-safe. The open-PR scan is bounded + cached. No runtime/agent-behavior surface — this is a dev-lifecycle tool.

## Decision points touched
- **"Is this build a duplicate?"** — `invariant` for the DETECTION (a deterministic overlap check over census/symbols/PRs), but the DISPOSITION (proceed / abandon) is explicitly left to the author, NOT the tool — the tool produces a signal, never an autonomous block/abandon. No judgment-candidate arbiter is introduced (the detector is deterministic; the human/agent is the authority). Per Signal vs Authority.

## Open questions
- **Warn-only vs block-on-strong-match at pre-push?** A census point already `wired` on `main` is a near-certain duplicate — is that a hard block (author must remove or explicitly override) or a loud warning? (Leaning warn+acknowledge, to avoid a brittle check gaining blocking authority — but a STRONG exact-match may warrant a harder stop.)
- **How aggressively to scan open PRs?** `gh pr list` is bounded but network-dependent; how stale is acceptable, and should a same-author open PR touching the same files always escalate?
- **Where is the primary hook** — build-start advisory (earliest, but skill-prompt-level = willpower), pre-push gate (enforceable = Structure), or both (recommended)?

## Multi-machine posture
- The check is a **CI/dev-lifecycle tool, machine-independent** — it reads `main` + GitHub open PRs (shared truth), not per-machine state. No machine-local surface. `unified` by construction.
