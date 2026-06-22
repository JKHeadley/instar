# Convergence Report — tmux Event-Loop Resilience

## Cross-model review: codex-cli:gpt-5.5

A real external (non-Claude) GPT-tier pass ran through the agent's own codex CLI on the converged
spec (`gpt-5.5`). Verdict: **MINOR ISSUES** — three precision refinements, all folded into the final
spec (no design change). gemini-cli was also detected available. This is the clean RAN state.

## ELI10 Overview

The agent's server kept freezing for ~15 seconds at a time because it asked the machine's shared
"tmux" session-manager questions in a way that blocks everything until tmux answers — and when the
shared tmux is slow (old, busy machine, another agent starting), every answer is slow. During each
freeze the dashboard showed "Disconnected," sessions read as zero, and (because a frozen-waiting
program burns no CPU) the agent wrongly logged "the machine slept." This is the 17-hour incident.

The change stops the server from freezing on tmux (status pages read a saved snapshot; only one
careful background loop asks tmux live, without blocking, and a slow/timed-out answer is treated as
"unknown — keep the session," never "dead — kill it"). It gives the sleep detector a reliable
"I'm stuck, not asleep" flag. And it raises one calm, bounded heads-up when tmux is truly degrading —
while NEVER auto-restarting the shared tmux (that would knock out every other agent; it's always a
human decision). A later separate step gives each agent its own private tmux so one agent's slowness
can't hurt the others — the real root fix.

Tradeoff: it's a sizable change to core session plumbing, so it ships behind a flag (off = today's
behavior, on for the test agent first) and turns on broadly only after a clean soak.

## Original vs Converged

The original draft said, essentially, "make the tmux calls async and improve the sleep detector."
Review showed that was both too little and dangerous-if-done-naively:

- **Originally** an async tmux call that timed out could be read as "session gone," which would make
  a *slow* tmux trigger spurious session kills — worse than the freeze. **Converged:** strict
  tri-state (present / definitely-absent / unknown-timeout), and every destructive action requires a
  POSITIVE "absent" signal; an unknown-timeout always KEEPS the session.
- **Originally** all the "improve the detector" signals were treated as interchangeable.
  **Converged:** two of the three candidate signals are documented NON-solutions for this case (a
  15-second freeze advances the wall clock just like a 15-second sleep), so the "in-flight marker" is
  mandated as the primary signal — a counter with a self-expiring timestamp, covering all sync
  subprocess calls via an enforced single chokepoint.
- **Originally** the fix targeted only the polling path. **Converged:** review found two bigger
  amplifiers (the wake-recovery handler and the supervisor's force-restart, which fires during a
  ~0-CPU block) and brought both into scope.
- **Originally** "refresh the tmux server" was an option. **Converged:** auto-restarting the SHARED
  tmux is forbidden by construction (it bounces all agents — the incident's own lesson); the guard is
  signal-only, load-gated, deduped, and bounded.
- **Originally** per-agent tmux isolation was a vague note. **Converged:** it's a separate increment
  with the irreversible migration decision frontloaded (new-spawns-only; live sessions stay put;
  deterministic per-agent socket name; every tmux consumer's adopt-or-stay decision named).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware | ~30 | Full rewrite — tri-state semantics, cache-served routes, marker-as-primary + TTL, stall-consumer-same-increment, amplifier conversion, signal-only-no-auto-kill, bounded EWMA, socket-isolation new-spawns-only + frontloaded migration, Migration Parity, guard-manifest registration, multi-machine posture |
| 2 | (none — all 3 reviewer groups + codex returned CONVERGED / MINOR) | 0 material | 3 minor codex precision folds (byte-identical→behaviorally-identical; SIGKILL≠server-heal; marker-coverage enforced + GC residual documented) |

- Standards-Conformance Gate: ran (0 at-risk flags) round 1.
- Cross-model: round-2 codex-cli:gpt-5.5 RAN (MINOR ISSUES, folded).

## Full Findings Catalog

**Round 1 (material, all resolved in the rewrite):**
- [high] async tmux timeout must NOT read as session-absent → tri-state; destructive actions
  positive-signal-only (security, scalability, adversarial, lessons).
- [high] request/health routes must be cache-served, not live tmux calls; bound in-flight +
  single-flight + SIGKILL; re-read state after await (scalability, security, adversarial).
- [critical] in-flight-sync-op marker must be the PRIMARY (B) signal, cover ALL sync callsites, be a
  counter with TTL + try/finally; wall-vs-monotonic struck as a non-solution (adversarial, lessons).
- [high] the `stall` event has zero consumers → (B)+(C) ship same increment (lessons).
- [high] wake-recovery handler + ServerSupervisor force-restart are amplifiers running sync tmux →
  convert/guard both (lessons).
- [high] no auto kill-server on the shared socket (bounces all agents) — signal-only,
  operator-authorized; breaker + settle window for the isolated-socket case (security, adversarial,
  integration, lessons).
- [high] socket isolation orphans live sessions + split-brains ~12 other tmux consumers → D4
  new-spawns-only + deterministic socket name + consumer adopt/stay decision (integration, security,
  decision-completeness).
- [med] latency storage bounded EWMA/ring (Bounded Accumulation); load-gate + dedup the attention
  item (scalability, adversarial, lessons).
- [med] Migration Parity (ConfigDefaults omit-enabled #1001 + migrateConfig + DEV_GATED_FEATURES);
  guard-manifest + guardRegistry registration; multi-machine machine-local + attention machine-tagged
  (integration, lessons).

**Round 2 (non-material):** all three internal reviewer groups → "CONVERGED — no material findings";
codex (external) → MINOR ISSUES (3 precision points, folded). Residual non-material edges noted and
accepted (marker TTL boundary for a sub-TTL real sleep; max-in-flight saturation — both fail safe by
positive-signal-gating + cache-served reads).

## Convergence verdict

Converged at iteration 2. No material findings in the final round (6 internal reviewers + codex
external). Open questions = none (D1–D7 frontload every build decision, including the irreversible
socket-isolation migration). Spec is ready for user review and approval. The BUILD is a sizable
multi-increment core change — Increment 1 (async cache-served hot path + marker-based detection +
signal-only degraded-tmux guard, all together) then Increment 2 (per-agent socket isolation).
