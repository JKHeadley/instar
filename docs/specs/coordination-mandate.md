---
title: "Coordination Mandate — bounded autonomous agent-to-agent authority without a per-action human operator"
status: approved
approved: true
approver: justin
approved-at: 2026-06-05T03:47:00Z
approval-mode: approved-as-is
review-convergence: 2026-06-05T03:00:00Z
review-iterations: 1
author: echo
created: 2026-06-05
parent-principle: "Signal vs. Authority"
spec-class: governance-safety
relates-to: feedback-factory-migration.md, sealed-handoff, threadline A2A
decision-record: >
  Justin's directional sign-off (topic 12476, 2026-06-05, "go with your picks") resolved the
  three §6 decisions A / A / B: (1) the irreversible cutover stays Justin's manual click — the
  mandate covers everything UP TO the flip, not the flip itself; (2) issuance is via the
  dashboard behind his PIN; (3) the first mandate carries only authorities 1–2
  (exchange-read-credential + sign-code-review) — execute-cutover is NOT delegated yet.
---

# Coordination Mandate

## 1. The problem

The feedback migration (and any future cross-agent project) keeps stalling on the **human
operator as a per-action bottleneck**:

- A credential exchange needs an operator confirm (the `requester ≠ authorizer` rail — an
  agent must not self-authorize a credential).
- Phase-1's code-owner review needs Dawn, and today Justin relays.
- The Phase-4 cutover needs Justin's explicit approval.

Justin's goal (2026-06-05): let **Echo and Dawn coordinate to finish the migration without
him in the loop**. The naive version — drop the gates — is unacceptable: it reintroduces
exactly the self-authorization vulnerability the `requester ≠ authorizer` rail exists to
prevent. We need a *sound substitute for the human operator*, not a removed safety rail.

## 2. The model

A **Coordination Mandate** is a human-authored, signed, bounded, conditioned, revocable,
audited delegation of *specific* authorities to a *specific* pair of agents for a *specific*
purpose and *bounded* time. It moves the human's authorization from **per-action** to
**standing policy + structural conditions** — without removing the human as the authorizer.

Seven load-bearing properties:

1. **The mandate is the authorizer — never the agent.** An agent acting under a mandate is
   not self-authorizing; it is executing a policy the *human* authored. `requester ≠
   authorizer` is preserved: the requester is the agent, the authorizer is Justin's
   standing mandate. The authorizer simply shifted from "human, per action" to
   "human-authored policy, checked per action".
2. **Human-authored + signed (un-forgeable).** A mandate is valid only if it carries
   Justin's authorship proof (signature / authenticated issuance). An agent cannot mint or
   widen its own mandate; a forged mandate fails verification. This is the structural lock
   that keeps property 1 true.
3. **Bounded.** The mandate enumerates *specific* authorities with *explicit bounds* —
   e.g. "exchange a **read-only** Portal cluster-read credential for the **feedback-migration**
   scope". Anything outside the enumerated authorities still requires Justin. No open-ended
   "the agents may do what they judge necessary".
4. **Conditioned on objective, machine-checkable gates.** High-risk / irreversible
   authorities are gated on conditions an agent *cannot fake* — e.g. the Phase-4 cutover
   authority fires only when `runIntegrityGate` passes AND the Phase-3 parity monitor
   reports zero invariant-divergence over the required window. Structure > Willpower applied
   to delegation: the agent can't decide it's safe, the gate decides.
5. **Revocable (kill switch).** Justin can revoke at any time; revocation is checked on
   every action and takes effect immediately.
6. **Expiring + scoped to a pair.** The mandate names the two agents by fingerprint and a
   scope, and expires (the migration window). It does not generalize to other agents or
   other work, and lapses on its own.
7. **Audited.** Every action taken under the mandate is durably recorded — which authority,
   which condition was satisfied, what was done, by whom, when — as a trail Justin reviews.
   Accountability after the fact is what makes ahead-of-time delegation safe.

## 3. Why this preserves the safety rail (the security argument)

The danger `requester ≠ authorizer` prevents is an agent minting/using a credential on its
**own** say-so. Under a mandate the agent acts on **Justin's** say-so: a policy he authored,
within bounds he set, on conditions he defined, revocable by him, audited for him. The human
is still the authorizer — ahead of time, at the policy level.

- An agent **cannot self-author** a mandate (property 2: authorship verification). So it
  cannot grant itself authority.
