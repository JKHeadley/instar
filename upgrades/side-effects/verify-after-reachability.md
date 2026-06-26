# Side-Effects Review — Verify-After Topic Reachability (F7 — core components)

**Version / slug:** `verify-after-reachability`
**Date:** `2026-06-26`
**Author:** `Echo (instar-dev agent)`
**Tier:** 2 (converged + approved spec: `docs/specs/verify-after-reachability.md`)
**Scope:** the two pure components (first commit) PLUS the server wiring (this commit):
Piece 1 (`spawningTopics` closure→`SpawningTopicsRegistry` refactor of the live inbound
path, token-guarded at all 4 callsites) and Piece 2 (the verifier constructed dev-gated,
triggered by `sessionReaped`, a conservative fail-safe probe, a 15s tick, NORMAL
attention surfacing, and `guardRegistry` registration). The probe is deliberately
CONSERVATIVE: a live session ⇒ reachable; a topic stuck-spawning past `stuckSpawnMs` ⇒
orphan; ANYTHING ELSE ⇒ reachable (the next inbound self-heals) — so it never
false-orphans an idle kill. The multi-machine released-no-placement + at-capacity orphan
cases (placement reads) and a dedicated `/topic-reachability` route are a tracked
follow-up; their absence means LESS coverage, never a false orphan (the probe fails safe
to reachable). <!-- tracked: topic-28744 F7-followup multimachine-probe-and-route -->

## What this commit adds

- `SpawningTopicsRegistry` (src/core) — token-tagged replacement for the closure-local
  `spawningTopics` Set: `add` returns a token, `clear` is token-guarded (the ABA fix so a
  late `.finally` from a superseded spawn cannot delete a newer entry), `stuckSinceMs`
  exposes in-flight age for the verifier. NO timeout, NO sweep — the `.finally` remains
  the sole clearer (round-2 proved any external clear relocates the double-spawn race).
- `TopicReachabilityVerifier` (src/monitoring) — the PURE-SIGNAL decision core: grace +
  per-topic coalescing, the reachable-honesty guard (a topic that will self-heal on next
  inbound is REACHABLE, not orphaned), NORMAL-priority surfacing with per-topic
  exponential backoff (flap cap), burst roll-up, pressure-skip + emergency-stop-suppress
  WITH a re-sweep on clear (no never-surfaced orphan). It MUTATES NOTHING.

Neither component is wired into the running server yet (no runtime surface), so this
commit is inert at runtime — pure library code under test.

## The 8 questions (for the components as committed)

1. **Over-block** — N/A. The verifier blocks nothing; it surfaces a signal. The registry
   only guards double-spawn (existing behavior), now ABA-safe.
2. **Under-block** — N/A.
3. **Level-of-abstraction fit** — Correct. Pure decision logic separated from the server
   wiring + live-state probe (the spec's design).
4. **Signal vs authority** — The verifier is a pure signal (zero mutation). The registry's
   only authority is the EXISTING token-guarded clear (no new clearer). Complies.
5. **Interactions** — None at runtime (unwired). The registry, once wired, replaces the
   closure Set; the token guard makes its clear idempotent/ABA-safe.
6. **External surfaces** — None yet (unwired). The future wiring adds a NORMAL attention
   item + a `/topic-reachability` status route + a `/guards` entry.
7. **Multi-machine** — The verifier's released-no-placement detection (future probe) is
   machine-local (reads the local placement snapshot, freshness-gated); machine-local BY
   DESIGN. The components themselves hold no cross-machine state.
8. **Rollback cost** — Trivial. Delete two new files + their tests; nothing references
   them at runtime yet.

## Tests

- `spawningTopicsRegistry.test.ts` (5): the ABA token-guard, `.finally` is the sole
  clearer (no timeout/sweep), `stuckSinceMs`, entries snapshot.
- `topicReachabilityVerifier.test.ts` (8): grace; reachable-honesty (no false orphan);
  orphan→one NORMAL item; pressure-skip+re-sweep; halt-suppress+re-sweep; flap backoff;
  burst roll-up; coalescing.
- `tsc --noEmit` clean.

## Rollback

Delete the two component files + tests. No runtime reference.
