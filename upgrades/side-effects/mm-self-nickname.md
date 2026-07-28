# Self-Nickname Convergence — Plain-English Overview

> One line: a machine now learns its OWN user-facing nickname from its peers, so "move it back to <this machine>" finally works.

## The problem in one breath

We shipped placement/transfer robustness, but live-testing on the real laptop+mini pair exposed that the fix was incomplete: the laptop couldn't resolve its OWN name "Laptop". Root cause — `updateNickname` (the dashboard rename) is local-only, so a rename applied on a peer's registry never reached the owning machine. The laptop's own capacity entry was `nickname=None` while peers correctly saw "Laptop". The relocation check runs on the holder (laptop), so it couldn't match "Laptop" → "move it back to the laptop" silently failed.

## What this adds

- **`SelfNicknameResolver` (pure)** — resolves this machine's own nickname: local capacity view → any PEER's view that names it (the drift backstop) → deterministic derive. Unit-tested incl. the exact asymmetry (self absent locally, present in a peer view).
- **Self-nickname convergence task (server)** — periodically (and at boot), if the local self-entry has no nickname, it fetches an online peer's `/pool`, finds what the peer calls this machine, and persists it via `updateNickname`. This makes `getCapacities()` SYMMETRIC, so the recognizer, the transfer route, and `/pool` all resolve self. No-ops once known.
- **Transfer route** now resolves the self-nickname via the resolver (was caps-only).

## The safeguards

- **Best-effort, never blocks** — convergence catches all errors (annotated `@silent-fallback-ok`); a failed peer fetch just retries on the timer.
- **No mis-routing** — adoption only happens when the local nickname is missing and a peer authoritatively names this machineId; `updateNickname` still enforces pool-uniqueness.
- **Tests** — Tier 1 (7 unit on the resolver incl. the regression), Tier 3 (e2e: transfer to THIS machine's own nickname resolves through the real AgentServer — 404'd before). `tsc` clean.

## Spec lineage

§L4 of the approved `docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md` (nickname-based placement/transfer). No new authority — a convergence read-model over existing nickname state.
