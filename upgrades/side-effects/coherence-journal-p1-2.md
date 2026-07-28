# Side-Effects Review — Coherence Journal P1.2 (read API + awareness + actuation-ban lint)

**Version / slug:** `coherence-journal-p1-2`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `not required as a PR-time pass — design converged in the 4-round spec review (docs/specs/reports/coherence-journal-convergence.md); implementation tracks §3.5/§3.8/§3.9`

## Summary of the change

P1.2 of the approved COHERENCE-JOURNAL-SPEC: `CoherenceJournalReader` (standalone module; bounded merged reads per §3.5 — reverse-tail via the writer's shared tolerant reader, 4MB per-query byte ceiling, 8-archive generic cap with the topic-placement answer-complete exemption, `(epoch,ts)` placement ordering vs `(ts,machineId,seq)` otherwise, opaque keyset cursor matching the query's order key, `(topic,epoch)` first-seen collapse, replica/staleness tagging, param-hygiene by enumeration); `GET /coherence/journal` route (Bearer, 503-when-dark, 400 on malformed cursor); `lint-journal-actuation-ban` (§3.9 — actuator modules may not import the reader; chained in `lint`); CLAUDE.md template Capabilities entry + Registry-First row + proactive triggers (Agent Awareness); site docs coverage; TelegramAdapter emergency-stop seam (closing the P1.1 deviation); Tier-3 e2e lifecycle test.

## Decision-point inventory

- `GET /coherence/journal` — ADD — read-only; 503 when dark; no actuation surface.
- `lint-journal-actuation-ban` — ADD — CI-time guard (build fails; never runtime).
- No runtime block/allow decisions added or modified.

## 1. Over-block
Read path: a malformed cursor returns a clean 400 (tested); traversal-shaped `machine`/`kind` filters match nothing rather than erroring (tested). The actuation-ban lint could over-block a legitimate future consumer inside an actuator file — that is the DESIGN (the consumer should read the live store; §3.9), and the lint message says so.

## 2. Under-block
The lint bans imports of the reader module in an enumerated actuator list — a new actuator file or a hand-rolled JSONL read evades it (stated guardrail framing; the §3.9 duty is the authority). The enumerated-list shape is deliberate: growable, reviewable.

## 3. Level-of-abstraction fit
Reader as a separate module (not writer methods) exists precisely so the import-ban lint has a clean target; route is a thin adapter over it. Right layers.

## 4. Signal vs authority compliance
**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)
- [x] No — this change has no runtime block/allow surface. (The journal remains signal-only; this PR adds the structural enforcement OF that.)

## 5. Interactions
- Reads share `readTailTolerant` with the writer (single tolerant-parse implementation, no drift).
- `recvTs` for replicas uses replica-file mtime as best-effort until P1.3's apply path stamps real receipt times — recorded limitation, surfaced in the field's semantics, not hidden.
- Stream `status` is `current` for all streams in P1.2; the replication states (`behind/gapped/suspect/reset/writer-locked-out`) arrive with P1.3's apply machinery. The shape is already in the response so consumers build against it now.
- The TelegramAdapter seam is injection-only (setter); absent → previous behavior (scanner coverage within ≤60s).

## 6. External surfaces
- New GET route behind the standard Bearer middleware; 503 when dark — fleet agents (dark) expose a clean "not enabled" rather than a 404 that reads as "wrong version".
- CLAUDE.md template + migrateClaudeMd: existing agents' docs gain the capability block on update (Agent Awareness + Migration Parity).
- No persistent-state changes beyond reads.

## 7. Rollback cost
Code revert + patch. No state, no migration. Template section removal rides the same revert.

## Conclusion
Read-side honesty (staleness labels, partial-result flags, skew-proof ordering) implemented exactly as converged; the §3.9 ban is now structural. Clear to ship dark.

## Second-pass review (if required)
**Reviewer:** convergence panel (design-time)
**Independent read of the artifact:** PR CI + operator spot-check per process.

## Evidence pointers
- `tests/unit/CoherenceJournalReader.test.ts` (15) + `tests/integration/coherence-journal-route.test.ts` (7) green; e2e lifecycle test (agent-built, see PR); writer/wiring/guard suites unaffected (46 adjacent tests green).
- `node scripts/lint-journal-actuation-ban.js` → clean (8 actuator modules).
