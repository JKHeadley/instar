---
name: spec-converge
description: Iteratively review an instar-development spec with multi-angle internal reviewers (security, scalability, adversarial, integration, lessons-aware) and a real cross-model external reviewer routed through the agent's own installed codex CLI (GPT-tier) until convergence, then produce a comprehensive ELI10 convergence report. Output is a spec tagged review-convergence — one of the two tags /instar-dev requires before it will touch instar source. NOT user-invocable; run by the instar-developing agent before any spec-driven /instar-dev work.
metadata:
  user_invocable: "false"
  audience: "instar-developing agent only — NOT end users"
---

# /spec-converge

**Audience:** the instar-developing agent. End users do not invoke this. Throughout this document, "the agent" refers to the instar-developing agent running the skill.

---

## What this skill does

Takes a spec file, runs multiple parallel reviewers against it, updates the spec to address their findings, runs another round, and repeats until convergence. Produces a final converged spec and a comprehensive human-readable report.

The purpose is to catch architectural, security, adversarial, scalability, and integration issues BEFORE code is written, not after. The single-reviewer pattern used by `/instar-dev`'s existing second-pass step has proven too narrow in practice — a four-reviewer parallel audit on the integrated-being ledger PR surfaced 14 serious issues that a single reviewer had missed. This skill bakes that multi-angle pattern in as the structural default for any substantive instar-dev work.

## When it runs

Before `/instar-dev` touches any instar source, the change's spec must pass through this skill. `/instar-dev`'s pre-commit hook refuses work unless:

1. The spec file has a `review-convergence: <timestamp>` entry in its frontmatter, written by this skill on successful convergence.
2. The spec file has an `approved: true` entry in its frontmatter, written by the user after reading the convergence report.

Both tags must be present. Without them, `/instar-dev` is blocked.

## Input

One argument: the path to the spec file, relative to the instar repo root.

The spec file is a markdown document with YAML frontmatter. Minimum required structure:

```markdown
---
title: "Short title"
slug: "url-friendly-slug"
author: "agent name"
---

# Title

## Problem statement
[what is being built and why]

## Proposed design
[how it works, at enough detail to review]

## Decision points touched
[any block/allow/route gates the design introduces, removes, or modifies]

## Open questions
[things that need human input]
```

The skill adds `review-convergence`, `review-iterations`, `review-completed-at`, and (if provided) `approved` fields to the frontmatter on successful convergence.

## Phases

### Phase 1 — Initial review round

The skill spawns reviewers in parallel:

**Internal reviewers (Claude subagents):**

- **Security.** Attack surfaces, leaks, privilege escalation, auth on endpoints, prompt injection vectors, rotation races.
- **Scalability/performance.** Hot-path cost, concurrent writes, memory churn, fail-open semantics, hook latency.
- **Adversarial.** Misbehaving-session scenarios — bad-entry poisoning, self-reinforcing loops, stale claims, authority ambiguity, kind gaming.
- **Integration/deployment.** Migration, backup/restore, multi-machine, config knobs, dashboard surface, rollback.
- **Lessons-aware.** Loads the canonical Instar Design Principles + Lessons Learned index (`docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`) plus the running agent's local `.instar/memory/feedback_*.md` entries, then checks the spec for (a) direct contradictions of documented principles/lessons, (b) applicable lessons the spec fails to engage with, and (c) behavioral lessons violated by agent-facing surfaces the spec proposes. Catches the "Phase 2" anti-pattern and the spec-converge-pre-auth-circular failure mode (see `feedback_spec_converge_pre_auth_circular`).

