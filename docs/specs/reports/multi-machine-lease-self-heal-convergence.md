# Convergence Report — Multi-Machine Lease Self-Heal & Preferred-Awake

## ⚠ Cross-model review: UNAVAILABLE

No supported external (non-Claude) reviewer was installed/authed on this agent (`codex`/`gemini` not present
anywhere on PATH — verified). Convergence ran on the six internal Claude reviewers ONLY (the Standards-
Conformance Gate was also unavailable: the shadow-install server cannot read the dev-clone spec path — fail-
open, noted). This is a genuinely single-framework agent (no non-Claude framework in the activation history),
so `unavailable` is the honest, legitimate posture — not a skipped external pass. Remediation if a cross-model
pass is wanted before merge: `npm i -g @openai/codex` + `codex login`, then re-run convergence.

## ELI10 Overview

When you run the same agent on two computers, one is supposed to be the "captain" (awake, answering messages,
running scheduled jobs) and the other on standby. A live incident showed the two machines ending up with NO
captain at all — and unable to fix it themselves. The part that picks the captain had quietly frozen 91
minutes earlier (a network call inside it hung forever and jammed the loop), and nothing restarted it. So
messages still arrived but scheduled work stopped, and the standby machine couldn't take over because the dead
captain still "looked alive."

This spec adds four fixes. The big one (ON by default, because it's safe) gives every network call in the
captain-picking loop a 20-second timeout so it can never hang the loop again, plus a watchdog that restarts the
loop if it ever goes quiet — carefully, so it never interrupts a call that's merely slow and can never crash
the program. The other three ship OFF until proven on the real pair: let a standby take over a captain that's
secretly stopped working (measured on the standby's OWN stopwatch so the two computers' clock differences can't
cause a wrongful takeover — a bug we actually caught in the first draft of this very spec); make a machine hand
back the "captain" title when you mute it instead of holding it as a zombie; and let you name a preferred
captain (the stationary Mini) that the traveling laptop defers to.

The tradeoff is added complexity in a delicate "who's the boss" system, so everything risky ships dark and is
verified on the real Mini+laptop pair by deliberately CAUSING the fault (including running one machine's clock
fast on purpose), never by waiting for it.

## Original vs Converged

The original spec had a **genuine, ship-stopping bug that multi-angle review caught before any code was
written**, plus several safety gaps:

- **F2 was fundamentally broken.** It detected "is the captain still renewing?" by reading the lease's
  `acquiredAt` timestamp — but five of six reviewers independently checked the source and found `renew()` never
  refreshes `acquiredAt` (only `expiresAt`). So the original gate would have judged EVERY healthy captain as
  "not renewing" four minutes after it started and stolen the job from it. The converged spec detects
  non-renewal from a **locally-clocked signal** (the standby watches the captain's signed message counter
  advance on the standby's own monotonic clock) — no cross-machine clock comparison, so clock drift can't
  cause a wrongful takeover, and it's unforgeable (the counter is inside the cryptographic signature).
- **F1 targeted the wrong mechanism.** The original led with "restart the frozen timer." Review showed the real
  cause is a hung network call leaving a lock stuck — so the converged spec leads with a **bounded timeout**
  (the actual cure) and demotes the watchdog to a backstop, with the honest admission that a true whole-program
  freeze is handled by the separate out-of-process watchdog, not this one.
- **F4 (preferred captain) could be turned into an attack.** Originally any machine's local config could name
  itself preferred and win. The converged spec validates the name against the cryptographically-verified
  machine registry, requires both machines to AGREE, only lets a preference WITHDRAW a machine from contention
  (never force a peer awake), and only honors a preferred machine while it's actually healthy.
- **F3 (hand back the title) couldn't actually fire** as originally written (config changes need a restart;
  the relinquish didn't broadcast). The converged spec makes it level-triggered and adds a properly-SIGNED
  "released" record (a round-3 finding: the "released" bit had to be inside the signature or a relay could
  strip it).
- Added: a complete `## Frontloaded Decisions` table (every tunable has a value + justification), the fix
  routed to the correct migration mechanism (`ConfigDefaults.ts`, seeding `leaseRole` concretely to retire an
  overloaded flag), a deterministic injected-fault live test, and full Agent-Awareness wiring.

## Iteration Summary

| Iteration | Reviewers | Material findings | Spec changes | Standards-Conformance Gate |
|-----------|-----------|-------------------|--------------|----------------------------|
| 1 | security, adversarial, scalability, integration, decision-completeness, lessons-aware | 2 CRITICAL, 5 HIGH, 7 MEDIUM, several LOW | F2 redesigned (monotonic signal), F1 reordered (bounded-await primary), F3 level-triggered, F4 agreed+health-gated, leaseRole mode, ConfigDefaults migration, Frontloaded Decisions, consolidation, deterministic live test | unavailable (server can't read dev-clone spec) — fail-open |
| 2 | adversarial, lessons-aware, decision-completeness, security | 1 HIGH (churn threshold un-set), 3 MEDIUM (dwell/resolver race, gossip integrity, tombstone representation), several LOW | churnDetector frontloaded (D11-D14), gossip integrity (withdraw-only, auth-verified), tombstone wire type, withTickTimeout helper, leaseRole seed, validation floors | unavailable — fail-open |
| 3 | adversarial, decision-completeness | 1 HIGH (tombstone `released` bit not signed) | `released` added to the signed canonical tuple + back-compat-by-omission + tamper test | unavailable — fail-open |
| 3 (confirm) | adversarial (focused) | 0 | locked the omit-when-false canonicalization invariant | — |

## Full Findings Catalog

The complete round-1 findings (with severities, reviewer perspectives, and resolutions) are preserved at
`docs/specs/reports/multi-machine-lease-self-heal-findings-r1.md`. Round-2 and round-3 findings and their
resolutions are summarized in the Iteration Summary above and embedded in the spec's converged text (each
addressed bullet cites its finding id: C1, C2, H1-H5, M1-M7, M-R2-1/2/3, N1-N5, and the round-3 tombstone-
signing HIGH). Highlights:

- **C1 (CRITICAL, 5 reviewers):** F2 keyed on never-refreshed `acquiredAt` → would steal healthy leases.
  RESOLVED: locally-observed monotonic nonce-watermark signal; regression test enshrined.
- **C2 (CRITICAL):** F1 same-loop watchdog can't fix a hung-await stall. RESOLVED: bounded-await primary,
  watchdog backstop, true-loop-stall delegated to layer-2 fleet watchdog.
- **H1/H2 (HIGH):** F4 unauthenticated/divergent config + frozen-preferred-wins. RESOLVED: registry-validated,
  agreement-gated, health-gated, withdraw-only, lower-machineId fallback.
- **H3 (HIGH):** F3 couldn't fire + didn't broadcast. RESOLVED: level-triggered + `relinquishAndBroadcast()`.
- **Round-3 HIGH:** tombstone `released` bit outside the signature → strippable/injectable. RESOLVED: signed
  into the canonical tuple with back-compat-by-omission + tamper test.

## Convergence verdict

**Converged at iteration 3 (with a focused confirmation round).** The final review round's only material finding
(the tombstone signature-coverage HIGH) was resolved, and a focused adversarial confirmation returned
"CONVERGED — the tombstone fix is complete and introduces nothing new," with the one load-bearing
implementation invariant (omit-when-false canonicalization) now baked into the spec. Decision-completeness
independently returned "CONVERGED — decision surface complete, zero open questions." No material findings
remain; zero unresolved `## Open questions`. The spec is ready for user review and approval.

**Note on assurance:** this converged WITHOUT an external (non-Claude) cross-model pass (unavailable on this
agent). The internal six-reviewer panel was unusually effective here — it caught a genuine ship-stopping
correctness bug (C1) by reading source — but the operator should weigh the absent external opinion when
applying `approved: true`.
