# Side-Effects Review — WS5.2 balancer busyness signal (drain-target refinement)

**Version / slug:** `ws52-busyness`
**Date:** 2026-06-13
**Author:** echo
**Second-pass reviewer:** not required (a pure read-only data-signal helper + thin wiring; no gate/sentinel/lifecycle/write surface; the balancer it feeds is already dry-run-gated + B3a-reviewed)

## Summary of the change

Resolves the tracked busyness follow-up for the autonomous balancer (Increment B). Adds a pure `computeBusynessBySlot(sessions, slotOf, defaultSlot)` to `CredentialRebalancerSnapshot.ts` — per-slot busyness = count of RUNNING claude-code sessions on each slot (a session's slot is its account's current slot via `ledger.slotOf`; an untagged session counts toward the default slot; non-running / explicit-non-claude sessions don't count). Wires it into the server's `listSlots` provider so the balancer's drain objective targets the actually-busiest slot (real signal) instead of uniform-0. Read-only; affects only the §2.4 drain TARGET selection, and only in dry-run on a dev agent (zero credential writes).

## Decision-point inventory

- `CredentialRebalancerPolicy` drain-target selection (objective 2) — now fed a real busyness signal instead of uniform 0. No new decision point; it sharpens an existing one (which busy slot a drain deals to). No authority change; the balancer remains dry-run-gated.

---

## 1. Over-block / ## 2. Under-block
No block/allow surface. The signal only orders drain TARGET candidates; a wrong count would at worst pick a sub-optimal busy slot to drain to (still a valid eligible slot), and only in dry-run.

## 3. Level-of-abstraction fit
Correct: the busyness computation is a pure mapper in the snapshot module (alongside mapSlot/mapAccount), kept out of server.ts so a counting bug is unit-testable. The server wiring is a one-line provider change passing `state.listSessions()` + the ledger's `slotOf`.

## 4. Signal vs authority compliance
- [x] No — a read-only data-signal helper; no block/allow surface, no authority. (Ref: docs/signal-vs-authority.md.)

## 5. Interactions
- Feeds only the policy's drain `busyness` field (already consumed; previously always 0). No shadowing/race — pure, computed fresh each pass from the live session list.
- The untagged-session-→-default-slot attribution is a deliberate choice (the default interactive session runs on the default account); documented.

## 6. External surfaces
- None directly. The balancer's `GET /credentials/rebalancer` status (and its dry-run audit) will now reflect drain decisions that target the busiest slot — observably better dogfooding signal, still zero writes (dry-run on dev; dark on fleet).

## 7. Multi-machine posture (Cross-Machine Coherence)
- **Machine-local BY DESIGN.** Busyness is computed from THIS machine's live session list + THIS machine's ledger; per-machine. No cross-machine input.

## 8. Rollback cost
Trivial. Revert → the balancer falls back to uniform busyness (drain picks the first eligible busy slot). No state, no migration, no credential touch.
