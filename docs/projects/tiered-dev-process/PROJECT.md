# Project Design — Tiered Development Process + Framework-Native Cross-Model Review

**Status:** project design, awaiting Justin's approval of the whole shape (Tier-3 gate).
**Author:** echo · **Date:** 2026-06-01 · **ELI16:** `PROJECT.eli16.md`
**Origin:** Justin directive (topic 13435, 2026-06-01) — formalize development into tiers by size/complexity, and re-platform cross-model review onto supported agentic frameworks (codex).

> Per Justin's own model, this is a **Tier-3 project**: it is designed and approved
> as a whole here, then each step below becomes its own **Tier-2 spec** (spec +
> ELI16 + spec-review-convergence + approval) before it is built.

---

## 1. Why

The instar-dev commit gate (`scripts/instar-dev-precommit.js`) currently forces the
**heaviest** process on **every** source change: each src-touching commit demands a
full, pre-approved spec (with `review-convergence` + `approved: true`) + ELI16 +
side-effects artifact + trace. That is right for a new subsystem and absurd for a
one-line observability fix — e.g. #658 (restart-safe classification) was a tiny slice
that still required a whole spec. The uniform heaviness (a) wastes effort on small
work and (b) trains the agent to treat the spec as a rubber-stamp rather than a real
design review, which erodes the value of the spec for the changes that genuinely need
one.

Separately, cross-model review (the GPT/Gemini/Grok external perspective in
spec-review-convergence) is currently **API-driven** — it depends on external model
API keys, so it is not uniformly available across instar agents. Justin wants it
re-platformed onto **supported agentic frameworks** (codex first): detect the
installed codex CLI and drive a top-model GPT review *through it*, so cross-model
review is framework-native, key-free, and available to **all** instar agents and
**all** their development work by default.

## 2. The model — three tiers

Formality scales with size **and** risk. The constant across all tiers: **an ELI16
overview accompanies anything Justin reviews** (a PR "request" or a spec).

