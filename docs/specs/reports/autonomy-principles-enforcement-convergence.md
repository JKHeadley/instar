# Convergence Report — Autonomy Principles Enforcement

**Spec:** `docs/specs/AUTONOMY-PRINCIPLES-ENFORCEMENT-SPEC.md`
**Converged:** iteration 3
**Reviewers per round:** up to 6 (5 internal Claude angles + live external cross-model)
**Author:** echo · **Source:** PR #1050 (Agent Autonomy Principles), Telegram topic 23935

---

## ELI10 Overview

Justin gave the agent two operating rules and asked how to bake them into Instar so they
*actually happen* instead of being words in a doc. Rule 1: almost every "I'm blocked" is a fake
wall the agent should work through (do I have access? can I get it? try it safely, then for real,
then write down the steps) — and on the rare real wall, record why so nobody re-fights it. Rule 2:
when designing a feature, pull every decision that needs the user to the front so the agent can
build the whole thing in one autonomous run, instead of stopping mid-way to ask.

This spec adds exactly two missing pieces plus one hardening Justin asked for: a **Blocker Ledger**
(a durable, gamed-proof record that walks each blocker to a real resolution or a re-tested
true-wall), a **Decision-Completeness gate** in our spec-review process (a design can't pass while
a user-decision is still buried in it), and **mandatory, dynamic cross-model review** (other AI
models like Gemini/GPT review our designs automatically, picking the strongest available model
rather than a hard-coded one). Everything ships dark (off) first. The main tradeoff weighed and
resolved in review: making the ledger *durable* is what makes it dangerous (a "settled wall" record
could make the agent lazier), so the entire design was inverted to make ducking work *harder*.

## Original vs Converged

The original draft was sound on its surface but had two flaws that review exposed:

1. **The Blocker Ledger could have made the problem worse.** Originally, a "true-blocker" just
   needed *a written reason*, and future sessions would read that settled record instead of
   re-deciding. Three independent reviewers (adversarial, lessons-aware, and the live external
   Gemini) flagged this as exactly the deferral-laundering our own deferral-detector refuses — it
   would turn a one-time excuse into permanent, citeable "don't try this wall" memory. **After
   review:** a true-blocker is never "settled" — it's a decaying hypothesis ("last verified
   <date>"), auto-reopened on a schedule, requires a structured reason from a closed list, requires
   the agent to *prove it first tried to do the thing itself* (e.g. checked its own vault for the
   credential) before asking the user, and must pass the existing false-blocker gate to settle at
   all. Re-tests require NEW evidence, so it can't be rubber-stamped.

2. **"Cross-model = pure reuse" was false.** Originally the spec claimed Piece 3 built nothing new.
   Review found the underlying `resolveModelForFramework` only handles two frameworks — Gemini and
   pi fall through to a junk value. **After review:** that extension is now honest in-scope work
   with a fail-loud canary, plus the spec now distinguishes *configured* from *available*
   frameworks (proven by the dogfooding machine, where codex is configured but absent), and
   constrains model selection to a trusted-provider allowlist so a spec never leaks to an untrusted
   endpoint.

Plus ~25 other material fixes: single-writer CAS on the ledger file (no cross-session clobbering),
prompt-injection hardening on free-text fields, full Migration-Parity + Agent-Awareness sections
(both NON-NEGOTIABLE standards the draft had skipped), a structural auto-open trigger so the ledger
fires off the deferral-detector instead of relying on the agent remembering, and resolution of all
five open questions into frontloaded decisions (so the spec passes its own Decision-Completeness
rule).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, lessons-aware, **external Gemini** | ~30 across 12 themes (1 critical: laundering; 1 critical: foundation break) | Full rewrite — anti-laundering design, evidence-gated terminals, structural trigger, CAS, archival, injection-safety, Migration+Awareness, Piece 3 foundation work, Q1–Q5 resolved |
| 2 | adversarial (3 new); lessons-aware **converged** | 3 (2 HIGH, 1 MED) | Removed taxonomy exemption (self-fetch-first mandate for secret/account kinds); access-requested only counts after failed self-fetch; durable standing-framework baseline vs pre-flight deactivation |
| 3 | adversarial **converged** | 0 | none |

## Full Findings Catalog (material findings)

