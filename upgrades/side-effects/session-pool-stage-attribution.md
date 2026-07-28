# Side-Effects Review — Session-pool stage attribution

**Version / slug:** `session-pool-stage-attribution`  
**Date:** `2026-07-23`  
**Author:** `Instar Agent (instar-codey)`  
**Second-pass reviewer:** `Codex independent reviewer`

## Summary of the change

The server boot wiring now gives StageAdvancer and SessionPoolFailoverRunner one
config-backed current-stage reader and one build-identity closure. The runner
credits a failover verdict to the stage actually running instead of hardcoding
stage zero. Build identity resolves deployment SHA, Git HEAD, installed package
version, then `unknown`. Tests cover the valid current-stage climb, rejection
of a wrong-stage green, and legacy equal-`unknown` consistency.

## Decision-point inventory

- `StageAdvancer.advanceTo` — pass-through — remains the sole evidence-gated
  promotion authority; its policy is unchanged.
- `SessionPoolFailoverRunner.tick` — modify input attribution — records proof
  against the live configured stage read at tick time.
- Build identity comparison — modify fallback — package version is preferred
  before the existing final `unknown` fallback.

---

## 1. Over-block

No new block/allow surface. A green must still match the stage, identity, result,
and signature. Legitimate equal-`unknown` producer/consumer evidence remains
accepted, so npm installations without any usable metadata are not newly
blocked.

---

## 2. Under-block

The fallback `unknown` cannot distinguish two different builds when neither
deployment SHA, Git metadata, nor a meaningful package version is available.
That is the existing terminal fallback, intentionally preserved for legacy
consistency. Wrong-stage evidence remains unusable.

---

## 3. Level-of-abstraction fit

The fix is at the boot-composition layer where the two consumers were wired to
different truths. It reuses `liveConfig`, `stageIndex`, StageAdvancer, and the
signed result store rather than creating a parallel stage store or promotion
path. StageAdvancer remains the higher-level authority.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The runner produces signed stage evidence. It does not promote. StageAdvancer
is the existing deterministic rollout authority over an enumerable stage
machine and continues to decide whether the evidence satisfies the next rung.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Stage identity
is a mechanical invariant: proof from stage N can gate only the transition from
stage N to N+1. Build identity equality is likewise an existing hard invariant.

---

## 5. Interactions

- **Shadowing:** none; the producer writes the stage the existing consumer
  already queries.
- **Double-fire:** none; the runner cadence and in-flight throttle are unchanged.
- **Races:** the stage is read before and after each check. If it changed during
  the subprocess, the runner records nothing and audits the discarded result,
  so it cannot become reusable evidence after a later demotion or promotion.
- **Feedback loops:** a green can unlock one existing bounded promotion step;
  the ceiling and cadence still prevent unbounded climbing.
- **Dry run:** unchanged; dry-run evidence remains in the side store that
  StageAdvancer never reads.

---

## 6. External surfaces

Agents whose rollout is above the bottom stage can now progress after a genuine
green instead of remaining permanently at `no-result`. The signed result file
may contain package-version identities on npm installations. No external API
shape, operator action, URL, message, or third-party integration changes.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN:** the active rollout stage and its self-test evidence
describe the currently running agent installation and its local boot identity.
The existing session-pool machinery coordinates failover; this change does not
add a new durable store or transport. Both producer and consumer on a machine
share the same live config and identity closure. It emits no user-facing
notices, generates no URLs, and adds no topic-bound durable state that could be
stranded on transfer.

---

## 8. Rollback cost

Pure code and tests. Revert and ship a patch. No schema migration, evidence-file
rewrite, agent reset, or user action is required. Existing rows remain valid.

---

## Conclusion

The review found the correct ownership boundary at server composition: unify
inputs without weakening StageAdvancer. The design preserves signed evidence,
dry-run isolation, one-step promotion, ceiling bounds, and legacy fallback
compatibility. Clear to ship subject to independent second-pass concurrence.

---

## Second-pass review (if required)

**Reviewer:** Codex independent reviewer  
**Independent read of the artifact:** concur after two corrections

The reviewer identified in-flight stage movement and a separate runner-checkout
identity as gaps. The implementation now discards results when stage changes
during the check, boot-pins the runner source root, and prefers that exact
checkout's Git identity before package fallback.

---

## Evidence pointers

- `tests/unit/session-pool-failover-runner-wiring.test.ts`
- `tests/unit/StageAdvancer.test.ts`
- Focused promotion/E2E set: 49 tests passed.
- Full unit run: 38,292 passed; release-note naming corrected and verified;
  unrelated `SybilProtection` wrong-IP test reproducibly fails in isolation.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no added or modified self-triggered
controller — not applicable. The existing runner's cadence and authority do not
change; only the stage and identity inputs supplied by boot wiring are corrected.