- Irreversible actions stay behind **objective structural gates** the agent cannot fake
  (property 4). The agent's "judgment" never authorizes the one-way door — the gate's
  verdict does.
- Everything is **revocable** (property 5) and **audited** (property 7): a misbehaving
  mandate is killable, and every action is reconstructable.

The threat that remains and is explicitly out of scope: if Justin's authorship key is
compromised, an attacker can author mandates. That is the same trust root as today (an
attacker with Justin's channel can already confirm actions) — the mandate does not widen it.

## 4. Concrete shape

```
CoordinationMandate {
  id: string
  scope: string                      // e.g. "feedback-migration"
  agents: [fingerprintA, fingerprintB]   // Echo + Dawn, by routing fingerprint
  authorities: Authority[]
  author: "justin"
  authorProof: <signature | authenticated-issuance token>
  createdAt, expiresAt: ISO
  revoked: { at, reason } | null
}

Authority {
  action: string                     // 'exchange-read-credential' | 'sign-code-review' | 'execute-cutover' | ...
  bounds: Record<string, unknown>    // e.g. { credentialScope: 'read-only', purpose: 'feedback-migration' }
  requiresCondition?: string         // e.g. 'integrity-gate-pass+parity-zero-divergence'
}
```

- **MandateStore** — persists mandate(s); verifies authorship on load; exposes the gate.
- **MandateGate.evaluate({ action, params, agentFp, mandateId })** → `allow | deny` +
  records an audit entry. Checks, in order: mandate exists + authorship valid + not expired
  + not revoked → the calling agent is a named party → an `Authority` matches `action` and
  `params` are within `bounds` → if `requiresCondition`, the named condition evaluates true
  (objective check) → allow. Any miss → deny (audited).
- **Audit trail** — append-only JSONL: `{ ts, mandateId, agentFp, action, decision, reason,
  conditionResult }`. Surfaced read-only (a `/mandate/audit` route + a dashboard view).
- **Conditions registry** — named, objective predicates (`integrity-gate-pass`,
  `parity-zero-divergence`) resolved from real state, never from an agent's assertion.

## 5. The specific mandate for THIS migration

Justin authors one mandate, then steps out:

> Scope `feedback-migration`, agents `Echo` + `Dawn`, until `<expiry>`:
> 1. **exchange-read-credential** — bounds `{ credentialScope: 'read-only', onMachine: true }`
>    (read-only Portal cluster-read creds, on-machine; no write/admin).
> 2. **sign-code-review** — bounds `{ artifact: 'migration-port', mutual: true }`
>    (Echo and Dawn may sign off each other's migration-code reviews).
> 3. **execute-cutover** — requiresCondition `integrity-gate-pass+parity-zero-divergence`
>    (the Phase-4 one-way door fires only when both objective gates are green).
> Revocable any time; every action audited.

## 6. Decisions (RESOLVED by Justin's sign-off — topic 12476, 2026-06-05, "go with your picks" = A / A / B)

1. **Cutover delegation depth (the key one).** → **A.** The mandate covers everything *up to*
   the cutover; the irreversible flip itself remains Justin's one explicit human click.
   `execute-cutover` is therefore NOT an autonomously-fireable authority — the agents prepare
   and gate-check, but a human authorizes the one-way door. (We may graduate to full
   auto-cutover later once the parity monitor has a track record; that is a separate future
   decision, not part of this mandate.)
2. **Authorship mechanism.** → **A.** Issuance + revocation are dashboard actions behind
   Justin's PIN — the existing human-authenticated surface. An agent's Bearer token cannot
   issue or widen a mandate; only a PIN-authenticated request can.
3. **Scope of the first mandate.** → **B.** The first mandate carries only authorities 1–2
   (**exchange-read-credential** + **sign-code-review**). **execute-cutover is NOT delegated**;
   the cutover stays entirely Justin's manual call for now (consistent with decision 1).

These resolutions are load-bearing for the build (§7): the enforcement ships with the
`execute-cutover` authority DEFINED but never issued in the first mandate, and the issuance
route is PIN-gated, not Bearer-gated.

## 7. Build plan (after sign-off)

- G2.2 — `MandateStore` + `MandateGate` + conditions registry + audit trail + the read-only
  `/mandate` routes. 3-tier tests (unit: gate decision boundaries; integration: routes;
  e2e: feature-alive + a denied-then-allowed action under a real mandate).
- G2.3 — autonomous code-review protocol over Threadline, gated by the `sign-code-review`
  authority.
- G2.4 — the parity-gated cutover executor, gated by `execute-cutover` (per decision 1).
- Agent-Awareness + Migration-Parity: CLAUDE.md template + `PostUpdateMigrator` entries so
  every agent knows the mandate surface and existing agents receive it.

## 8. Threat model (STRIDE) — how each attack is defended

A security-model change earns a real threat enumeration. Each row is an attack on the
delegation, mapped to the design element that defends it. The deny-by-default posture is the
spine: with NO valid mandate loaded, the gate denies every autonomous A2A action — so the
system is inert (weakens nothing) until Justin authors one.

| # | Threat (STRIDE) | Attack | Defense |
|---|-----------------|--------|---------|
| T1 | Spoofing | An agent forges a mandate to self-authorize | Authorship verification (property 2): a mandate is valid only with Justin's authorship proof; a forged one fails verification. The agent cannot mint authority for itself. |
| T2 | Tampering | An agent widens an existing mandate's authorities/bounds | The authorship proof covers the whole mandate; any field edit breaks it → invalid → deny. |
| T3 | Repudiation | An agent acts, then denies it / hides the action | Append-only audit (property 7): every gate decision (allow AND deny) is recorded with mandateId, agent, action, condition result, timestamp. See T8 for audit integrity. |
| T4 | Replay (expired) | A lapsed mandate is reused after its window | Expiry check on every action (property 6). |
| T5 | Replay (revoked) | A revoked mandate is reused | Revocation check on every action (property 5); revocation is immediate. |
| T6 | Elevation / wrong party | An agent not named in the mandate uses it | The mandate names exact fingerprints; the gate checks the caller is a named party. Combined with the relay's sender authentication of `msg.from`. |
| T7 | Spoofing (condition) | An agent fakes a precondition ("parity is green") to fire a conditioned authority | Conditions are evaluated from REAL state (property 4): `parity-zero-divergence` → `ParityMonitor.gate().cleared`, `integrity-gate-pass` → `runIntegrityGate().passed`. The agent's assertion is never the input — the objective check is. |
| T8 | Tampering (audit) | An agent with local write access rewrites the audit to hide an action | Mitigation: the audit is append-only + each entry carries a hash chain (entry N includes the hash of N-1), so a deletion/edit breaks the chain and is detectable. The chain head is surfaced read-only for Justin; an external sink (out-of-process) is a follow-on hardening. **Open hardening item — flag for review.** |
| T9 | Spoofing (peer) | A malicious peer (not Dawn) presents a valid-looking mandate over the relay | The mandate is bound to Dawn's specific fingerprint (T6) AND Threadline's per-peer trust + the #761 canonical-fingerprint thread-owner check apply. A different fingerprint is not a named party → deny. |
| T10 | Condition-of-convenience | An agent waits for a transient parity-green blip, then fires the cutover | The parity condition requires a sustained WINDOW (ParityMonitor: ≥N consecutive clean passes over ≥minWindowMs of real traffic), not an instantaneous read — a transient blip cannot clear it. Plus decision #1 (cutover-depth): if Justin keeps the irreversible flip as his click, T10 is fully closed for the one-way door. |
| T11 | DoS (revocation race) | An agent rushes an irreversible action between Justin revoking and the revoke taking effect | Revocation is checked synchronously at the gate immediately before the action; for the irreversible cutover specifically, decision #1's "human clicks the door" option removes the race entirely. A revoke also trips the parity/integrity re-check. |
| T12 | Out-of-scope trust-root compromise | Justin's authorship key is stolen → attacker authors mandates | OUT OF SCOPE — the same trust root as today (an attacker with Justin's channel can already confirm actions). The mandate does NOT widen this; it inherits whatever protects Justin's key/channel. Stated explicitly so it is a conscious acceptance, not a gap. |

**Residual / open items for the sign-off discussion:** (1) T8 audit integrity — hash-chain is
the baseline; an external/out-of-process audit sink is the stronger form (worth deciding
now vs. as a follow-on). (2) Decision #1 (cutover-depth) directly closes T10/T11 for the
one-way door if the flip stays human — the lowest-regret default. These are exactly why this
is a sign-off, not a solo build.