**External reviewer (cross-model, via the agent's own installed codex CLI):**

The external "cross-model" pass is a single independent GPT-tier read that sits *outside* the Claude family to catch the blind spots Claude models share. It is **real**, routed through the agent's own `codex login` (no new API key, no new network dependency), and implemented in code — NOT a hand-wave. Run it like this:

1. **Detect** whether a supported reviewer framework is installed + authed:
   ```bash
   node skills/spec-converge/scripts/cross-model-review.mjs --spec <spec-path> --detect-only
   ```
   Returns `{ available, framework?, model?, reason? }`. `available:false` → skip the external pass, set the fallback flag (see §"No-codex fallback" below / Phase 5), and continue internal-only. **Never block.**

2. **Run** the external review when available — pass the spec plus the same architectural context docs the internal reviewers receive (the docs the spec references):
   ```bash
   node skills/spec-converge/scripts/cross-model-review.mjs \
     --spec <spec-path> \
     --context docs/foo.md --context docs/bar.md
   ```
   It emits a JSON `ReviewerResult` on stdout: `{ status, framework?, model?, verdict?, findings?, reason?, flag }`. Fold its `findings` into the round alongside the internal reviewers'. `status:'degraded'` (codex present but the call failed — timeout / error / rate-limited) is a *partial* cross-model pass for the round: fold in whatever came back and record the `degraded` flag — it does **not** collapse to `unavailable`.

The detection + invocation + parsing live in the unit-tested `src/core/crossModelReviewer.ts` module (built to `dist/core/crossModelReviewer.js`); the script is a thin file-I/O wrapper. codex is the **first** supported framework in an extensible registry (`SUPPORTED_REVIEWER_FRAMEWORKS`) — gemini-cli and others plug in there later with **no skill change**.

Each internal reviewer receives the spec, the architectural context docs referenced in the spec (`docs/signal-vs-authority.md`, `docs/integrated-being.md`, relevant subsystem docs), and a prompt specific to their perspective. Each produces a structured finding list.

The **five internal reviewers + the cross-model external pass** run in parallel (the external pass is one cross-model read through the first available supported framework — the honest mechanism, not three phantom API models). Their findings are collected.

**Code-backed reviewer — the Standards-Conformance Gate (auto-invoked).** Alongside the internal reviewers + the cross-model external pass, call the live gate: `POST /spec/conformance-check` with the spec (body `{ "specPath": "<path-within-specsDir>" }`, or `{ "markdown": "<spec text>" }`). Unlike the prompt-driven reviewers, the gate is *code that reads the living constitution* (`docs/STANDARDS-REGISTRY.md`) and returns a per-standard report — `ok` / `at-risk` / `n/a` + a reason for every standing standard. Fold its `at-risk` entries into the round's findings. It is the structural complement to the Lessons-aware reviewer: lessons-aware reads the lessons doc + local memory (prompt-driven); the gate reads the constitution itself (code), so a registry edit can never be silently missed. **Signal-only:** advisory — it surfaces violations, it does not block (blocking authority is the separate, later `scg-blocking-authority` follow-up, per *Signal vs. Authority*). **Fail-open:** if the gate is disabled/unreachable (503) or returns `degraded: true`, note that the constitutional pass was not authoritative and continue — a down gate must never stall spec review. (This auto-invocation is the dogfood-to-ship enforcement of the **Self-Hosting** standard — the gate now *runs* at spec-review rather than being a step the author must remember.)

**The lessons-aware reviewer is not optional**, even in pattern-instance abbreviated convergence. Abbreviated convergence may skip external models (one round instead of multiple) but must NOT skip the lessons-aware pass — that's the only defense against the circular self-verify problem documented at `feedback_spec_converge_pre_auth_circular`. When a spec author runs convergence on their own spec, the lessons-aware reviewer is the structural check that catches what the author missed.

### Phase 2 — Spec update

The skill reads all findings, groups duplicates, prioritizes by severity, and rewrites the spec to address each substantive finding. Trivial/cosmetic findings are noted but may be batched.

The spec update is ONE coherent edit of the spec document — not one patch per reviewer. The agent treats the findings as a single synthesis input.

Every update preserves the spec's structure. Changes are additive (new sections for new concerns) or rewrites of existing sections (when a finding reveals a design flaw).

### Phase 3 — Convergence check

After the spec is updated, the skill runs another full review round (the five internal reviewers + the cross-model external pass, in parallel, on the updated spec).

Convergence criterion: **the new round produces no material new issues.** "Material" means any finding that would require a spec change if unaddressed. Cosmetic findings, repeats of already-addressed concerns, and minor phrasing quibbles are non-material.

A lightweight LLM (Haiku-class) compares the new round's findings to the prior round's findings and emits a boolean `converged: true|false` with reasoning. Human-readable comparison log is retained.

**Not converged** → back to Phase 2.
**Converged** → Phase 4.

Hard cap: 10 iterations. If the skill hits 10 iterations without convergence, it exits with a `convergence-failed` status and a report explaining why. Human input is required before retry.

#### Aggregating per-round cross-model outcomes into ONE spec-level flag

Convergence runs **multiple rounds**, but the spec gets **one** final `cross-model-review:` value. Each round's cross-model pass returns a `ReviewerResult` with a per-round status (`ok` / `degraded` / `unavailable`); the skill **tracks the per-round outcomes** and computes the final flag with `aggregateRoundOutcomes(rounds, { skippedAbbreviated })` (exported from `src/core/crossModelReviewer.ts`). The rule:

- **`skipped-abbreviated`** — the author opted out of the external pass entirely (abbreviated mode). No round attempted it. (Wins over everything; nothing was tried.)
- **`codex-cli:<model>`** (the clean RAN flag) — **any** round got a successful external pass. One genuine outside opinion is enough to say the spec received real cross-model review; the freshest successful round's flag is used.
- **`degraded-all-rounds`** — a framework was present in the rounds but **zero** rounds succeeded (every attempt degraded: timeout / error / rate-limited). This is the case the aggregate exists to surface: **"converged having never once received a real external opinion."** It is treated **as loud as `unavailable`** — it must show up at SPEC level (the banner above + the frontmatter flag), not hide in per-round degraded notes.
- **`unavailable`** — no supported framework was ever available across the rounds.

The point of the aggregate: a spec that degraded on every single round looks, from the per-round notes alone, like it "tried" — but it converged with the SAME assurance as one that had no reviewer at all. `degraded-all-rounds` makes that fact impossible to miss at the spec level. The skill passes the aggregated `flag`/`reason` to `write-convergence-tag.mjs` (Phase 5) and renders the matching banner (Phase 4).

### Phase 4 — Convergence report

Produce a final report at `docs/specs/reports/<slug>-convergence.md` with the following structure:

```markdown
# Convergence Report — <spec title>

## Cross-model review: <STATUS>

[A can't-miss banner stating the external (non-Claude) reviewer posture for this convergence — taken from the FINAL spec-level `cross-model-review:` value (see "Aggregating per-round outcomes" below: a single round produces an `ok`/`degraded`/`unavailable` result, but the SPEC gets one final value). **Every non-ran state carries the loud ⚠ marker** — a non-ran state must NEVER read as a clean pass. One of:

- `## Cross-model review: codex-cli:<model>` — RAN. A real GPT-tier external pass ran through the agent's codex CLI in at least one round. The ONLY state with no ⚠ (it is the clean pass).
- `## ⚠ Cross-model review: codex-cli:<model> (degraded: <reason>)` — codex is installed but THIS round's call failed (timeout / error / rate-limited); the external pass was partial. State the reason. (Per-round status; if some OTHER round succeeded, the spec-level flag is the clean `codex-cli:<model>` instead.)
- `## ⚠ Cross-model review: DEGRADED — ALL ROUNDS (degraded-all-rounds)` — codex was present every round but **ZERO rounds succeeded** (every attempt degraded). The spec converged having **never once received a real external opinion** — as loud as UNAVAILABLE. State the last round's reason. The user reads THIS before applying `approved: true`.
- `## ⚠ Cross-model review: UNAVAILABLE` — no supported external (non-Claude) reviewer was installed/authed. Convergence ran on the internal Claude reviewers + the constitutional gate ONLY. State the specific reason (`codex-not-installed` / `codex-not-authed` / `codex-auth-apikey-forbidden`) and the one-line remediation (`codex login`, or install `@openai/codex`). The user reads THIS before applying `approved: true`, so the reduced-assurance state is an informed choice, not a silent one.
- `## ⚠ Cross-model review: SKIPPED (abbreviated convergence)` — the author chose the fast path; the framework may be present but was deliberately skipped (the lessons-aware reviewer still ran). This is a **non-ran** state, so it carries the ⚠ too — "I skipped the outside opinion to save cost" must be as visible as "I had no outside opinion available," not a quiet footnote.]

