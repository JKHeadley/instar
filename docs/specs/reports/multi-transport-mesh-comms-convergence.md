# Convergence Report — Robust Multi-Transport Mesh Communication

## ⚠ Cross-model review: UNAVAILABLE

No supported external (non-Claude) reviewer was installed/authed on this agent
(`codex` and `gemini` both absent; no non-Claude framework in the 7-day
activation history — a genuinely single-framework agent, so the `unavailable`
floor is legitimate, not a skip). Convergence ran on the **six internal Claude
reviewers** (security, scalability, adversarial, integration, decision-
completeness, lessons-aware) + the **Standards-Conformance Gate** (ran every
round, 0 at-risk flags). Remediation if cross-model is wanted later: `codex
login` / install `@openai/codex`, then re-run a round.

## ELI10 Overview

When this agent runs on two machines (a stationary Mac Mini and a travelling
Laptop), they constantly check in with each other to agree on which one is "in
charge." Today they have only ONE way to reach each other — a Cloudflare tunnel —
and Cloudflare keeps dropping for a few seconds, which makes the Mini panic and
re-grab the "in charge" badge every two minutes. This spec gives the machines
several independent ways to talk (a private Tailscale network, the local wifi,
and the Cloudflare tunnel) and makes them automatically use whichever is working,
so losing one becomes a non-event and the panic-flap stops. It also adds a
careful safety net: if the Laptop is genuinely gone (silent past a real timeout,
not just briefly unreachable), the stationary Mini is allowed to keep the badge
by itself instead of thrashing — but only the stationary machine, only when the
other is provably silent, and always behind the existing cryptographic
"who's-really-in-charge" lock so two machines can never both think they're in
charge.

The sturdy parts (the extra ropes + automatic failover) ship turned ON because
they only ADD ways to connect. The "hold the badge alone" safety net ships turned
OFF by default and must be proven on the real two-machine pair before it's ever
switched on.

## Original vs Converged

The review process changed the design substantially — it caught that the first
draft's safety mechanisms were weaker than they looked:

- **"Hold the badge alone" was nearly unguarded.** The original gated it on three
  checks; review found ALL THREE were weak on the real hardware — one was a check
  that always returns "yes" on this exact machine, one read a config field a typo
  could break, and one read a view that is *blind* during the exact outage it
  fires in. The converged design replaces them with a single safe-by-construction
  gate: only hold alone when the other machine has been *silent past a real
  timeout* (provably absent, not merely unreachable), and even then never advance
  the lock — so a wrongly-presumed-gone live machine still cannot double-write.
- **Trying the ropes one-at-a-time was slow and could re-create the flap.** The
  converged design uses "hedged" requests: try the best rope first, and if it
  doesn't answer in 1.5s fire the rest in parallel — one request in the normal
  case, fast failover when needed.
- **A stranger on the same coffee-shop wifi could be mistaken for the Laptop.**
  The converged design verifies that the machine answering really IS your peer
  (cryptographic responder-identity), and that its answer is fresh (a
  challenge-response nonce), closing a replay hole that review found two layers
  deep.
- Added: a cap so a misbehaving peer can't make you dial a hundred addresses;
  URL-shape validation; the agent learning to explain all this to you; and a
  mandatory "physically unplug the Laptop and watch what happens" live test.

## Iteration Summary

| Round | Reviewers run | New material findings | Spec changes |
|-------|---------------|----------------------|--------------|
| 1 | 6 internal + conformance gate | ~33 (across reviewers; heavily overlapping) | Full rewrite: hedged failover, Layer-3 redesign (presumed-dead-by-liveness, F4-agreed, monotonic-fence-armed), maxEndpoints cap, URL-shape validation, responder-identity, peers()-filter fix, single-rope timeout carve-out, Tailscale execFile, health eviction, signed-in-body endpoints, version-skew section, CLAUDE.md + DARK_GATE artifacts |
| 2 | 6 internal + conformance gate | 4 (precision) | Accept-ack wire format + receiver-changes subsection; "provably gone" softened + epoch-CAS safety note; single-advertiser clarification; EWMA defaults; path-consistency |
| 3 | 4 internal (changed surface) + conformance | 1 (accept-ack freshness — raised by security AND adversarial) | reqNonce challenge-echo + epoch-equality + domain-separation prefixes; replay-rejection test |
| 4 | 3 internal (changed surface) | 1 (reqNonce parameters — raised by security AND decision-completeness) | reqNonce pinned: crypto.randomBytes(16), hex, CSPRNG |
| 5 | 1 internal (final sweep) | **0** | none — converged |

