# Convergence Report — Reviewer-Door Rewiring

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex-cli → gpt-5.5) ran and SUCCEEDED in every one of the six convergence rounds — this is the clean RAN state (no ⚠). The Gemini-tier external (gemini-cli → gemini-3.1-pro-preview) was `degraded` (timeout) on rounds 1–3 but ran SUCCESSFULLY on rounds 4, 5, and 6, so both non-Claude families delivered genuine external opinions on the converged content. The new dark-by-default Anthropic clean-door reviewer this spec ADDS is `crossFamily: false` and by design never counts toward this cross-model flag (it books into the separate `clean-door-anthropic-review` disclosure field).

Standards-Conformance Gate: ran every round (rounds 1: 3 flags; 2: 2 flags; 3–6: 0 flags — `fit` verdict throughout). All flagged standards were resolved by round 3.

## ELI10 Overview

Before any code change lands in Instar, its design is reviewed by a panel of AI reviewers — six that run inside the agent's own coding environment, plus "outside opinions" from other companies' models (GPT via codex, Gemini via the gemini CLI). A benchmark project found that the *same* AI model can score noticeably worse depending on which "door" (which harness/path) you reach it through — one Anthropic model lost ~17 points just from the doorway. Yet Anthropic's strongest model (Fable 5) was never on the review panel at all.

This spec adds Fable 5 to the panel through a cleaner, isolated door that already exists (no new infrastructure, no new bills, no new companies seeing the documents), and makes three deliberate provider-by-provider door decisions (Anthropic: add the clean door; OpenAI: keep the existing codex door, decline the OpenRouter middleman; Google: keep gemini but fix its timeouts first). It ships switched OFF everywhere except the development agent, and flipping it back off is the entire rollback.

