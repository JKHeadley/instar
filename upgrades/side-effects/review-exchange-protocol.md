# Side-effects review — ReviewExchange protocol (coordination-mandate spec §7, G2.3)

Spec: `docs/specs/coordination-mandate.md` (approved by Justin, A/A/B, 2026-06-05) — §7
names G2.3: "autonomous code-review protocol over Threadline, gated by the
`sign-code-review` authority". Change: new `src/coordination/ReviewExchange.ts` engine +
six `/review-exchange*` routes wired through the existing coordination block in
`AgentServer` → `RouteContext`.

## 1. Blast radius

Additive only. No existing route, gate, store, or sentinel is modified. The engine rides
the EXISTING MandateGate — it adds no new authority kind, no new signing key, and no new
trust root. Inert by inheritance: with no mandate issued (the universal state at deploy),
every sign-off path refuses 403, so shipping this changes NO behavior until the operator
issues a mandate AND an agent drives an exchange.

## 2. State / data

One new file under the `.instar/state/` convention, created on first use:
`review-exchanges.json` (the exchange records). No schema migration; an absent file is an
empty list. Audit entries land in the EXISTING `mandate-audit.jsonl` hash chain (the gate
records them; this engine only stores the returned entry hashes).

## 3. Security model

- **No new authorization surface.** Both sign-offs (peer approve + owner countersign) are
  evaluated through the same MandateGate (`sign-code-review` authority): named party,
  bounds, expiry, revocation — every decision audited. A deny refuses the state
  transition; the route surfaces it as 403 with the gate's reason (gate-deny precedence
  over not-found, so deny-by-default cannot masquerade as a 404).
- **requester ≠ authorizer preserved.** The exchange routes are Bearer-gated (no PIN by
  design): creating/recording an exchange delegates nothing — the GATE is what authorizes
  sign-offs, and the gate's authority comes only from the PIN-issued mandate.
- **Peer asymmetry stated, not hidden.** The peer's instance may not run this engine, so
  the peer's signature is their authenticated Threadline verdict message recorded BY
  REFERENCE (`kind: 'authenticated-peer-verdict'`, evidence = the message ref). The gate
  still evaluates the peer's fingerprint identically. The caller is responsible for only
  recording verdicts that actually arrived over the authenticated relay — the same trust
  the existing A2A surface already places in the relay's sender authentication.
- **Content addressing.** `packageSha256` is fixed at creation and has no update path; a
  changed package is a different exchange. `request-changes` is terminal — rework
  restarts as a new exchange, so a stale approval can never be replayed onto new code.
- **Kill switch reaches the protocol.** Revoking the mandate mid-exchange blocks every
  subsequent sign-off (tested at unit + e2e tiers).

## 4. Failure modes

- Engine init failure → `coordination` stays null → all routes 503 (deny-safe, no boot
  block; same try/catch as the mandate engine).
- Torn/absent state file → empty list (`@silent-fallback-ok` annotated).
- A gate deny mid-protocol leaves the exchange in its prior state (no partial advance) —
  asserted by tests on both deny paths.

## 5. Test coverage

11 unit + 7 integration + 4 e2e (22 total): both sides of every decision boundary —
creation validation, linear-order enforcement, gate-deny on both sign-offs,
deny-by-default with no mandate, named-party refusals (stranger AND wrong-party), bounds
mismatch, request-changes terminality, revocation mid-exchange, audit-hash wiring
integrity on the production boot path, 503 when unavailable.
