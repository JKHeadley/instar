# Convergence Report — Mesh Self-Heal (Lease↔Job Binding, Nobody-Polling Detection, Machine-Independence Standard)

## ⚠ Cross-model review: UNAVAILABLE

No supported external (non-Claude) reviewer was installed/authed on this machine (reason: `codex-not-installed`; remediation: `codex login` or install `@openai/codex`). Convergence ran on the six internal Claude reviewers + the constitutional Standards-Conformance Gate ONLY. The operator reads this banner before applying `approved: true`, so the reduced-assurance (internal-only) state is an informed choice, not a silent one.

## ELI10 Overview

This spec fixes a class of failures in running one agent across two machines (a Mac Mini and a laptop). The trigger was a real incident: the laptop held the "I'm in charge" badge and kept renewing it perfectly while quietly not fetching the user's messages at all — so every health check saw a "healthy" machine and the user's messages silently dropped. A manual recovery attempt then spun up a duplicate conversation that double-messaged the user.

The spec rests on two principles. First, holding the "in charge" badge must REQUIRE actually doing the job (fetching and serving messages) — a machine that stops doing the job drops the badge automatically, and an independent alarm catches "nobody is fetching" so that silent state can never sit unnoticed again. Second, no data the agent depends on may be stuck on one machine — it's either shared by default or transparently fetched on demand, so the user never hits a "that's on the other machine" wall (browser logins are handled the safe way: the agent knows which machine holds which login and routes there, instead of copying private cookies around).

The main tradeoffs: the design deliberately favors holding the badge slightly too long over dropping it wrongly (a wrong drop is the incident's inverse harm), and favors telling the user twice over telling them never. Nothing turns on until it's proven on the real two-machine pair with deliberately-injected faults — because synthetic tests with perfect data gave false confidence on this exact class of bug before.

## Original vs Converged

- **Originally**, the fix bound the badge to "is the holder renewing." Review showed renewing isn't the same as serving — the deeper issue is that the badge conflates "I'm the coordinator" with "I'm actually serving." The converged spec frames its fix as a deliberate INTERIM that converges with the codebase's planned coordinator/serving split, rather than adding a third overloaded meaning.
- **Originally**, the anti-duplicate check gated on a "who owns this topic" view. Review proved that view isn't trustworthy from the machine that needs it. The converged rule is simpler and robust: a machine serves a topic only if it genuinely holds the (fenced) badge, else it forwards.
- **Originally**, one health signal. The converged design uses three (am-I-trying / did-it-work / did-I-actually-deliver), so a total outage makes machines HOLD instead of both dropping the badge, and "fetched but not delivered" can no longer look healthy.
- **Originally**, the spec reinvented a "nobody's polling" detector and left "winning the badge → actually start fetching" unnamed. Review (verified against the live source tree) caught both: the converged spec reuses the existing detector and names the existing start/stop lever, with a check that fetching truly resumed.
- **Originally**, four open questions. The converged spec has zero — every build decision is frontloaded (14 committed defaults), so the build never stalls.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware | ~30 | Full rewrite: foundation notes (overloaded-lease/interim; spawn-on-fenced-lease), 3-signal liveness, single fenced authority, sign/allowlist all paths, reuse targets, Frontloaded Decisions table, Migration-Parity/Agent-Awareness/Observability/fail-direction/posture sections, injected-fault verification |
| 2 | security(4), adversarial(5), integration(4), scalability(0) | ~13 | post-CAS local-fitness recheck; global=positive-peer-evidence; reuse pollerCount/B5 + dual-veto; name poll-follows-lease actuation seam; live-machine escalation speaker; bounded drain; lazy-load cache integrity; operator-phone PII; FD2 arithmetic (540s) |
| 3 | lessons-aware(2), adversarial(4); decision-completeness(0), integration(0, code-verified reuse) | 6 | serve-progress separate cross-process record; pending=fetched>served counters; immediate self-demotion advertise; send-first escalation dedup; owner-death claim-reclaim; per-flag live-read declaration |
| 4 | adversarial(1), lessons-aware(0) | 1 | reconcile in-memory-vs-file posture for serve-progress; boot-epoch staleness guard; churn detector covers re-claims |
| 5 | (re-verify) | 0 | boot-identity marker clarity (sub-threshold) — **CONVERGED** |

## Full Findings Catalog

The complete per-finding catalog with severities and resolutions is preserved in the worktree alongside this report: `docs/specs/MESH-SELF-HEAL-SPEC.findings-round1.md` (~30, incl. the 2 blocking foundation findings C1/C2), `…findings-round2.md` (~13), `…findings-round3.md` (6). Each finding is tagged in the spec body at its resolution site (e.g. "round-2 Adv2-F2", "round-3 Les3-F1", "round-4 Adv4-B"). Headlines:
- **Foundation (round 1, blocking):** the awake-lease is overloaded → G1 is a deliberate interim converging with the L1/L3 split; gate spawn on the fenced lease, not an untrustworthy placement view.
- **Liveness (rounds 1–3):** three signals (attempted/succeeded/served), sourced from the lifeline's actual-poll truth (not server intent); global-blindness ⇒ HOLD requires positive peer evidence; pending judged from fetched-vs-served counters.
- **Authority (rounds 1–2):** the lease epoch is the single fenced authority gating poll-ownership AND spawn; G2 claim is single-claimant via CAS with a post-win local-fitness recheck.
- **Reuse, code-verified (rounds 2–3):** pollerCount.ts (B5) detector, effectivePollIntent actuation seam, lifeline-poll-active.json truth, WS1.1/WS2.6/Playwright-registry — all confirmed real in source.
- **Robustness (rounds 2–4):** bounded drain + owner-death reclaim; send-first escalation dedup; live-machine speaker; cross-process serve-progress record with a boot-epoch fence.
- **Standards (round 1):** Migration-Parity, Agent-Awareness, Observability, DARK_GATE_EXCLUSIONS, per-feature posture + fail-direction tables, injected-fault live-verification.

## Convergence verdict

**Converged at iteration 5.** The final round produced zero material findings across the re-verify pass, and the trajectory (30 → 13 → 6 → 1 → 0) shows clean convergence with no design or foundation breakage after round 1 — later rounds were progressively finer implementation-precision refinements. There are zero unresolved `## Open questions` (replaced by the §4 Frontloaded Decisions table). The spec is ready for operator review and approval. Cross-model external review was unavailable (internal-only) — see the banner. Pre-approved by the operator under the autonomy mandate; ready for `/instar-dev` build in rollout order G3 → G2 → G1.