Standards-Conformance Gate: ran every round (0 at-risk flags each round).
Cross-model external pass: unavailable all rounds (single-framework agent).

## Full Findings Catalog (material findings + resolutions)

**Round 1 — architecture-level:**
- *Sequential failover wrong for hot path* (scale, HIGH) → hedged requests (Dec 3).
- *Timeout-division regression re-opens self-suspend* (scale/integration, HIGH) → per-attempt timeout undivided, hedge bounds the sweep (Dec 6).
- *Layer-3 condition #2 (`store.refresh`) is a tautology on LocalLeaseStore* (lessons, CRITICAL) → dropped store.refresh as evidence; gate on presumed-dead-by-liveness (Layer 3, Dec 13).
- *Layer-3 read a BLIND effective-view (unreachable≠absent)* (adversarial, HIGH) → presumed-dead-by-liveness via existing `presumedDeadHolders()`; monotonic fence stays armed otherwise.
- *Layer-3 used raw config not F4-agreed; both-set-self → both hold solo* (adversarial/lessons, HIGH) → F4-AGREED gate (Dec 13).
- *broadcast true-on-2xx, not on fold* (adversarial, HIGH) → verified accept-ack (Dec 9).
- *peers() filter drops endpoints-only peers* (integration, HIGH) → `(!!lastKnownUrl || endpoints?.length) && !e.revokedAt` (Dec 12).
- *No maxEndpoints cap (SSRF/timeout amplification)* (security, HIGH) → cap=4 on resolve (Dec 4).
- *Credential-allowlist already private-IP-permissive* (security, HIGH) → endpoints[] excluded from credential enumeration; sync keyed off public-HTTPS only.
- *SSRF via self-advertised URLs* (security, MED) → per-kind URL-shape validation on consume (Dec 7).
- *LAN RFC-1918 collision / stranger* (adversarial, MED) → LAN-subnet gate (Dec 8) + responder-identity (Dec 9).
- *Tailscale exec hardening / every-heartbeat cost* (security/scale, MED) → execFile + CGNAT regex + cache (Dec 16).
- *health-map unbounded growth (roaming LAN IPs)* (scale, MED) → keyed by (peer,kind) + TTL eviction (Dec 4).
- *dead-rope retry cost under sustained partition* (scale, MED) → exponential-backoff probe (Dec 5).
- *slow-rope pinning via deprioritize-not-drop* (adversarial, MED) → latency-aware demotion + hysteresis (Dec 5).
- *endpoints[] signed-canonical membership undecided* (decision-completeness/integration, MED) → signed in heartbeat body; registry mirror untrusted (Dec 10).
- *Agent Awareness (CLAUDE.md) update missing* (integration, MED) → generateClaudeMd + migrateClaudeMd required (Migration parity).
- *ConfigDefaults deep-merge hazard* (integration, LOW) → FLAT knobs + startup validation (Dec 14).
- *version-skew test missing* (lessons, MED) → §Version-skew posture + test.
- *monotonic-fence disarm via local confirm* (adversarial, LOW) → fence stays armed unless presumed-dead.

**Round 2:** accept-ack receiver is net-new (synchronous-fold + response-signing) → receiver-changes subsection + fail-closed; "provably gone" overstated → softened + epoch-CAS safety note; MeshEndpointAdvertiser vs MeshUrlAdvertiser race → single-advertiser clarification; EWMA window undefined → α=0.3 / 0.25 defaults.

**Round 3:** accept-ack not freshness-bound (recorded same-epoch ack replay) → reqNonce challenge-echo + epoch-equality + domain-separation prefixes; replay-rejection + higher-epoch-stand-down tests added.

**Round 4:** reqNonce length/encoding/RNG unspecified → pinned to crypto.randomBytes(16), hex.

**Round 5:** final sweep — no remaining un-frontloaded decision; Open questions genuinely (none).

## Convergence verdict

**Converged at Round 5.** Zero material findings in the final round; zero
unresolved entries in `## Open questions`; 16 frontloaded decisions, all with
concrete values and reversibility posture. The Layer-3 authority change is a
genuine signal-consumer (consumes existing liveness + F4-agreement + epoch
signals; adds no new brittle blocking authority) and ships dark + opt-in behind a
mandatory deterministic live-verify. Spec is ready for operator review and
approval.

**Note on assurance:** this convergence had no external (non-Claude) cross-model
pass (single-framework agent). The internal six-reviewer panel was thorough
(code-grounded against the real `LeaseCoordinator`/`HttpLeaseTransport`/
`machineAuth`), but the operator should weigh the absent outside opinion when
applying `approved: true`.
