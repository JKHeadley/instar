# Side-Effects Review — W3.4 protected enforcement measurement

**Version / slug:** `w34-enforcement-measurement`
**Date:** `2026-08-18`
**Author:** `Instar Agent (instar-codey), CI3 repair lane`
**Second-pass reviewer:** `ci3_side_effects_review` — CONCUR

## Summary of the change

W3.4 changes `scripts/lib/standards-enforcement-measurement.mjs` and
`scripts/standards-coverage.mjs` so the standards-coverage headline is derived from a closed
protected rule census and protected, content-bound proof rather than candidate-controlled file
existence. A removed rule remains in the continuity denominator and is reported as a removal;
empty, hollow, candidate-only, or executable-but-unproved references receive no proven strength;
and an empty protected population is an error rather than 100%. CI3 changes no W3.4 implementation
bytes: it is re-committing the delivered bytes through the actual local `instar-dev` gate so that
the gate itself produces the missing decision-audit record.

## Decision-point inventory

- `resolveProtectedMeasurementSnapshot` — **add** — selects a content-addressed protected merge
  base from canonical main and refuses candidate refs as authority.
- `measureAnchoredEnforcement` — **add** — assigns deterministic strength and continuity outcomes
  from protected/candidate evidence.
- `scripts/standards-coverage.mjs --check` integration — **modify** — consumes the protected
  measurement and exposes removal, unverified-reference, and measurement-error states in the
  existing blocking coverage check.

---

## 1. Over-block

The conservative proof boundary can under-credit a genuinely effective guard whose protected proof
record has not yet landed. On the present protected snapshot that produces the honest `0/88` proven
strength result rather than blocking merely because the number is low. A protected-main lookup or
merge-base failure can make the measurement unavailable and fail the coverage check; this is an
intentional fail-closed integrity boundary, but a canonical-remote outage can therefore delay a
legitimate change until the protected source is readable again.

No user input or conversational content is blocked by this change.

---

## 2. Under-block

W3.4 validates the structure, content binding, relevance boundary, and declared clean/mutated
fail-direction of protected proof records, but it does not itself execute the recorded observer.
Later W3.5–W3.8 work adds authenticated live execution and artifact integrity. Until those layers
land, a structurally valid protected record remains an admission made through protected-main review,
not independently observed execution by W3.4.

The metric also does not certify every guard merely because a reference resolves. It intentionally
reports those references as unverified; consumers must not reinterpret the separate false-claim or
path-resolution output as behavioral effectiveness.

---

## 3. Level-of-abstraction fit

The protected snapshot reader and proof grader are the correct lower-level primitives for the
existing standards-coverage report. They do not invent a second standards authority: the Standards
Registry remains the rule source, canonical main remains the trust boundary, and the existing
coverage command remains the single report/check surface. Keeping pure grading in the library and
CLI/report integration in `standards-coverage.mjs` avoids duplicating the policy across tests and
workflows.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [x] Deterministic hard-invariant validation — the documented carve-out applies.

The coverage command has blocking CI authority, but its decisions are over an enumerable repository
contract: exact Git object identity, closed populations, exact proof schemas, cryptographic digests,
and monotonic direction. This is not a brittle attempt to infer user intent or message meaning. A
candidate either preserves the protected obligation and earns the admitted proof strength or it
does not. The output retains reasons and unverified populations so the invariant is inspectable.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals judgment point. The relevant domain is an
enumerated integrity invariant: protected rule identities, candidate continuity, exact file bytes,
and exact proof envelopes. Recency, urgency, ownership, or conversational evidence cannot
legitimately override those facts inside the measurement. Human authority remains at the separate
review/merge decision over what evidence is admitted to protected main.

---

## 5. Interactions

- **Shadowing:** the protected measurement does not replace false-claim, dangling-reference, or
  per-area checks. Those retain their distinct meanings; proven strength is reported separately.
- **Double-fire:** `standards-coverage.mjs` computes the report once per invocation and exposes the
  same result to the CLI check and JSON report. There is no second actor mutating repository state.
- **Races:** canonical-main resolution depends on a network read followed by local content-addressed
  Git reads. Main can advance after resolution without changing the pinned SHA used by that run.
- **Feedback loops:** candidate files cannot raise their own protected numerator. A later protected
  merge can intentionally change the next run's authority snapshot; that is the declared admission
  path, not a same-run feedback loop.
- **Adjacent work:** W3.5–W3.8 strengthen how protected proof is observed and represented. W3.4's
  conservative unverified result remains valid when those extensions are absent.

---

## 6. External surfaces

The visible surface is developer/CI output: the standards-coverage headline, protected/candidate
population, removals, unverified references, and measurement errors. The resolver reads the
canonical GitHub remote and therefore depends on bounded network availability. It changes no
Telegram, Slack, dashboard, API, database, user configuration, authentication, or signing surface.

The command may persist its existing machine-readable standards-coverage report; that report is
derived output, not authority independent of the pinned protected Git objects. No operator-facing
action or phone-completable workflow is added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. The change adds no dashboard, approval, grant, revoke,
secret-drop, or other human action form.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated.** The behavior ships in Git, the trusted population is identified by canonical Git
SHA, and proof strength is derived from content in that snapshot. Machines holding the same
candidate and protected objects should compute the same result. Machine-specific network or object
availability can produce an explicit unavailable/error state; it cannot silently substitute local
candidate bytes as protected authority.

The feature emits no user-facing notices, holds no durable conversational state, generates no URLs,
and cannot strand state on topic transfer. CI output is repository-scoped and GitHub-hosted.

---

## 8. Rollback cost

Rollback is a code revert followed by the normal patch release. No database migration, agent reset,
or durable user-state repair is required. Any consumer introduced for the expanded measurement JSON
would need to roll back with the producer. During rollback, standards coverage would return to the
older existence-weighted metric and could again over-credit hollow references, so rollback should
be treated as a temporary loss of measurement integrity rather than a neutral formatting change.

---

## Conclusion

The design is conservative and correctly separates candidate evidence from protected authority.
Its material costs are honest under-credit before protected proof admission and dependence on a
readable canonical Git source. No new side effect requires an implementation change in CI3. The
W3.4 implementation remains subject to its existing independent judgments; this artifact only
closes the missing local-gate process evidence by giving the real pre-commit gate the review input
it requires.

---

## Second-pass review (required)

**Reviewer:** `ci3_side_effects_review`
**Independent read of the artifact:** CONCUR

The reviewer independently confirmed the conservative proof boundary, deterministic-authority
carve-out, canonical-remote failure posture, interaction with W3.5–W3.8, rollback claim, and the
unchanged implementation hashes stated by CI3. The review found no substantive concern.

---

## Evidence pointers

- `scratchpad/phaseB/REPORT-W34.md` — append-only implementation and behavioral-control record.
- `scratchpad/phaseB/REPORT-J5.md` — independent finding that caused the fail-direction repair.
- `scratchpad/phaseB/evidence/W34-J5-repair-controls.json` — content-addressed repaired controls.
- `tests/unit/standards-enforcement-measurement.test.ts` — protected-proof and vacuity controls.
- `tests/unit/standards-coverage-ratchet.test.ts` — deletion, empty-reference, and hollow-addition
  controls.

---

## Class-Closure Declaration (display-only mirror)

CI3 does not add or alter a defect fix in an agent-authored prompt, hook, config, skill, or standards
text, and it adds no self-triggered controller. It re-commits already judged W3.4 implementation
bytes through the gate that was bypassed. Class closure for the original W3.4 measurement defect is
therefore outside this process-evidence repair; no new class-closure claim is made here.
