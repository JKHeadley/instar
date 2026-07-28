# Convergence Report — The Agent Carries the Loop (agent-owned-followthrough, C1+C2)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex `gpt-5.5`) ran in rounds 2–5; gemini `gemini-2.5-pro` ran in rounds 2–4 and degraded (call failed) in round 5. At least one genuine non-Claude external opinion was obtained every round — clean RAN. Round-5 codex returned 4 MINOR refinements, all folded into v6.

## ELI10 Overview

When the agent promises to do something, that promise has to actually get done by the *agent* — the human should never have to remember to chase it. Today two things break that: the agent sometimes quietly hands its own job back to you ("tracked — your call"), and the agent's own old promises pile up unfinished because nothing brings them back.

This change makes follow-through structural. Every commitment now records two separate facts: **who drives it** (the agent, or — rarely — you) and **what it's waiting on** (nothing / an outside system / your input / your approval). If it's the agent's to do, the agent does it and you hear nothing until there's a real result. You're pinged for exactly two things: a finished result, or a genuine approval only you can give. Nothing can get silently stuck: if the agent is waiting on something outside its control, it must keep showing real evidence it checked, and if it ever goes quiet past a set time (or waits unreasonably long), you get exactly one honest heads-up — never a nagging stream, never silence. Old stale promises are cleaned up only with hard proof they're done; anything unclear is re-driven or surfaced once, never silently deleted.

The bigger, security-sensitive idea Justin also raised — letting the agent *earn standing permission* so it stops re-asking for the same approval — is split into a separate, carefully-reviewed follow-up (a real tracked commitment, CMT-1505, drives it). Three rounds of review showed that part rewires the authority/permission machinery much more deeply, and bundling it would rush the most security-critical surface. It's not dropped — it's registered and inherits all the review findings.

## Original vs Converged

- **Originally** the spec was one combined feature (commitment ownership + near-silent follow-through + an *autonomy ratchet* that minted standing permissions). Review proved the ratchet was the dangerous part and didn't fit the existing authority model — so it was **split out** into a tracked follow-on, leaving a clean, self-contained fix here.
- **Originally** a commitment had a single binary "owner" — which mislabeled "waiting on a vendor" and "I need your input" as fake agent-agency. Now **owner and blockedOn are two separate fields**, so external-waiting and genuine user-input are never confused with agent work.
- **Originally** "the agent owns it ⇒ never message the user" had a hole: a commitment could park silently forever as "monitoring." Now there's a **hard window dead-letter + an absolute ceiling** so a forever-wait always surfaces exactly once, and a falsifiable dependency-probe keeps a genuinely-active wait alive only up to the ceiling.
- **Originally** the spec assumed beacon messages flowed through the outbound tone gate — they don't (`isProxy` bypass). Now suppression is enforced **inside the beacon** at a single chokepoint, and terminal failures always surface via the Attention dead-letter (never swallowed, never status-spam).
- **Originally** state was blanket-immutable; now legitimate transitions go through a **guarded endpoint that re-runs the gate** (no close-and-reopen).

## Iteration Summary

| Round | Reviewers | Material findings | Spec change |
|---|---|---|---|
| 1 | 6 internal + conformance gate | ~30 | v2 — ratchet reshaped onto the PIN-anchored mandate; spawn brakes; evidence-gated reconciler; migration; dark rollout; Frontloaded Decisions |
| 2 | 6 internal + codex + gemini | ~11 | v3 — owner⟂blockedOn ("fake agency"); honest narrow-extension ratchet; beacon isProxy fix; always-ask allowlist; aggregate-ceiling; drift governor |
| 3 | 6 internal + codex + gemini | C3-rooted cluster (decision-completeness CONVERGED, scalability ZERO) | **Scope decision: split.** C1+C2 fixes applied (external-block governor, emit chokepoint); C3 carved to §11 |
| 4 | 6 internal + codex + gemini | 3 dimensions CONVERGED; 6 small precision findings | v5 — external-block reframe; transitionViolated→Attention; actionClass-inert; enum-clamp-net-new; status-proposed mechanism; Close-the-Loop commitment (CMT-1505) |
| 5 | 6 internal + codex (gemini degraded) | **6/6 internal CONVERGED, zero material**; codex 4 MINOR | v6 — folded codex minors (external-session existence; absolute ceiling; durable-job-table comparison; guarded transitions) |

## Full Findings Catalog (condensed)

**Round 1 (v1→v2):** ratchet unaudited grant path → reuse PIN-anchored mandate; inverse gate asymmetry; spawn-storm risk; reconciler auto-close hazard; migration deferred; no observability; no Frontloaded Decisions. All addressed in v2.

**Round 2 (v2→v3):** [CRITICAL] ratchet substrate grants a human Slack user, not an agent; [HIGH] always-ask floor cited the wrong exclusion; [HIGH] inverse gate can't run at record(); [CRITICAL] beacon `isProxy` bypasses the tone gate; [external/codex] binary owner = "fake agency". Addressed in v3 (owner⟂blockedOn; honest narrow-extension; allowlist; beacon-local suppression; aggregate ceiling; drift governor).

**Round 3 (v3→split):** decision-completeness CONVERGED; scalability ZERO new. Remaining material all C3-rooted (gate fails-open + FloorAction-blind + no agentFp; FloorAction taxonomy phantom; authProof coverage; server-bound agentFp). → Scope decision: split C1+C2 from C3; C1+C2 fixes (external-block staleness governor; emit chokepoint) applied.

**Round 4 (split→v5):** security/scalability/decision-completeness CONVERGED; carve-out judged legitimate. Precision findings: [adv A] external-block probe unenforceable + no covering invariant; [adv C] transitionViolated kind unassigned; [adv/int D/F5] actionClass-inert + interim auth surface; [int F1] enum-clamp net-new; [int F6] eli16 missing + status-proposed mechanism; [lessons R4-1] Close-the-Loop cadence. All folded into v5.

**Round 5 (v5→v6):** all 6 internal reviewers CONVERGED, zero material (conformance gate 0). codex 4 MINOR (external-session existence; probe false-liveness ceiling; durable-job-table comparison; immutability too rigid) folded into v6. gemini degraded (non-blocking; codex carried the external pass).

## Convergence verdict

**Converged at round 5** (folded codex's round-5 minor refinements into v6). All six internal reviewers returned zero material findings; the conformance gate returned zero findings on v4/v5/v6; the external pass ran every round with only minor, now-incorporated refinements. `## Open questions` is empty; FD1–FD5 are real frontloaded decisions; the C3 carve-out is a legitimate tracked follow-on (CMT-1505 drives it). The C1+C2 spec is ready for operator review + the one ratification item (the "The Agent Carries the Loop" constitution article).

One non-blocking build-time hardening recorded for the implementer: enforce the absolute external-wait ceiling (§4.4) as a deny-by-default at build, and ensure the probe-content quality is observable (`lastProbe.at` age readable via `GET /commitments`).
