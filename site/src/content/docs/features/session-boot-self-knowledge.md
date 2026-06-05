---
title: Session Boot Self-Knowledge
description: Every session boots knowing the agent's vault secret names and durable operational facts — no more re-asking for credentials it already holds.
---

An agent's encrypted vault is durable, but a fresh session's *awareness of the vault* is not:
sessions would ask the user to re-send a credential that was already stored, and claim
ignorance of channels (a logged-in browser seat, a machine-specific path) that earlier
sessions used every day. Session Boot Self-Knowledge closes that gap with a small,
deterministic "what I already have" block injected into every session's start context.

The block carries two things, wrapped in a `<session-self-knowledge>` envelope that marks it
as background signal (org-intent constraints, safety rules, and user instructions always win):

- **Vault secret NAMES — never values.** Flattened with the same derivation
  `/secrets/sync-status` uses, depth-capped so structured credentials never leak their
  internal shape, sanitized and size-bounded so a hostile key name cannot smuggle
  instructions. The rule it teaches: a secret named here is already in the vault — retrieve
  it with `node .instar/scripts/secret-get.mjs <name>` (the value pipes straight into the
  consuming command and is never echoed) instead of asking the user to re-send it.
- **Self-asserted operational facts.** Durable per-machine hints (a channel path, a seat,
  a non-obvious truth worth knowing at every boot), written through
  `POST /self-knowledge/facts` (auto-stamped with date and machine) and removed with
  `DELETE /self-knowledge/facts`. Facts are labeled unverified — hints to verify, not
  guarantees.

Vault honesty is a first-class rule: a vault that exists but cannot be decrypted is reported
as exactly that — with explicit "do NOT repair, rotate, or delete; surface to the operator"
guidance — never as an empty vault. (That distinction comes from a real incident where a
recoverable key mismatch read as "all secrets gone.")

The read surface is `GET /self-knowledge/session-context` (Bearer-auth; `?full=1` bypasses
the display caps). It ships **dark on the fleet** — the flag resolves
`enabled ?? developmentAgent`, so it is live on the development agent for the bake and a
deliberate one-line flip away from fleet-wide. The session-start hook injection is fail-open:
when the route is dark or unreachable, sessions boot exactly as before.

Spec: `docs/specs/session-boot-self-knowledge.md` in the instar repo (converged with a
cross-model external review; see the convergence report alongside it).