The convergence review changed the spec substantially. Two things matter most: (1) an honest scoping of the word "clean" — the new door is *off the penalized coding-harness door* but is NOT benchmark-proven clean, and the penalty was specific to one model (Opus), so the claim is deliberately modest; and (2) a real security fix caught late — the Claude door is not actually locked down by default (it can load extra tools and see the agent's secrets), so a malicious spec could try to make the reviewer *do* something. The spec now runs the reviewer in a no-tools, no-secrets sandbox (matching the GPT/Gemini reviewers) and proves it with a test that feeds in a booby-trapped spec and checks nothing was executed.

## Original vs Converged

**Originally**, the spec proposed adding the Anthropic reviewer family by reusing the existing `ClaudeCliIntelligenceProvider` "as-is", asserted the honesty guard (`crossFamily`) on a single TypeScript interface, described the door as "clean", claimed the model-freshness lint was "strict", waived a migration for the skill-doc change, used one shared timeout knob, and declared the config "rides the existing config replication posture."

**After review, every one of those was found wrong or incomplete and corrected:**

- **The honesty guard was rebuilt at the data layer.** The original design declared `crossFamily` on one interface, but the three guards that must honor it (the aggregate flag, the two detection paths, and the 7-day "you must have an outside opinion" baseline) operate on *different* data structures that didn't carry the field — and the baseline keyed on the very allowlist the spec extends. A misimplementation would have let a Claude-only review masquerade as a real outside opinion (an adversarial-reviewer BLOCKER). The field is now threaded onto the actual data structures, fails CLOSED on an unknown id, and the baseline-predicate swap is coupled atomically (one PR, one test) with the allowlist change.
- **A real inbound security hole was closed.** The Claude door is NOT tool-less by default — it loads user hooks + MCP servers and inherits the agent's secrets. A spec under review is untrusted text, so this was a live prompt-injection/tool-egress surface. The reviewer call is now hardened to the same read-only posture as the GPT/Gemini doors (empty allowed-tools, strict MCP config, neutral working dir, prompt over stdin, secret-stripped env), verified by a test that proves *no tool executed*, with a runtime preflight that fail-closes if the installed CLI doesn't accept the hardening flags.
- **"Clean" was scoped honestly.** The penalty was measured on Opus (Sonnet was clean on the same door) and on clean-*API*, not on this CLI door, and Fable 5 is unmeasured — so "clean" now explicitly means "off the penalized door", not "benchmark-clean", with the direct benchmark tracked as a deferral.
- **Three factual corrections:** the freshness lint is actually `strict`/CI-gating (a stale doc line said "report"); the skill-doc change *does* need a migration (added); and config is machine-local (Instar has no config replication) with a per-machine deployment note.
- **Opus-substitution guard:** the reviewer call passes the concrete Fable-5 id, never the tier word (which resolves to Opus), enforced by a per-family test.
- **Flexibility & bounds:** per-family timeouts (not one shared knob), a measure-first + quality-floor discipline before keeping a raised timeout, and an aggregate reviewer-time budget.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware, codex(ok), gemini(degraded), conformance-gate(3) | 1 blocker + ~11 major/material | Major rewrite: §5 crossFamily rebuilt at the data layer + atomic baseline-predicate swap; §2.2 egress invariant restated honestly; §1.1 clean-door claim scoped + model-specificity engaged; per-family timeout + concurrent execution; throw-safety; SKILL.md migration added; Maturation-Path developmentAgent gate; Close-the-Loop evolution-queue cadence; field-name cheap-tag narrowed |
| 2 | codex(ok, "serious"), gemini(degraded), conformance-gate(2), internal-verify(×3) | 3 (freshness-strict self-correction; D3 contradiction; override-hardening) | Freshness corrected to `strict` (stale-doc pulled into inc1); D3 fixed; model-override validates against the frontier set (reject non-frontier → degraded); non-vacuity test; codex terminology folds (API/SDK-door alternative, id-reuse rationale, fleet-dark/dev-on) |
| 3 | codex(minor), internal-convergence(1), **parallel-hand(3)** | 3 parallel-hand (inbound security, false multi-machine claim, opus-substitution) + 2 codex (detection semantics, testing contradiction) | Inbound-safety hardening (§1.4 + STATE test + §Security INBOUND/OUTBOUND); config reclassified machine-local + deployment note; concrete-pin-to-evaluate + per-family model-arg test; detection reasons made static; crossFamily made a required field + migration-guard test; D14 |
| 4 | internal-convergence(**CONVERGED**), codex(minor), gemini(ok) | 2 (STATE test fail-closed on flag drift; aggregate reviewer budget) | Real-CLI + version-pinned + fail-closed STATE test; `maxCumulativeExternalMs`; Audience & terminology note (external-reader clarity) |
| 5 | codex(minor), gemini(minor) | 1 (runtime hardening preflight) + quality floor | Runtime preflight → `hardening-unsupported` fail-closed on every machine; gemini timeout-raise quality floor in the inc3 checklist |
| 6 | codex(minor — non-material), gemini(minor — non-material), conformance-gate(0) | **0** | none — converged |

## Full Findings Catalog

### Round 1 (the design was substantially rebuilt)

- **[BLOCKER · adversarial]** Adding `claude-code` to `TRUSTED_REVIEWER_FRAMEWORKS` inverts `wasNonClaudeFrameworkActiveWithin` (keyed on `isTrustedReviewerFramework`) → a Claude-only activation would satisfy the "you must have an outside opinion" baseline. **Resolution:** §5.4 swaps the baseline predicate to `isCrossFamilyReviewerFramework` atomically with the allowlist addition, unit-locked (test asserts both halves).
- **[MAJOR · adversarial + security]** `crossFamily` declared only on `SupportedReviewerFramework`, but `aggregateRoundOutcomes`/`detectAllCrossModelReviewers` consume `ReviewerResult`/`CrossModelDetectionResult`, which lack the field → guard degrades to an unspecified id-lookup. **Resolution:** field threaded onto both consumed types, fail-CLOSED on unknown id; §5 rewritten at the data layer.
- **[MAJOR · adversarial]** `detectAllCrossModelReviewers` (the actual multi-family path) absent from the §5 guard enumeration. **Resolution:** §5.3 covers it + any banner/availability count.
- **[MAJOR · security]** The "no base-URL endpoint" egress invariant is not structurally true (operator `*_BASE_URL` overrides exist; the claude door passes env through). **Resolution:** §2.2 restates it honestly as "operator-controlled first-party endpoint"; OpenRouter's decline rests on independently-sufficient rationales.
- **[MAJOR · lessons-aware]** Freshness lint claimed "strict" but the routing-registry doc said "report". **Resolution (round 2):** verified ground truth = `strict` (PR #1378); the doc line was stale; corrected + doc-fix pulled into inc1.
- **[MAJOR · lessons-aware]** Clean-door premise unmeasured + model-specific (Opus 0.713 vs Sonnet 0.991 on the same door; Fable unmeasured). **Resolution:** §1.1 rewritten with the honest bound + minimum clean-door criteria + scoped claim + deferred direct bench.
- **[MAJOR · lessons-aware / integration]** Close-the-Loop: the paid-Gemini deferral had no cadenced resurfacing (L8 backtrack-tell) yet §Standard-B claimed "no path". **Resolution:** reconciled — the deferral rides the evolution-action-queue cadence.
- **[MAJOR · integration / conformance]** SKILL.md prose change wrongly waived a `PostUpdateMigrator` migration (Migration Parity case 5). **Resolution:** scoped idempotent migration added (D13).
- **[MAJOR · scalability]** 600s single-uniform timeout multiplies dead-wait 5–7.5× on a chronically-timing-out family. **Resolution:** per-family timeout + measure-cause-first + evaluate-vs-parse-failure-rates.
- **[MAJOR · scalability]** Family execution order (concurrent vs sequential) unspecified — the sole wall-clock determinant. **Resolution:** §7 states concurrent (`max`, not `sum`); spawn-cap funnel must not serialize the batch.
- **[MATERIAL · decision-completeness]** `clean-door-anthropic-review` field-name cheap-tag overclaimed "before fleet exposure". **Resolution:** narrowed to "while dark (inc1–inc2, before inc3 dev-agent enablement)".
- **[MATERIAL · conformance]** Maturation Path — ships dark everywhere behind a manual flip. **Resolution:** §1.5 rides the developmentAgent gate (live-on-dev / dark-on-fleet).
- **[minor · codex/scalability]** detection overstates availability; timeout may hide quality failures; internal-six model recorded per round; quota-correlation honesty. **All folded.**

### Round 2

- **[MATERIAL · self-caught + all 3 internal reviewers]** D3 still said "report" after §1.3 was corrected to "strict" — internal contradiction. **Resolution:** D3 corrected.
- **[MATERIAL · adversarial + conformance No-Deferrals]** Config override accepted any concrete id (incl. `claude-opus-4-8`). **Resolution:** override validated against the frontier-tier set in inc1 (reject → `degraded: override-not-frontier`), not merely disclosed.
- **[MATERIAL · conformance]** Stale routing-registry doc line left as a deferral. **Resolution:** pulled into inc1 (docs-only fix).
- **[minor · codex]** "clean" terminology; claude-code id overload; first-party API/SDK-door alternative unexplored; "dark by default" imprecise. **Folded:** scoped "clean"; id-reuse rationale; §8.6 API/SDK-door deferral + door-choice comparison; "fleet-dark/dev-on".

### Round 3 (parallel reviewer hand — highest-value security findings)

- **[HIGH · parallel-hand security]** The `claude -p --setting-sources user` door is NOT tool-less — loads user hooks + MCP servers (threadline), inherits full env (incl. `INSTAR_AUTH_TOKEN`), argv-visible prompt → live inbound prompt-injection + tool/MCP-egress surface; prior §Security covered only OUTBOUND. **Resolution:** §1.4 hardens to codex-door parity (empty allowed-tools, `--strict-mcp-config`, neutral cwd, stdin, env allowlist) + a STATE-level no-tool-execution test; §1.1 criterion (b) reframed; "reused as-is" → hardened.
- **[MATERIAL · parallel-hand]** False multi-machine claim — Instar has no config-file replication. **Resolution:** config reclassified machine-local + per-machine deployment note; git-tracked-report trigger stays unified.
- **[MATERIAL · parallel-hand]** Opus-substitution: passing the tier word `'capable'` resolves to Opus on the claude provider. **Resolution:** §1.4 passes the concrete pin, never the tier word; per-family model-arg test.
- **[MATERIAL · codex]** §1.2 listed `claude-not-authed` as a detection reason while saying detection isn't auth-verified. **Resolution:** detection reasons made purely static; auth/entitlement → invocation `degraded`.
- **[MATERIAL · codex + internal-convergence]** Testing line still said "opus-override accepted-but-disclosed", contradicting §1.3/D3's reject. **Resolution:** test asserts REJECT (`override-not-frontier`).
- **[minor · adversarial]** Freshness non-vacuity was a "MUST verify" instruction. **Resolution:** made a merge-blocking test (rots the constant, asserts the lint fails).

### Round 4 (internal reviewer: CONVERGED)

- **[MATERIAL · codex]** STATE test only covered the CI/dogfood CLI. **Resolution:** test runs against the real CLI, records the CLI version, fails-closed on unrecognized hardening flags.
- **[MATERIAL · codex]** No aggregate reviewer-time bound. **Resolution:** `maxCumulativeExternalMs` ceiling (Bounded Blast Radius).
- **[minor · gemini]** External-reader jargon density + "operator" role. **Resolution:** Audience & terminology note + pointer to the ELI16 companion.

### Round 5

- **[MATERIAL · codex]** CI test proves hardening only on dogfood machines; a drifted fleet CLI could run unhardened. **Resolution:** runtime preflight verifies the installed CLI accepts the hardening flags; else `degraded: hardening-unsupported` (fail-closed, never run unhardened).
- **[minor · codex]** Timeout raise could optimize availability over quality. **Resolution:** maintainer quality-floor sample in the inc3 dogfood checklist before keeping 600s.

### Round 6 (convergence — zero material findings)

All remaining external items are **non-material** by the skill's definition (would not require a spec change):

- **[non-material · codex #1 / gemini #1]** "clean door" terminology + `claude-code` id overload / structured-descriptor-now — a design-taste preference raised across all six rounds; the spec engages it structurally (`crossFamily` as a REQUIRED field + a migration-guard test that forces the classification decision on any new family) and defers the fuller structured descriptor with an explicit reuse rationale (§8.5). Terminology is defined precisely in-spec + the Audience note.
- **[non-material · codex #2]** CLI version floor / behavioral (not just flag-acceptance) preflight — defense-in-depth over an already fail-closed preflight + the behavioral STATE test; the current layering (CI behavior test + runtime flag preflight + version record) is sufficient.
- **[non-material · codex #3]** Frontier-only override lacks an emergency escape hatch — an *enhancement*: the reviewer is signal-only, so during an outage the family simply degrades loudly and convergence proceeds without it; no escape hatch is required for correctness.
- **[non-material · codex #4]** `maxCumulativeExternalMs` absent-by-default — absent = today's already-bounded behavior (per-call clamp + ≤10 rounds + delta-gating); a finite dev default is an optional tuning enhancement.
- **[non-material · codex #5 / gemini #1]** Spec density / implementation checklist — the mandated ELI16 companion is the accessibility surface; the rollout increments + decisions + testing already map to code. A doc nice-to-have, not a design change.
- **[non-material · gemini #2/#3]** CLI-vs-API door (gemini itself marks it "well-mitigated by the documented follow-up") and the truncated-context note (a review-format artifact — the ground truth was independently verified during convergence, not a spec defect).

## Convergence verdict

**Converged at iteration 6.** The internal reviewer panel reached CONVERGED at iteration 4; the Standards-Conformance Gate has been clean (0 findings, `fit`) since iteration 3; and both external families (codex every round; gemini on rounds 4–6) produced ZERO material findings in the final round — every remaining external comment is a repeat design-preference, an optional enhancement over an already-safe path, or a review-format artifact, none requiring a spec change. Every material finding surfaced across the six rounds (including one adversarial BLOCKER and a late high-severity inbound-security hole from a parallel reviewer hand) was folded. The spec is ready for user review and approval. It is NOT yet approved — `approved: true` is the user's step after reading this report.
