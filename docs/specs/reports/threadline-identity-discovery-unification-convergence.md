# Convergence Report — Threadline Identity-Discovery Unification

## ELI10 Overview

Agents on the Threadline network find each other by looking up an "address book" entry
(`agent-info.json`) and a health check. The bug: those entries were publishing the *wrong*
address — an old key from a file (`identity-keys.json`) that the message relay doesn't
actually route by — while the relay was delivering to a *different* address (the one in
`identity.json`). So when Dawn looked up Echo and sent a message, it went to a dead address
and vanished, even though Echo's relay connection was perfectly healthy. This is fleet-wide:
any agent whose two identity files drifted apart hands out a dead address.

The fix makes discovery advertise the *same* identity the relay actually answers to —
publishing a proper `fingerprint` field (the routable address) and making the published
public key match it, sourced from the one canonical identity the relay client uses. Existing
agents are repaired through the update path. We deliberately do NOT merge the separate
end-to-end-handshake key (a different security layer) — merging it could break trust
relationships agents already established.

## Original vs Converged

The original spec said "resolve the canonical identity and feed it to discovery" — correct
in spirit but underspecified in two ways that review caught as **blocking**:

1. **Which identity, exactly.** The first draft talked about "the canonical relay identity"
   abstractly and implied reading `relayClient.fingerprint`. Review proved `relayClient.fingerprint`
   is `null` until the relay connects (which happens *after* discovery announces), and that
   there are actually 3–4 identity files in play. The converged spec names the exact API —
   `IdentityManager.get()` (read-only, no-create) — the same call the relay client uses, so
   the two can never re-diverge.

2. **The public-key field.** The first draft would have *added* a `fingerprint` field while
   leaving the existing `publicKey` field as the old legacy hex key — meaning the entry would
   describe two different identities, and a verifier assuming they correspond would fail. The
   converged spec sets `publicKey` to the canonical key too, so `fingerprint ===
   computeFingerprint(publicKey)` — internally consistent.

The converged spec also added: a strict **no-fabrication** rule (use `.get()`, never
`getOrCreate()`, so a relay-less or locked-encrypted agent omits the fields instead of
inventing a dead address), an encrypted-identity boundary with tests, a documented
multi-machine hazard (tracked to the cross-machine spec, not solved here), and a reframing of
the migrator as a narrow-window belt-and-suspenders since the boot-time announce rewrite
already self-heals on the post-update restart.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | conformance-gate (0), lessons-aware, adversarial+integration | 2 blocking (F1 resolution-source, #6 publicKey consistency) + 4 material (F2 encrypted boundary, #1 no-fabrication, #3 multi-machine, #4 migrator redundancy) + 3 minor (cite recurrence, agent-awareness, supervision tier) | Rewrote to v2: named IdentityManager.get(); made publicKey consistent with fingerprint; added no-fabrication + encrypted-boundary; documented multi-machine + tracked; reframed migrator; added lessons-engaged, Agent Awareness, tier0 |
| 2 | conformance-gate (0), convergence-check | 0 material | none — verified IdentityManager.get() exists (read-only, no-create) and resolves the design's load-bearing dependency |

## Full Findings Catalog

**Round 1 — Conformance Gate (code-backed, reads STANDARDS-REGISTRY.md):** 22 standards
checked, 0 findings, not degraded. Registry canary OK.

**Round 1 — Lessons-aware (BLOCKING/MATERIAL):**
- F1 (blocking): mis-named resolution source; must name IdentityManager + specify orphan-file
  fate. → Resolved: `IdentityManager.get()` named; orphan stops being advertised, deletion
  tracked separately.
- F2 (blocking): encrypted-canonical boundary uncovered. → Resolved: `.get()` returns null
  when encrypted; fields omitted; same resolver as relay client; tested.
- F3 (material): cite prior recurrence memory. → Resolved: `lessons-engaged` cites it.
- F4 (material): migrator idempotency + daemon-vs-server writer. → Resolved: idempotent,
  skip-if-null, both writers use the same resolver.
- F5 (minor): Agent Awareness. → Resolved: section added.
- F6 (design): "additive not unification" — sound boundary IF orphan file fate specified. →
  Resolved: scope fenced; orphan quarantined (no longer advertised), retirement tracked.
- F7 (minor): declare supervision. → Resolved: `supervision: tier0`.

**Round 1 — Adversarial + Integration (CRUX + BLOCKING):**
- #2 (crux): fingerprint is deterministic (`computeFingerprint(publicKey)`), available
  pre-connect; but `relayClient.fingerprint` is null until `connect()`. → Resolved: impl uses
  IdentityManager directly, never the client getter.
- #1: relay-disabled — `getOrCreate()` would fabricate. → Resolved: `.get()`, omit when null.
- #6 (blocking): publicKey-vs-fingerprint two-identity mismatch. → Resolved: publicKey sourced
  from canonical identity, consistency asserted in tests.
- #3: multi-machine same-fingerprint hazard. → Resolved (scoped): `machine` field set, hazard
  documented, full coordination tracked to cross-machine spec; fix is neutral for multi-machine.
- #4: migrator redundant with boot rewrite. → Resolved: reframed as narrow-window safety.
- #5 (security): exposing fingerprint/pubkey leaks nothing (public routing material). →
  Confirmed safe, no change needed.

**Round 2 — Convergence-check:** VERDICT CONVERGED. Verified `IdentityManager.get()` exists
(read-only, no-create, IdentityManager.ts:77-84) — the load-bearing dependency holds. All
round-1 findings resolved. No material new issues.

## Convergence verdict

Converged at iteration 2. No material findings in the final round. The conformance gate passed
clean both rounds (22 standards, 0 findings). Spec is ready for user review and approval.
