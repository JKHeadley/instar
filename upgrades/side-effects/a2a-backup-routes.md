# Side-Effects Review — A2A backup routes

**Version / slug:** `a2a-backup-routes`
**Date:** `2026-10-07`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

Spec: docs/specs/a2a-backup-routes.md (v8, converged in 6 iterations; approved under the operator's standing approval for the agent-comms track, 2026-10-06 18:57, topic 122413). Depends on the inbound-id ledger already on this branch.

## Summary of the change

Two stateless per-send rules inside `POST /threadline/relay-send` (`src/server/routes.ts`), with the decision logic in a new pure module `src/threadline/backupRoutes.ts` so the tests run the same code:

1. **Marked fall-through.** A `localPostOutcome` is declared before the name path's `try` and set immediately before the `/messages/relay-agent` POST, whose `fetch` is wrapped in its own `try` (only its error code can prove a refusal). When the name path falls through after a POST, the relay leg passes the local attempt's `effectiveThreadId` and, unless `classifyFallthrough` finds proven non-admission (ECONNREFUSED on that fetch; HTTP 400/401/404; a 503 whose JSON says `error: 'ledger-unavailable'`), `resend: true`. No POST → unmarked and today's thread handling.
2. **Fingerprint branch.** An exact 32-hex target (case-folded) is classified before the name/nickname match and never feeds it: `selectFingerprintTarget` picks the single `known-agents.json` entry whose resolved fingerprint matches, de-duplicated by (fingerprint, port); the live `/threadline/health` must show the same fingerprint and `relay.state === 'connected'` (`checkFingerprintHealth`). A credential send, no match, two ports or any other health answer → the relay, unmarked; never the "Ambiguous target" 409.

Both behind `threadline.backupRoutes.enabled` (omitted ⇒ `resolveDevAgentGate`; read live via `liveConfig` then `config`), registered in `DEV_GATED_FEATURES`. One `[a2a-backup]` log line per marked fall-through and per fingerprint-local delivery; four in-memory counters on the authed `/health` (`threadline.backupRoutes`). Template + `migrateClaudeMd` section "A2A backup routes" (sniff key `A2A backup routes`, framework-shadowed); `ThreadlineConfig.backupRoutes` type. No ConfigDefaults entry (enabled omitted on purpose).

## Decision-point inventory

- Whether a relay fall-through is marked, and on which thread — **add** — invariant: marked unless in the enumerated non-admission set; always `effectiveThreadId` after a POST.
- Fingerprint branch — **add** — invariant: exact 32-hex, exclusive, de-duplicated, live fingerprint equal, `connected`, never for credentials.

---

## 1. Over-block

Nothing new is refused. The fingerprint branch can only add a local delivery; every doubt sends via the relay exactly as today. A fingerprint-addressed send whose sender relay is down and whose local precondition fails still answers today's 503 (unchanged).

## 2. Under-block

- Over-marking is deliberate: a copy that never reached the receiver but whose local answer was ambiguous (timeout, reset, other 5xx, other 4xx) carries `resend: true`; a ledger receiver then words its notice as a resent copy and, for a verified sender with no local row, asks its peers (bounded by the ledger's 8-peer / 500 ms cap) — the cost `peerCheckUnavailable` measures in the dev-agent soak.
- An unmarked copy after ECONNREFUSED / 400 / 401 / 404 / ledger-503 cannot be a repeat: none of those can admit the message.
- Name-addressed credential sends still use plaintext loopback when verified pairing is dark (unchanged; spec "What it does not do").

## 3. Level-of-abstraction fit

The rules live where the decision is made (the one relay-send route), with the pure classification factored into `backupRoutes.ts`. The relay leg's verdict recording is untouched — honest delivery owns that invariant.

## 4. Signal vs authority compliance

`resend: true` is a signal for wording only; the receiver's ledger keeps all authority over delivery. The live health answer is a self-asserted guard against mix-ups (stale port, standby), not authentication — the threat model scopes this to mistakes, not a hostile same-user process.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment-shaped decision point: both rules are closed enumerations (spec "Decision points touched": invariant).

## 5. Interactions

- `ThreadlineClient.sendAutoWithThread` already takes `(recipient, content, threadId, messageId, resend)`; with the gate off, or an unmarked fall-through, it is called with exactly the four arguments it received before.
- Inbound-id ledger (receiver): a marked copy with no local row triggers its bounded annotate-only peer read; a duplicate of an admitted id is labelled, never suppressed unless a verified terminal row exists (unchanged).
- The relay never saw the id, so the ledger's 5-minute replay wait does not apply; the relay leg is sent at once, as today.
- Conversation-discipline resolver and the negotiator gate run before the local branch and are unchanged; `effectiveThreadId` is their output.
- The two existing name-path tests (`relay-send-local-roundtrip`, `threadline-relay-send-priority`) pass unchanged.

## 6. External surfaces

Outbound: the relay copy's signed body may carry `resend: true` (ignored by non-ledger receivers). The fingerprint branch adds one unauthenticated GET of a co-located agent's `/threadline/health` per fingerprint-addressed send (it already happens for name-addressed sends). Authed `/health` gains `threadline.backupRoutes` counters. New `[a2a-backup]` server-log lines (id, peer fingerprint, kind, outcome label — no content).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Unified: a stateless rule applied per send on the machine handling it; nothing stored or replicated. The fingerprint branch delivers only to a same-machine server reporting a connected relay, so it never makes a standby act for the agent; receiver-side ownership gating (stand-down, etc.) applies exactly as for name-addressed local delivery.

## 8. Rollback cost

`threadline.backupRoutes.enabled: false` (read live, no restart) restores today's behaviour. A revert is safe: nothing new is stored, and `resend` was already an optional body field.

## Conclusion

The build follows spec v8 without design change. Clear to ship dark (dev-gated).

## Evidence pointers

- `tests/unit/a2a-backup-routes.test.ts` — marking set both sides, fetch-error mapping, exact-32-hex/selection/health rules, gate resolution, and the real route: every marked and unmarked outcome (incl. a genuine ECONNREFUSED on the POST, a reset, the in-flight 409, an ECONNREFUSED thrown after a 2xx), relay-leg thread with and without a caller thread, no-POST fall-throughs, fingerprint branch (case-folded, publicKey-derived, de-duplicated, two ports, name collision, shorter/longer hex, credential, five health failures, fingerprint POST failure), gate off (live and fleet), counters authed-only.
- `tests/unit/PostUpdateMigrator-a2aBackupRoutes.test.ts` — migration parity, template, no default, dev gate.
- `tests/integration/threadline/a2a-backup-routes.test.ts` — real RelayServer; receiver on real `bootstrapThreadline` + real on-disk ledger via `runRelayInboundWithLedger`: timeout → same thread + resent-copy notice; ECONNREFUSED → unmarked; in-flight 409 → marked; fingerprint local; standby / stale port → relay; sender relay down → fingerprint still local.
- `tests/e2e/threadline/a2a-backup-routes-alive.test.ts` — two real AgentServers with real relay clients: gate on → local + log line + counter; gate off (live) → relay.

## Class-Closure Declaration (display-only mirror)

No self-triggered controller and no agent-authored-artifact defect — not applicable.

## Second-pass review

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur**

Concur — no blocking findings. The marking set matches §1 exactly (only the POST's own wrapped fetch can set the refused outcome; a later ECONNREFUSED in the shared catch never unmarks; a mixed dual-stack failure is marked, the safe direction); the relay leg reuses `msgId` and uses `effectiveThreadId` after any POST; the fingerprint branch is classified first, exclusive, de-duplicated, credential-skipped and health-gated, never reaching the 409; gate off calls `sendAutoWithThread` with exactly four arguments; no path drops a message. Non-blocking nits: (1) the 503 body was parsed even with the gate off — resolved, the parse now runs only with the gate on, so gate-off is byte-identical; (2) the authed `/health` carries the `threadline.backupRoutes` counters even with the gate off (kept: additive, authed-only, all zero when dark); (3) `fingerprintToRelay` also counts credential sends that skip the branch (kept: it counts every fingerprint-addressed send that went to the relay, which is what the soak reads).

## Deviations from the spec text (recorded)

- **Integration loopback.** The receiver's same-machine loopback (`/threadline/health` + `/messages/relay-agent`) in the integration tier is a local server whose answers each test sets (to force a timeout, a refusal and an in-flight 409); the relay copy lands on the real receiver relay client and the real ledger. The E2E tier uses a real receiver AgentServer for the loopback.
