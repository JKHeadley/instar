# Convergence report — agent-driven-relogin (minimal first version)

## What happened

A larger redesign of this feature went through 18 review rounds (2026-09-23/24) without converging: each round's fixes added machinery the next round found fault with. The operator stopped that loop on 2026-09-24 08:04 PDT and approved a minimal first version, directing fractal 80/20 and Occam's razor, with "at most one light review round". This spec is that minimal version.

## Iteration Summary

- Round 1 (light, by operator direction): Standards-Conformance Gate: ran (5 flags) — folded: parent principle names the registry standards; label truncation discloses itself; maturation path test-agent → dev-agent → fleet declared; the destructive-phrase block cites the irreversible-action exemption; residual risk named. External cross-model review: codex-cli:gpt-6-astra (4 findings) — folded: credential-creating phrases blocked and agent navigation limited to sign-in drives; consent-capable controls offered only with measured, allowed, non-empty scopes; a fixed outbound schema with verbatim stripping of every resolved secret; a hard deadline raced against every model and browser call.

## Decisions

- The "agent" is an in-runtime model call choosing from a floor-filtered action list, not a spawned session: this removes the tool boundary, socket, hook and lock machinery the long design needed (Occam).
- Terminal and safety pages keep their deterministic handling; only navigation moves to judgment.
- Dev-gated (`navigation` omitted ⇒ agent on a development agent, closed on the fleet).

## Open questions

None.