### Round 1
- **CRITICAL (adversarial F1/F2/F6/F7, lessons F2/F3, security HIGH, external Gemini #1): deferral-laundering.** A durable "settled true-blocker" suppresses future re-litigation → inverts the feature's purpose. **Resolution:** closed taxonomy, per-step rebuttal, B17 + Tier-1 settle gate, decaying-hypothesis framing, re-walk-needs-new-evidence, audited settle.
- **CRITICAL/HIGH (integration HIGH#2, lessons F4): foundation break.** `resolveModelForFramework` only covers claude-code/codex-cli; gemini/pi return a non-model string. **Resolution:** in-scope extension + fail-loud canary; family-diversity acknowledged; configured-vs-available probe.
- **HIGH (adversarial F3, gemini #2): `resolved` stub-gameable.** **Resolution:** real artifact (new/modified this session, id-referenced, confined path, live-run-linked).
- **HIGH (lessons F1): ledger fires on willpower.** **Resolution:** auto-open off the deferral-detector/B16/B17 path.
- **HIGH (scalability): mandatory externals cost + framework-deactivation gaming (adversarial F5).** **Resolution:** delta-gate externals by content-hash; mid-converge deactivation = tamper.
- **HIGH (security): stored prompt-injection via free-text.** **Resolution:** bounded validation, escaped envelope to LLMs, HTML-escape, injection test.
- **HIGH/MED (integration HIGH#1, lessons F6/F7): Migration-Parity + Agent-Awareness unaddressed.** **Resolution:** v0.1 Migration & Deployment section + `generateClaudeMd()` block.
- **MED (scalability ×2, integration): concurrent-write clobber + unbounded growth + multi-machine.** **Resolution:** CAS single-writer, archival tier, single-machine v1 with named follow-up.
- **MED (security ×2): spec egress to untrusted provider.** **Resolution:** trusted-provider allowlist.
- **MED (adversarial F4, gemini #3): cheap-to-change-after gaming.** **Resolution:** reviewer CONTESTS each tag; closed non-cheap taxonomy; tag evidence in frontmatter.
- **MED (scalability): external-timeout fail semantics.** **Resolution:** advisory-degrade after fallback exhausted, bounded retry budget.
- **MED (integration, lessons F8): bootstrap + Q4/Q5 open.** **Resolution:** D13 (converge under current spec-converge); Q4→D10, Q5→D11.
- **LOW (scalability, lessons F9): recheck job tier/cadence.** **Resolution:** tier1 JobDefinition, maxReapsPerPass cap, jittered recheck-after.

### Round 2 (adversarial)
- **HIGH F-R2-1: taxonomy exemption reopened laundering on the common "I need credential X" shape.** **Resolution:** no kind exempt from a failed-attempt rebuttal.
- **HIGH F-R2-2: access-requested rewarded skipping self-fetch (contradicts CLAUDE.md self-fetch-first).** **Resolution:** secret/account kinds require a recorded failed self-fetch; access-request only counts after it.
- **MED F-R2-3: pre-flight framework deactivation dodge.** **Resolution:** durable standing-framework baseline over a 7-day lookback.

### Round 3 (adversarial)
- No material new findings. Honest break attempts (self-fetch attestation, lookback bootstrap/clock, ordering enforcement, perverse-incentive false-negative on truly-operator-only secrets) all resolved within the existing design.

## Cross-model note (Piece 3, dogfooded live)

This convergence ran a real external Gemini reviewer (gemini-cli present on the machine; codex
absent — the exact configured-vs-available case the spec now handles). Gemini's own model-router hit
retry-exhaustion and fell back mid-call — a live demonstration of the provider-fallback path Piece 3
specifies. Gemini's findings corroborated the internal cluster (structured true-blocker reason,
enforce the resolved artifact link, gate-becomes-blocker risk, tie-breaker).

## Convergence verdict

**Converged at iteration 3.** No material findings in the final round. The lessons-aware angle
converged at iteration 2; the adversarial angle (which carried the deepest findings) converged at
iteration 3; all round-1 security/scalability/integration/external findings were folded into the
round-2 rewrite and not re-raised. The spec resolves all open questions into frontloaded decisions,
so it satisfies its own Decision-Completeness criterion. **Ready for user review and approval.**
