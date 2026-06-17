# Convergence Report — Cross-Machine Account & Quota Sharing (Decision-A re-converge)

## Cross-model review: codex-cli:gpt-5.5

A real external (non-Claude) pass RAN in the final round through the agent's own
codex CLI (GPT-tier, `gpt-5.5`) AND the gemini CLI (`gemini-2.5-pro`). Both returned
**MINOR ISSUES** on the converged body — no material findings. This is the clean
RAN state (no ⚠).

## ELI10 Overview

When you run one agent across two computers (a laptop and a Mac mini), each computer
can only answer you if it has a working Claude account with quota left. Today, if the
computer holding your conversation runs out of quota, you get a dead "🔭 working…"
with no reply. This spec fixes that.

The operator (Justin) asked for the seamless end-state: "once I've logged into an
account on one machine, that account should work across machines." The chosen path
(**Decision A**) delivers it the ToS-safe way: each machine gets its OWN login for
the account (the agent assists; you approve once per machine) — no Claude login token
is ever copied between machines. Then the system routes each conversation onto a
machine that can actually serve it.

What this re-converge changed is the **honest scope**: the "each machine mints its
own login" piece depends on a *separate, not-yet-built* workstream (WS5.2 / account
follow-me — the very topic that was paused). So this spec now ships the part that is
buildable and provable today — **quota-aware automatic seat-transfer**: when the
machine holding your chat can't serve, the conversation automatically moves to one
that can, and your reply still lands. The in-place auto-enroll is a named, deferred
follow-up behind WS5.2. The user-visible win — you always get a reply — is delivered
now; the "which machine physically answered" optimization comes later.

## Original vs Converged

- **Original (this re-converge's input):** §3 framed the auto-enroll bridge as the
  PRIMARY mechanism and said the orchestration layer "detects and **invokes**" a
  walled machine's enrollment. It read as a clean "WS5.2 owns the credential, I just
  trigger it" delegation, and the product promise was stated as "user logs in once /
  zero ongoing per-machine burden."
- **Converged:** three material decision-completeness findings forced a sharper,
  honest design:
  1. **The bridge cannot auto-fire enrollment.** WS5.2's load-bearing invariant is
     that enrollment is operator-initiated, PIN-authenticated, and **never
     mesh-authenticated** (a peer can never enroll an account onto itself via the
     mesh; a build test enforces it). §5A now **surfaces an operator-PIN-initiated
     offer**, never an agent/mesh-fired mint (**D14**).
  2. **The bridge's target does not exist in code yet.** WS5.2 Mechanism B is
     `converged` but unbuilt (zero source for `accountFollowMe`/`enroll-drive`/
     `canServe`). So the **buildable-now scope is the orchestration layer only**
     (§5.1 serveability + §5.3 quota-aware seat-transfer failover + §5.4 honest
     degradation); the §5A bridge is **deferred behind WS5.2's build**, shipping as
     a detect→operator-attention-offer stub that never blocks on the missing
     mechanism (**D16**).
  3. **The bridge implicitly assumed an unresolved transport.** Pinned to WS5.2 R6a
     **option (2)** — operator-side per-server selection, no new `enroll-drive` mesh
     verb (**D15**).
  Plus an honesty fix to the §3 product promise ("agent-assisted per-machine
  enrollment + quota-aware placement," not "one login that silently spreads"), and
  the §5B seat-transfer layer is named as the mechanism that delivers the seamless
  reply in the meantime.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 (re-converge over §3 reframe) | decision-completeness (M1/M2/M3); lessons-aware (1 minor boundary); codex/gemini (minor) | 3 | Added D14/D15/D16; rewrote §5A as operator-initiated + deferred (build-order banner); §3 honesty fix |
| 2 (confirm) | decision-completeness (confirm: CONVERGED); codex (minor: phrasing); gemini (minor) | 0 | One §3 wording-honesty qualifier (non-material) |
| 3 | (converged) | 0 | none |

Standards-Conformance Gate: ran (0 flags — 22 standards checked, registry canary ok), both rounds.

## Full Findings Catalog

**Iteration 1 — material (decision-completeness):**
- **M1 (material → resolved by D14):** §5A "detects-and-invokes enrollment" collided
  with WS5.2's "never mesh-authenticated" invariant. Resolution: bridge is
  detect→operator-PIN-initiated offer; agent surfaces, never auto-mints.
- **M2 (material → resolved by D16):** WS5.2 Mechanism B unbuilt; bridge had nothing
  to call. Resolution: buildable scope = orchestration layer only; §5A deferred
  behind WS5.2's build; stub never blocks.
- **M3 (material → resolved by D15):** bridge assumed unresolved R6a transport.
  Resolution: R6a option (2), operator-side per-server, no new mesh verb.

**Iteration 1 — minor/cosmetic (lessons-aware):** R6a-dependency naming (folded into
D16); per-machine-approval cold-start honesty (folded into §3/§5.4 framing); canServe
↔ C3 freshness (noted; admission-revalidation D8 already bounces stale canServe so no
dead reply — non-blocking); frontmatter `lessons-engaged` refresh (cosmetic). Foundation
audit: WS5.2 Mechanism B itself is sound to build the bridge on (deny-by-default,
operator-PIN-rooted, C1/C2-preserving) — the only unresolved foundation item was R6a,
now named (D15).

**Iteration 1 — minor (codex/gemini externals):** "seamless/logs-in-once" overstated
after Decision A → §3 honesty fix applied. gemini: "fundamentally sound, strong C1/C2
handling, commendable security focus" — no actionable finding.

**Iteration 2 (confirm):** decision-completeness verified M1/M2/M3 resolved, §5A
consistent with D14/D15/D16, §12 "(none)" legitimate, no new material stop-point for
the orchestration-only building agent. codex/gemini: minor only.

## Convergence verdict

Converged at iteration 2 (confirmed). No material findings in the final round; Open
questions = none (all resolved into §4 Frontloaded Decisions D1–D16). The
**orchestration-only scope (§5.1/§5.3/§5.4) is decision-complete and buildable today**
against the proven `/pool/transfer` + `OwnershipApplier` + capacity-heartbeat
primitives; the §5A auto-enroll bridge is a named deferral behind the WS5.2 build.
Spec is ready for build under the orchestration-only scope.