## ELI10 Overview

[2-3 paragraph plain-English summary of what the spec is, why it matters, what changes for users if it ships, and what the main tradeoffs are. No jargon. Assume the reader is smart but not a systems engineer. "We're adding a way for different parts of the agent to know what each other is doing..." tone.]

## Original vs Converged

[A dedicated section describing the major differences between the initial spec and the converged version, also in ELI10 terms. "Originally, any session could write anything to the ledger. After review, we restricted writes to a curated set of server-side sources because an untrusted write surface made too many attacks too easy." This section is what the user reads to understand what the review process actually changed.]

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | security, adversarial | 14                | ... |
| 2         | scalability           | 3                 | ... |
| 3         | (converged)           | 0                 | none |

## Full Findings Catalog

[Every iteration, every reviewer, every finding with: severity, reviewer perspective, original text, resolution taken. Structured for detail-oriented readers.]

## Convergence verdict

[Plain statement: "Converged at iteration N. No material findings in the final round. Spec is ready for user review and approval."]
```

### Phase 5 — Frontmatter tag

On successful convergence, the skill writes to the spec's frontmatter:

```yaml
review-convergence: "<ISO timestamp>"
review-iterations: <N>
review-completed-at: "<ISO timestamp>"
review-report: "docs/specs/reports/<slug>-convergence.md"
cross-model-review: "<flag>"          # codex-cli:<model> | unavailable | degraded-all-rounds | skipped-abbreviated
cross-model-review-reason: "<reason>" # only when unavailable / degraded / degraded-all-rounds
```

The `cross-model-review` field records the **final spec-level** external-reviewer posture (the `aggregateRoundOutcomes` result — see "Aggregating per-round cross-model outcomes" in Phase 3) so the spec self-documents which external pass it received (or didn't). Pass it through the tag writer with the aggregated `flag`/`reason` (strip the leading `cross-model-review: ` prefix — the script writes the field name itself):

```bash
node skills/spec-converge/scripts/write-convergence-tag.mjs \
  --spec <spec-path> --iterations <N> --report <report-path> \
  --cross-model-review "codex-cli:gpt-5.5"          # or "unavailable" / "degraded-all-rounds" / "skipped-abbreviated" / "codex-cli:gpt-5.5 (degraded: timeout)"
  [--cross-model-reason "codex-not-installed"]
