# Side-Effects Review — Mutual SSH failure evidence

**Version / slug:** `mutual-ssh-failure-evidence`
**Date:** `2026-08-02`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `/root/ssh_failure_review` (concurred after fixes)

## Summary of the change

`src/core/MutualSshHealthController.ts` now captures every classified SSH
failure as a class plus a bounded, privacy-scrubbed detail. `src/core/MutualSshRuntime.ts`
retains that object for caught bootstrap failures and adds it to the existing
status surface only when evidence exists. Existing blocked-reason strings,
retry behavior, and readiness calculations are preserved.

## Decision-point inventory

- `classifyMutualSshFailure` — pass-through — the existing classifier and every
  match rule remain byte-identical; the change retains evidence beside its result.
- `MutualSshRuntime.status` readiness projection — pass-through — the existing
  readiness and enrollment-state expressions are unchanged.
- Failure-detail privacy transform — add — deterministic structural scrubbing
  controls what evidence may cross the operator-facing status/audit boundary.

---

## 1. Over-block

No block/allow surface — over-block is not applicable. The change does not
reject a bootstrap, advert, key, proof, or peer-execution input.

---

## 2. Under-block

No block/allow surface — under-block is not applicable. Privacy scrubbing is a
separate under-redaction risk: novel endpoint encodings may not match the
contextual patterns. Known credential shapes and SSH key material are scrubbed
first; IPv4, IPv6, DNS-failure hostnames, private-network suffixes, and labeled
SSH endpoints are covered; and the detail is bounded. The status already names
the machine associated with the failure. This change does not claim arbitrary
secret detection.

---

## 3. Level-of-abstraction fit

Evidence capture belongs beside the existing classifier because every caller
needs the same invariant: a class summarizes the error and never replaces it.
The helper reuses the shared durable-secret scrubber rather than creating a new
credential-pattern list, then applies SSH-specific endpoint/key removals that the
generic scrubber does not own. Runtime status remains the projection layer; it
does not learn new classification logic.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The substring classifier remains a diagnostic signal. This change neither
grants it new authority nor uses the retained detail to alter readiness,
routing, admission, or peer execution.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The new logic is
a structural information-disclosure bound over an already-caught error; its
domain is a fixed safety invariant, not a judgment among live signals.

---

## 5. Interactions

- **Shadowing:** none. Classification occurs on the original thrown value before
  the detail is scrubbed, so scrubbing cannot shadow an existing class match.
- **Double-fire:** none. One caught error produces one retained object at the
  same call site that previously stored one string.
- **Races:** map keys and deletion/retry points are unchanged. A later successful
  bootstrap still deletes the same machine-keyed failure entry.
- **Feedback loops:** none. The detail is observational and never feeds the
  classifier, retry controller, readiness expression, or peer-execution gate.

---

## 6. External surfaces

The existing mutual SSH status gains an optional `bootstrapFailures` array only
when caught evidence exists. Repair-direction health can now include
`lastFailureDetail`, and the existing exhaustion/security callbacks receive the
same scrubbed detail. No database or file format changes. No new operator action,
notification channel, route, timing dependency, or external service is added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard, approval, grant, revoke, or form surface is touched. The existing
machine-readable status remains the diagnostic surface, so this section is not
applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN:** a listener or SSH bootstrap error is a physical
truth about the machine on which it occurred. The existing per-machine status
continues to own it; this change does not replicate a local error as if it were a
peer's observation. It emits no user-facing notice, holds no durable state that
can strand on topic transfer, and generates no URL. Pool-level tooling may read
each machine's existing status, but no merged authority is introduced here.

---

## 8. Rollback cost

Pure code and response-shape addition. Revert the source and test changes and
ship the next patch. No data migration, key rotation, agent-state repair, or
operator action is required. During rollback, unknown failures return to the old
less-diagnostic string-only surface.

---

## Conclusion

The design preserves every existing authority boundary and retry/readiness
behavior while closing the evidence-loss seam. The main residual is ordinary
best-effort redaction coverage, bounded by the shared credential scrubber,
contextual SSH-specific patterns, the strict length limit, and a failing-before
privacy regression. The independent reviewer concurred after the initial
privacy findings were fixed.

---

## Second-pass review (if required)

**Reviewer:** `/root/ssh_failure_review`
**Independent read of the artifact:** Initial read found broad dotted-token
redaction, missing bare-host/IPv6 coverage, an empty-detail edge case, and a
repair-controller coverage gap. The implementation now uses contextual endpoint
patterns, covers bare DNS failures and IPv6, guarantees a nonempty detail, and
asserts controller projection/callback detail. On re-review, the reviewer ran
the focused 18-test lane and TypeScript no-emit check, confirmed every finding
closed, and concurred with no remaining material issue.

---

## Evidence pointers

- `tests/unit/mutual-ssh-hardening.test.ts` — listener-failure reproduction,
  unknown-class evidence, contextual hostname/IP/private-key scrubbing, dotted
  JavaScript identifier preservation, size bound, and healthy single-machine
  compatibility.
- `tests/unit/mutual-ssh-autobootstrap.test.ts` — repair-controller regression
  suite.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This is an ordinary runtime
source defect, not a prompt, hook, configuration, skill, standards-text, or
self-triggered-controller class-closure change.
