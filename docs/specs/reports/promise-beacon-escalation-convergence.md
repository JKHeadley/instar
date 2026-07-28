# Convergence Report — Promise-Beacon Escalation (#1093)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-5.5-tier external pass ran through the agent's own codex CLI on rounds 1–5 (clean RAN on every round). Gemini (gemini-2.5-pro) ran successfully on round 1 and degraded (timeout) on round 2; codex carried the external opinion thereafter. The spec received genuine, repeated outside-the-Claude-family review.

## ELI10 Overview

When the agent promises you something ("I'll send the link when it's live") it writes that promise down so it survives a crash. A background watcher (the PromiseBeacon) is supposed to keep the promise alive. The bug this spec fixes: when the *session* that made the promise dies, the watcher noticed but just marked the promise "broken" and went silent — so a real promise (CMT-1419) sat unfulfilled for 3.5 hours while the user heard nothing.

The fix adds the missing follow-through step: when a promise's session dies, the agent re-creates a live session to pick it back up, and if it can't, it sends an honest status instead of silence. The hard part — and what five review rounds were about — is doing this *safely*: the same agent just survived a meltdown caused by runaway loops, so reviving sessions is exactly the kind of thing that could re-melt the machine or take an unauthorized action on a stale plan. The converged design reviving a session grants **no new authority** (it's a normal session still bound by every existing safety gate, and side-effecting tools are *structurally blocked* until it re-checks its context), can't swarm (global concurrency budget + per-commitment backoff + hard cap), can't lie ("I can't resume right now" instead of a fake "still working"), and gives up loudly to the operator rather than retrying forever.

## Original vs Converged

The original draft had one dangerous idea: when a session died, **automatically resume the promised work** in a fresh session. Review (four reviewers independently) flagged this as handing too much authority to a background watcher — the promised action might spend money, use credentials, or act on hours-stale assumptions. The converged design keeps the *re-engagement* but removes the *authority*: a revived session is a normal session whose side-effecting tools are blocked by the external-operation-gate until it records an explicit revalidation step. "Status-first" went from a hopeful prompt instruction to an enforced gate state.

The original also had only per-commitment safety limits. Review showed those don't stop a *mass* session-death (10 sessions die → 50 promises each try to revive at once = the June-5 meltdown shape). The converged design adds a **global escalation budget** and a symmetric messaging budget so neither reviving nor messaging can flood.

Finally, several round-1 "guarantees" were honestly walked back under review: "crash cannot double-spawn" and "at most one session ever" were overclaims — under a network partition two sessions *can* briefly exist. The converged spec doesn't hide this: it detects double-spawns (a counter that's the rollout stop-signal), auto-reconciles to one session per topic, and documents the bounded Phase-1 residual.

## Iteration Summary

| Round | External verdict | Internal headline | Material findings | Spec change |
|---|---|---|---|---|
| 1 | codex SERIOUS / gemini MINOR | authority model; thundering-herd; durability | ~30 | major rewrite (authority §3.0, I9 budget, durable CAS counters, ResumeQueue coord, idempotency, prompt-injection, state-machine) |
| 2 | codex MINOR | revivalMode as enforced state; deadlock | ~8 | revivalMode gate (I13), escalationInFlight timeout contract, spawn idempotency (I14), Rung-2 digest (I12), §9 consistency |
| 3 | codex MINOR; decision+lessons CONVERGED | revalidation mechanism; Rung-2 spam bound | ~8 | server-recorded revalidation, bounded Rung-2 + owner-gone→Rung3, topic-lane fairness, lease-linearized CAS, operator metrics, foundation prereqs |
| 4 | codex MINOR | "claims phrased stronger than mechanisms" | 8 (precision) | honest scoping (revalidation/I8/§9), I11 enumeration, double-spawn counter governance, test-asserts-gate-not-model |
| 5 | codex MINOR; internal CONVERGED (clean sweep) | user-trust of truthful-but-ambiguous msgs | 5 (enhancement) | per-topic reconciliation, 5-state message taxonomy, staleness disclosure, metrics privacy, golden+report-only tests |

Standards-Conformance Gate: ran each round; returned `degraded (error)` (the live gate's LLM backend errored) — recorded honestly, non-authoritative, did not block (fail-open per skill).

## Convergence verdict

Converged at round 5. The internal reviewer panel (security, adversarial, scalability, integration, decision-completeness, lessons-aware) returned CONVERGED with a clean whole-spec consistency sweep; decision-completeness and lessons-aware had already converged at round 3. The core design has been stable since round 1's authority reframe — every round after that hardened edges and sharpened the honesty of claims, the textbook convergence shape. The external model's final-round findings were all enhancement-grade ("specify further / strengthen"), and the valuable ones were absorbed. The spec is ready for user review and approval.

The single most important thing the review process changed: it stopped the agent from giving a background watcher the authority to autonomously resume real work on a stale plan — replacing it with re-engagement under the gates the agent already trusts, with side-effects structurally held until a deliberate re-check.