```

This is **DISCLOSURE, not a gate** — it does NOT change `/instar-dev`'s `review-convergence` + `approved: true` enforcement. An `unavailable` spec can still be approved (the user reads the report banner and makes an informed choice).

**Structural prerequisite — ELI16 overview.** Before the convergence tag is written, `skills/spec-converge/scripts/write-convergence-tag.mjs` verifies the spec ships with a plain-English ELI16 companion at `docs/specs/<slug>.eli16.md` (or the path declared via `eli16-overview:` frontmatter). The companion must be at least 800 characters. If the overview is missing or stub-length, convergence is refused — no tag is written. The dense technical spec is for reviewers; the ELI16 overview is the entry point for any reader who has to make a real decision. See `skills/instar-dev/templates/eli16-overview.md` for the expected shape.

The `approved: true` tag is NOT written by this skill. That's the user's step.

### Phase 6 — User handoff

The skill emits the link to the convergence report via the messaging layer (Telegram or equivalent) so the user can read the ELI10 report and decide.

The skill does NOT auto-apply `approved: true`. That requires explicit human action — editing the frontmatter or running `instar spec approve <path>` (follow-on CLI command).

## What this skill does NOT do

- It does not build code. That's `/instar-dev`'s job, after both tags are present.
- It does not relax convergence criteria to avoid iteration. 10-iteration cap exists to surface "this design is too confused to review" rather than to force false convergence.
- It does not skip reviewer perspectives. The five internal reviewers + the cross-model external pass run on every round (subject to the abbreviated-convergence exception, which still runs the non-skippable lessons-aware reviewer).
- It does not auto-approve on behalf of the user. Approval is the user's structural contribution to the process.

## Bootstrap exception

This skill itself is an instar-source change. The strict reading of the new rule would require IT to have a spec that passed through itself before it could ship. That's a chicken-and-egg loop the skill itself has to break.

Documented bootstrap exception: the first commit introducing `/spec-converge` is allowed to pass `/instar-dev`'s pre-commit gate without the spec tags, ONLY because the skill that installs the tag mechanism cannot be gated by itself. This is a one-time exception, visible in the commit history, and will not recur — every subsequent change to this skill or to anything else in instar source will require the full spec-convergence-approval chain.

## Anti-patterns the enforcement will catch

### "Just one more iteration"
The convergence check is structural. If the LLM comparator finds new material issues, iteration is required. The agent does not get to overrule this.

### "Convergence" with shrinking findings but not zero
A smaller finding count is NOT convergence. Convergence is zero material findings in a new round.

### Skipping a reviewer perspective to ship faster
All five internal reviewers (security, scalability, adversarial, integration, lessons-aware) AND the cross-model external pass run on every round. Skipping is visible in the iteration log and fails the report validation. During pattern-instance abbreviated convergence, the external cross-model pass may be skipped to save cost — record that honestly as `cross-model-review: skipped-abbreviated` (distinct from `unavailable`: the framework may be present, but the author chose the fast path) — but the lessons-aware reviewer MUST run; it's the only structural defense against the spec-converge-pre-auth-circular failure mode.

### Rewriting the spec between iterations to hide findings
Spec edits must address findings, not evade them. The iteration log records both the finding and the resolution. An edit that changes the spec to make the finding "not applicable" without actually solving the concern is caught at the next review round.

### Forging the review-convergence tag
The tag is written only by this skill's Phase 5. Manual writes of the tag without going through the skill will fail `/instar-dev`'s deeper check (the report file at `docs/specs/reports/<slug>-convergence.md` must exist and match).
