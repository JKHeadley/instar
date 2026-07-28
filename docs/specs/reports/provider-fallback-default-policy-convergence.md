# Convergence Report — Provider-Fallback Default Policy

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex CLI, gpt-5.5) AND a Gemini-tier pass (gemini-cli,
gemini-2.5-pro) ran on **every** round through the agent's own installed CLIs. External
verdict trajectory: **codex SERIOUS → MINOR → MINOR → (n/a)**, **gemini MINOR → MINOR →
MINOR**. The spec received genuine, repeated cross-model review; the clean RAN flag is
earned, not minted.

## ELI10 Overview

The agent does a lot of small background "thinking" — safety gates, sentinels, the check
that decides whether an outgoing message sounds right. Today all of it runs on Claude, so
when Claude has a bad night (rate limits, a slow API), that background thinking slows down
too. One night it slowed so badly the agent couldn't send its own messages for an hour.

This change makes those background helpers run on a *different* provider by default (Codex
first), with an automatic fallback chain (Codex → PI → Gemini → Claude), so no single
provider's bad night can strangle the agent again. The fallback *engine* already existed and
worked — it just shipped turned off. This turns it on out of the box, picking the first
provider you actually have installed. If you only have Claude, nothing changes (it's a
no-op). You can override or fully revert any time. The main tradeoff: more than one provider
is now involved in internal decisions, so behavior depends a little on which CLIs a machine
has — the design is honest about that and never lets a safety gate silently degrade (if every
provider is down, the gate still fails *closed*).

## Original vs Converged

- **Originally** the spec said "keep the engine untouched; just add a default policy + active-
  provider-filtered primary selection." Review showed the longer default chain needed ONE
  careful engine touch: a **bounded per-attempt timeout** (§4.5), because a chain of *slow-but-
  not-erroring* providers could stack timeouts and re-create the exact stall the spec exists to
  prevent. This was the single most important addition (round 1, M1) — independently flagged by
  4 reviewers + both external models.
- **The `job` category was originally IN** the default; review (gemini + security + integration +
  lessons) showed routing jobs off-Claude by default would silently auto-arm a cost-bearing
  background feature (the Cartographer freshness sweep). It was **moved OUT** — only sentinels,
  gates, reflectors are defaulted off Claude; jobs stay put.
- **The timeout's safety mechanism changed twice.** Round 2 prescribed an elaborate
  `.catch()`/`unref()`/`AbortSignal` guard against a server-crash hazard. Round 3 (adversarial,
  grounded in Node repros + the live `InputGuard` callsite) proved that hazard is **false** for
  the obvious `Promise.race` form, and that `AbortSignal` has **no receiver** in the codebase. The
  final design is **simpler**: `Promise.race` (crash-safe, matches a shipped precedent) + the CLI
  providers' **existing** `timeoutMs → SIGTERM` to actually kill a slow subprocess. The review
  process net-*removed* machinery.
- **A silent cross-feature regression was caught** (round 3, security): a memoized computed-default
  would have decoupled from the Cartographer sweep's runtime routing injection, silently making it
  refuse to author on every agent. Fixed by reading config **live** and layering the computed
  default *under* any runtime override (§4.6).
- **All 5 original open questions were resolved in-spec** (Frontloaded Decisions) — the
  Decision-Completeness reviewer confirmed zero of them were genuine user-decisions; all were
  engineering choices the building agent makes.
- **Migration was hardened**: the naive CLAUDE.md awareness update would have been a silent no-op
  (sniffing an existing heading) AND left now-false "opt-in / heuristic" text on every deployed
  agent. Fixed to a new marker + corrective subsection (migrate) + in-place sentence edit
  (generate).

## Iteration Summary

| Round | Reviewers who flagged material | Material findings | Spec changes |
|-------|-------------------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, lessons, conformance + codex(SERIOUS)/gemini | 11 (M1–M11) | §4.5 bounded swap timeout (new); `job` excluded; active-probe=buildProvider; honest self-heal; mutation-proof operator-set; herd analysis; Framework-Agnostic resolved; Frontloaded Decisions; Open questions→none |
| 2 | security, scalability, adversarial, integration + conformance + codex/gemini (both MINOR) | 9 (N1–N9) — decision-completeness + lessons CONVERGED | §4.5 orphan-safety + cap-dominance; §6.4 garbage-output relabeled caller-handled; §8 migration marker fix; precision (probe-cache, side-effect contract, ordering, live-read) |
| 3 | security, adversarial + scalability/integration precision + conformance + codex/gemini (MINOR) | 5 (R3-1..R3-5) — decision-completeness + lessons + scalability CONVERGED | §4.5 simplified to Promise.race + existing timeoutMs (dropped mis-grounded AbortSignal/.catch); §4.6 live-read + layer (fix CartographerSweep regression); precision + observability |
| 4 | (convergence) | 0 material — ALL 6 lenses CONVERGED | 2 non-blocking hygiene notes folded (A6 PATCH/config foot-gun documented; "120s" softened to illustrative) |

## Full Findings Catalog

Per-round, per-reviewer findings with severity and resolution are preserved on-branch under
`docs/specs/reports/_convergence-findings/` (round1-*.md … round4-*.md + roundN-SYNTHESIS.md).
Highlights by severity:

- **HIGH / SERIOUS (resolved):** M1 swap-latency stacking (→ §4.5 bounded timeout); codex round-1
  SERIOUS herd-onto-Claude (→ §6.2 gating-only + breaker-damped + correct last-resort); N1
  crash-hazard (→ corrected in round 3 to the crash-safe `Promise.race` form); R3-S2 / R3-1
  CartographerSweep silent-refuse regression (→ §4.6 live-read + layer).
- **MEDIUM (resolved):** M3/Q4 `job` category (→ EXCLUDED); N4 migration no-op + stale text (→ new
  marker + generate edits); A2 AbortSignal non-executable (→ dropped, use existing timeoutMs).
- **MINOR / precision (folded):** active-probe shares router cache; buildProvider side-effect
  contract; operator-set ordering contract; boot-snapshot vs live-read; observability
  (swap-attempt-timeout onDegrade); inline config-key posture; A6 PATCH/config foot-gun documented.
- **Recurring (resolved-in-favor, re-flagged by the deterministic gate each round):**
  Framework-Agnostic — the opinionated default is operator-directed, fully overridable, applied via
  one uniform mechanism, and a no-op on Claude-only agents (§6.5; lessons reviewer confirmed
  airtight rounds 2–4).

## Convergence verdict

**Converged at round 4.** All six internal lenses returned CONVERGED with zero material findings;
the two round-4 notes were explicit non-blocking hygiene items and were folded in. `## Open
questions` is empty (zero parked user-decisions — structurally enforced by the tag writer). Both
external models ran every round and settled to MINOR. The spec is ready for user review and
approval, then `/instar-dev` build.

frontloaded-decisions: 4 · cheap-to-change-after tags: 0 · contested-then-cleared: 1
