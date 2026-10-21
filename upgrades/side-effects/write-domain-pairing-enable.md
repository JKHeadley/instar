# Side-Effects Review — Declare POST /threadline/pairing/enable in the write-domain registry

**Version / slug:** `write-domain-pairing-enable`
**Date:** `2026-10-21`
**Author:** `Echo`
**Second-pass reviewer:** `not performed — a one-line declaration of existing behaviour; see §Second-pass review`

## Summary of the change

`POST /threadline/pairing/enable` (PR #2248) is a mutating route with no write-domain declaration, so `tests/unit/write-domain-conformance-ratchet.test.ts` fails on `main`. This declares it `cluster-shared`, the same classification its four sibling pairing routes carry, and records in a code comment the argument for the other answer and what would change it. No behaviour change.

## Decision-point inventory

- `buildWriteDomainRegistry()` — add — one `reg.add({ route, POST, '/threadline/pairing/enable', domain: 'cluster-shared' })` entry.

## 1. Over-block

`cluster-shared` means the write is admitted only for the machine that holds the lease, so a standby asking to switch its own pairing on is refused. That is the real risk of this classification, and it is argued rather than assumed: the route already answers `unavailable-here` on a machine without the relay identity, and the documented connect flow (CLAUDE.md, "Connecting to another agent") moves the conversation to the relay holder before enabling. A standby that enabled itself would not connect anyway — the relay admits one connection per agent identity, and a standby suppresses its own.

## 2. Under-block

If the feature owner intends a standby to switch itself on, this declaration is too strict and the right answer is `machine-local` with a per-machine-path convergence story on both axes (I9). The code comment names that explicitly so the next reader does not have to re-derive it. Under-blocking is not a risk here: the alternative classification is *less* restrictive, never more.

## 3. Level-of-abstraction fit

The registry is exactly the layer that answers "which machine may perform this write". Declaring a route there is the intended mechanism, not a workaround — the ratchet's failure message names this registry as option 1 of 3.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the declaration is a static fact about a route, consumed by the existing write-admission layer. It introduces no new judgement and no new blocking authority; the admission decision it feeds already exists and already governs its four siblings.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new judgement point. The one judgement *I* made — which of two existing classifications applies — is recorded in the code comment with its counter-argument and its falsifying condition, so it is reviewable rather than silent.

## 5. Interactions

- **Shadowing:** none. The entry is a distinct path prefix; `/threadline/pairing/invites` and `/threadline/pairing/:peerFp/start` are unaffected.
- **Double-fire:** not applicable — a registry entry performs nothing.
- **Races:** none introduced. The write-admission layer that consumes this ships dev-gated and dry-run-first, so on the fleet this entry currently changes nothing at all.
- **Feedback loops:** none.

## 6. External surfaces

No route added or changed, no config key, no schema, no message, no stored data. The only externally visible consequence appears if and when write-admission enforcement is enabled on a multi-machine agent: a standby's call to this route would be refused with the existing typed `write-refused` 409 naming the owner, rather than being admitted.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface. The refusal path it feeds is the existing typed 409, whose wording this change does not touch.

## 7. Multi-machine posture (Cross-Machine Coherence)

This change is *about* multi-machine posture: it says the lease holder is the single writer for this route. Single-machine agents are unaffected (the write-admission layer is a no-op there). No replication, no topic transfer, no URL, no new cross-machine state.

## 8. Rollback cost

Delete the entry. The ratchet then fails again on `main` exactly as it does today; no data or state to clean up.

## Conclusion

This closes a red ratchet with the declaration the ratchet asks for, at the conservative end of two defensible options, and leaves the alternative documented at the callsite with its falsifying condition. Clear to ship.

## Second-pass review (if required)

**Reviewer:** not performed. Recorded rather than claimed: the change is one declarative line with no behaviour change, verified by the ratchet it repairs plus a clean typecheck. The one point worth a reviewer's attention is §1 — whether a standby should be able to switch itself on — which belongs to the owner of PR #2248 and is called out in the code comment for exactly that reason.

## Evidence pointers

- `tests/unit/write-domain-conformance-ratchet.test.ts` — 6/6 pass with the entry, fails without it (the failure is reproduced on `main` at `aa8ac670d`, shard 3/4).
- `npx tsc --noEmit` — clean.
- Sibling precedent: `src/core/WriteDomainRegistry.ts` lines 369–378.

## Class-Closure Declaration (display-only mirror)

`defectClass: undeclared-mutating-route`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/write-domain-conformance-ratchet.test.ts, howCaught: the ratchet enumerates every mutating route registration and fails on any that is neither classified in the registry, annotated @write-domain:none, nor in the shrink-only baseline — so this class cannot recur silently for a future route either }`.