| Tier | Trigger | Process | Justin's gate |
|---|---|---|---|
| **1 — small/mid** | small change, low blast-radius | Build → open a **PR with an ELI16**. Tests + lint + side-effects still required. **No pre-approved spec.** | Reviews + merges the PR |
| **2 — larger** | larger or higher-risk change | **Spec + ELI16**, run through **spec-review-convergence (incl. cross-model review)**, **approved before build**. (Today's process.) | Approves the spec before build |
| **3 — project** | large/complex, multi-part | **Project design + ELI16, approved as a whole.** Then **each step is its own Tier-2 spec**. | Approves the project shape, then each step's spec |

Tier 1 keeps the *safety* requirements (tests, lint, side-effects review) and the
ELI16 — it only drops the *pre-approved spec* ceremony, because for a small change the
**PR itself is the review surface**.

## 3. Tier classification — structure informs, the agent decides (Signal vs. Authority)

Structural intelligence (the classifier/gate/code) and LLM intelligence are not
substitutes; they **compose**. The commit gate **computes a tier signal** — size +
risk + its reasoning — and **surfaces it to the agent**, always, so the tier question
can never be skipped or forgotten (that is *Structure > Willpower*). But the signal
**informs**; it does not decide. The **agent makes the final tier call** with full
awareness of the signal (*Signal vs. Authority* — structure signals, the LLM holds
authority). The decision — the structural signal, the agent's chosen tier, and its
reasoning — is **recorded and audited**, which is the data that lets us improve *both*
the classifier and the judgment over time.

> An earlier draft of this section said "the system decides the tier — not the agent."
> That framing was wrong (and, per the constitution, unconstitutional): past a
> threshold of importance, structure must **inform** the LLM, never replace its
> decision. Regex/code earns the LLM the most awareness to make an optimal choice; it
> does not make the choice for it. (Corrected per Justin, 2026-06-01 — see §8.)

**Inputs:**
- **Size** — in-scope lines changed + files touched (the gate already enumerates
  in-scope staged files).
- **Risk / blast-radius**, which can *escalate* the tier above what size alone implies:
  - **Reversibility** — migrations, data-format changes, anything not trivially revertable.
  - **New capability vs. fix** — a new subsystem/endpoint/feature vs. a localized fix.
  - **Safety-invariant proximity** — touches an invariant-bearing area: SecretDrop
    (never-on-disk), the relay/delivery path, auth/tokens, destructive-op funnels
    (SafeFs/SafeGit), the session lifecycle/reaper. Proximity escalates regardless of size.

**Rule (starting proposal — to be finalized in Step A's spec):**
- Base tier by size: `≤ ~40 LOC across ≤ ~3 files` → Tier 1 candidate; larger → Tier 2.
- **Escalate** by risk: any safety-invariant proximity, irreversibility, or "new
  capability" bumps up at least one tier (a 1-line change near SecretDrop is not Tier 1).
- **De-escalate** is never automatic — only size *raises* the floor; risk only *raises*.
- Tier 3 is **declared**, not auto-detected: when a change is part of an approved
  project, its step-specs are Tier 2 each; the *project* is what's Tier 3.
- The gate **prints the computed tier signal + the reasons** and **records the agent's
  final tier choice + reasoning** to an audit trail. It enforces that (a) a tier
  decision is made and surfaced, and (b) the **chosen** tier's requirement set is
  satisfied (Tier 1 → ELI16 + side-effects + tests/lint; Tier 2+ → + approved converged
  spec + trace). A **safety-invariant-proximity signal is loud**: the agent may still
  choose a lower tier, but only with explicit recorded justification, and such overrides
  are surfaced for review (the audit trail is exactly what makes "the agent decides"
  safe rather than a loophole). Structure makes the right call unskippable and
  well-informed; the agent makes it.

## 4. Cross-model review — re-platformed onto the installed framework

**Today:** spec-review-convergence runs 8 reviewers — 5 internal (security, scalability,
adversarial, integration, lessons-aware) + 3 external/cross-model (GPT/Gemini/Grok)
"via the /crossreview pattern" (`skills/spec-converge/SKILL.md`), plus the code-backed
Standards-Conformance Gate. The 3 external reviewers are the **API-driven** part.

**Change:** drive the external/cross-model reviewer prompt
(`skills/spec-converge/templates/reviewer-cross-model.md`) through a **detected,
installed agentic framework** instead of a model API:
- **Detection** — is a supported reviewer framework installed? (codex CLI present + authed.)
- **Invocation** — feed the cross-model reviewer prompt + the spec + referenced context
  to the framework (codex → a GPT-5-tier review) using the agent's **own** framework
  auth. No separate API key.
- **Supported-reviewer registry** — codex is the first supported framework; the registry
  is the extension point (gemini-cli etc. later), mirroring the framework-issue ledger's
  "supported frameworks" notion.
- **No-codex fallback (Justin-approved, option b)** — if **no** supported reviewer is
  installed, **degrade to single-model (internal-only) convergence** and record a **loud,
  explicit `cross-model-review: unavailable` flag on the spec** (+ in the convergence
  report). Do **not** block the agent from shipping; record the gap honestly so a reader
  knows the spec did not get an external perspective. The lessons-aware internal reviewer
  (never skippable) remains the structural defense against self-verify circularity.

Result: every instar agent with codex installed gets cross-model review **for free, by
default**, on **all** its Tier-2+ development work — fulfilling the Self-Hosting standard
(the capability runs through the agent's own stack, not an external dependency).

## 5. The steps (each becomes its own Tier-2 spec)

- **Step A — Tier classifier + Tier-1 commit path.** Teach the commit gate to compute
  the tier (size + risk) and enforce the per-tier requirement set; add the Tier-1 path
  (commit allowed with ELI16 + side-effects + tests/lint, **no** pre-approved spec). The
  ELI16-on-a-PR requirement formalized. *Touches:* `scripts/instar-dev-precommit.js`,
  `scripts/eli16-overview-check.mjs`, the instar-dev skill.
- **Step B — Cross-model review on the installed framework.** Detection + codex-CLI
  invocation of the cross-model reviewer + supported-reviewer registry + the no-codex
  degrade-with-flag. *Touches:* `skills/spec-converge/` (the /crossreview pattern),
  possibly `src/core/ConvergenceChecker.ts` / `convergence-check.sh`, the convergence
  report + tag writer.
- **Step C — Skill, docs & agent-awareness.** Update `spec-converge` + `instar-dev`
  SKILLs, the CLAUDE.md template (Agent Awareness standard — every agent must *know* the
  tiers + the framework-native review), `docs/STANDARDS-REGISTRY.md`, and the ELI16
  template guidance to cover "request" (PR) ELI16s.
- **Step D — Migration parity.** Ensure deployed agents receive the new gate/skill via
  `PostUpdateMigrator` (Migration Parity standard) — a gate change that only helps new
  agents is broken.

(Step ordering: A and B are largely independent and can run in parallel; C and D follow.)

## 6. Key decisions (locked)

- **D1 — The gate computes a tier *signal* (size AND risk); the agent makes the final
  tier call, informed + audited.** Structure informs, the LLM decides — never "the
  system decides." (*Signal vs. Authority*.) §3, §8.
- **D2 — Tier 1 drops the pre-approved spec but keeps ELI16 + side-effects + tests/lint;
  the PR is the review surface.** §2.
- **D3 — Cross-model review is framework-native (detected codex CLI), not API-driven.** §4.
- **D4 — No supported reviewer installed → degrade to internal-only convergence + a loud
  `cross-model-review: unavailable` flag; never block shipping.** (Justin-approved, b.) §4.
- **D5 — Each project step is its own Tier-2 spec (converged + approved); the project is
  approved as a whole first.** §2, §5.

## 7. Open questions for Justin

1. **Tier-1 merge:** for Tier-1 PRs, do you want to **merge them yourself** (review-gate),
   or have me **auto-merge** once CI is green for a defined "clearly-Tier-1" subset (and
   you spot-check)? (My #658 question, now scoped: I lean *you merge* until we trust the
   classifier, then revisit.)
2. **Size thresholds:** the §3 numbers (~40 LOC / ~3 files) are a starting point — happy
   to tune. Any feel for where Tier-1↔Tier-2 should sit?
3. **Project-design convergence:** should a *project design* doc (like this one) itself go
   through cross-model convergence, or is the project-level gate just your approval of the
   shape, with convergence happening at each step-spec? (I've assumed the latter.)
4. **Reviewer model within codex:** drive the cross-model review with codex's default
   top model, or pin a specific GPT tier for review consistency?

## 8. Foundational principle — LLM intelligence WITH structural intelligence

This project is a concrete instance of a principle that runs through all of Instar, and
the tier-classifier (§3) is where it almost got violated — so it's worth stating here,
and integrating into the constitution as its own careful pass (below).

**The principle.** An LLM is a powerful intelligence but, on its own, lacks the
regulatory and convergent dynamics a human body provides — so it cannot be a behavioral
equivalent to a person over an expanded scope of awareness and time. Instar closes that
gap with **infrastructure**: it sits at the top of an abstraction stack (tool access →
agentic harnesses like Claude Code / Codex → Instar) and systematically fills the
remaining gaps, balancing **evolution with convergence to maintain homeostasis**. The
more robust that homeostasis, the *faster* Instar can safely evolve. It does this by
**encoding evolutionary intelligence into infrastructure** — produced by LLM and human
intelligence together (co-evolution keeps self-evolution aligned and coherent), with the
long arc being that Instar depends *less and less* on human intelligence while remaining
aligned with it — the way a child matures in a supportive environment into self-
sufficiency and then gives back.

**The operative rule (fractal, applies everywhere).** Structural intelligence (regex,
code, gates, classifiers — the crystallized output of past evolution) and LLM
intelligence are **composed, not substituted**. Past a threshold of importance,
structure must **inform** the LLM — giving it maximal awareness to make an optimal
choice — and must **not decide for it**. The LLM holds final authority; the structure is
signal. This is why Instar does not let regex "make decisions" alone past a certain
importance — and why §3's gate *suggests + informs + audits* a tier rather than dictating
it. The audit trail (structural signal + the agent's choice + its reasoning) is itself
infrastructure that closes the loop: it's the data for improving both the structural and
the LLM side over time.

**Constitutional integration (its own work, deliberately not buried here).** This maps
directly onto the existing **Signal vs. Authority** principle (`docs/signal-vs-authority.md`)
and complements **Structure > Willpower** (structure makes the right decision unskippable
and well-informed; it does not remove the decision). Justin's framing adds the deeper
"why" — the homeostasis / co-evolution / progressive-self-sufficiency arc — which the
constitution does not yet state as a first-class foundational article. **Action:** a
separate, careful pass (a constitutional article + `STANDARDS-REGISTRY.md` update,
reviewed) that (a) elevates "structure informs, the LLM decides, the decision is audited"
to a general law, and (b) records the evolutionary-intelligence-into-infrastructure
framing as Instar's stated long-term purpose. Tracked as a sibling effort to this project,
not a step inside it.
