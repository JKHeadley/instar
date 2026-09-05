# Side-Effects Review — Stage-B evidence binds to the certified code, not the version number

**Version / slug:** `stage-b-evidence-code-binding`
**Date:** `2026-09-03`
**Author:** `Echo`
**Second-pass reviewer:** `Codex independent reviewer (see below)`

## Summary of the change

The Stage-B publish gate's evidence binding compared the signed canary artifact's `packageVersion` to the current build, which can pass exactly once; publishing froze fleet-wide one release after the gate shipped, and the runtime fleet-activation path carried the same binding, so Stage B would have stayed silently dark on every later release. The change (spec `docs/specs/stage-b-evidence-code-binding.md`, conformance-checked; operator-approved direction, topic 52075, 2026-09-03) binds evidence to the certified code instead: a reviewed manifest (`src/data/stageBCertifiedSet.ts`) partitions the certified roots' transitive relative-import closure into certified (fingerprinted) and excluded-with-written-reason, fail-closed for new members; `verifyShippedStageBEvidence` (`src/core/StageBActivationGate.ts`) verifies shape, signature, thresholds, the REAL behavioral-config binding, and the canonical-digest linkage to that manifest; `scripts/stage-b-certified-fingerprint.mjs` checks source drift at publish (`scripts/verify-codex-stage-b-release-evidence.mjs`) and pre-push (`.husky/pre-push`), and its `--write` refuses to re-stamp old evidence onto changed code.

## Decision-point inventory

- Stage-B publish gate (`verify-codex-stage-b-release-evidence.mjs` + `verifyBundledStageBReleaseEvidence`) — modify — binding predicate corrected from version equality to certified-code fingerprint + canonical digest linkage; blocking authority and fail direction unchanged.
- Runtime fleet activation (`resolveStageBProductionActivation`, shipped branch) — modify — same corrected binding; machine-LOCAL candidate path untouched.
- Pre-push hook — add (signal-to-developer) — surfaces drift at push time; publish remains the enforcing gate.

---

## 1. Over-block

A certified-source edit now blocks publishing until a fresh canary — intended, and narrower than today (today EVERYTHING is blocked). A tsc or dependency change does not block (fingerprint covers source bytes, not build output). A stale exclusion (file leaves the closure) fails the check until the manifest is tidied — deliberate, keeps the partition true. If the manifest and evidence ever disagree (digest mismatch), publishing blocks with a named message — the safe direction for a release gate.

## 2. Under-block

A behavior change inside an EXCLUDED closure member (the shared types module, safe executors, tone gate, and 30 others, each with a written reason) does not force a canary — accepted, enumerated in the manifest, and stated in the spec's honest limits. A hand-rolled npm publish that bypasses lifecycle scripts bypasses this gate exactly as it bypasses today's — unchanged exposure, out of scope. The fingerprint has no adversarial value: everything is editable in one PR, same as the verifier it amends; review of the diff remains the defense at that layer.

## 3. Level-of-abstraction fit

The binding is a deterministic invariant at the release-gate layer, exactly where the broken one lived; no new layer, no judgment added. The closure computation and partition live in one tool used by both the publish gate and pre-push, not re-implemented per consumer.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — but the blocking logic is an exact-match deterministic check on an irreversible-release class action (ship/don't-ship), the ruled shape for structure deciding alone. No LLM, no heuristic; the predicate is byte equality against a reviewed manifest. The pre-push arm is a SIGNAL to the developer (publish is the authority).

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point: "did the certified bytes change?" is enumerable and exact.

---

## 5. Interactions

- **Shadowing:** the fingerprint check runs AFTER the evidence verification inside the publish verifier; a failure of either blocks. The pre-push arm runs before the smoke tier and only when a built gate module exists (fresh clones without dist skip it; publish still enforces).
- **Double-fire:** none; one tool, two invocation points, both idempotent reads.
- **Races:** none; all reads of committed files.
- **Feedback loops:** none.
- **Migrator/init call sites:** `verifyBundledStageBReleaseEvidence` keeps its signature (version parameter documented unused), so `PostUpdateMigrator` and `init` behave identically except the verdict is now correct on later releases — which flips `releaseEvidenceValid` from a wrong `false` to a true verdict and lets the existing migration set pending activation as designed.
- **Test override seam:** the documented `shippedEvidence` injection keeps every shape/signature/threshold/config check; the manifest digest linkage applies only to the package-bundled path (every production caller).

---

## 6. External surfaces

- Install base: the next release publishes; fleet machines activate Stage B via the existing migration (pending-activation on restart) instead of staying silently dark — the shipped feature finally behaves as its own release notes said.
- External systems: none. Persistent state: none new (a src/data module compiled into dist). Timing: none. Operator surface: none.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated by the package**: the manifest and evidence ship in the npm package, identical on every machine; verification is pure and local. No user-facing notices, no durable per-machine state, no URLs.

## 8. Rollback cost

Revert and ship a patch — but note the revert RESTORES the release freeze (the reverted gate rejects every version except 1.3.1219), so a rollback of this change must itself be published by temporarily bypassing the gate or re-binding; recorded here so nobody reverts casually. No data migration, no agent state repair.

## Conclusion

The review moved the design three times: the digest became canonical (order-stable) instead of JSON.stringify; the runtime fleet path was discovered to carry the same freeze and fixed identically; the coverage cut became an enumerated fail-closed partition instead of a silent five-file list, with the rebind tool structurally refusing old-evidence re-stamping. Residue accepted and recorded: excluded utilities can change certified behavior without forcing a canary (per-file reasons in the manifest); publish-path bypass exposure unchanged from today. Clear to ship after the independent second pass and the full test gate.

## Second-pass review (if required)

**Reviewer:** Codex independent reviewer (GPT-5.6, read-only, spec + implemented diff)
**Independent read of the artifact:** concern → concur over five bounded rounds. Round 1 (spec): eight findings — the --write rebind hole, same-PR mutability, five-file under-coverage, gate-exclusion soundness, the runtime path's identical version freeze, tautological config binding, publish-path TOCTOU, JSON.stringify digest instability — all folded into the design (fail-closed enumerated partition, canonical digest, runtime fix, real config binding, honest-limits section). Round 2 (implemented diff): three findings — silent pre-push skip, single-quote-only import matcher, unpinned override seam — all fixed; widening the matcher surfaced 47 further closure members through dynamic imports, each now excluded with a written reason. Rounds 3–5 tightened the seam pin to any token mention with an exact-path exemption; final verdict: concur.

## Evidence pointers

- `tests/unit/stage-b-evidence-code-binding.test.ts` (19 tests)
- `tests/unit/StageBActivationGate.test.ts`, `StageBStartupReadiness.test.ts`, `MentorStageBForensics.test.ts`, `codex-stage-b-publish-gate.test.ts` (all green)
- Live: `node scripts/verify-codex-stage-b-release-evidence.mjs` passes on this tree; `verifyBundledStageBReleaseEvidence("9.9.9999")` returns null.
- Fresh repair evidence: candidate `cfe468dc5` passed 50/50 deliveries over 7,213,141 ms, all required cases, 30/30 responsiveness samples, and zero forbidden outcomes; Echo signature verification and certified-set fingerprint check both pass for artifact digest `a2db23a95530681953ffa3002ab14e349ebf53d19be2a54c1f4afacc3aead997`.

## Class-Closure Declaration (display-only mirror)

`defectClass: symbol-for-state-verification`ish — the registry id is resolved at commit time; if no existing class fits ("a gate verified a proxy symbol that diverged from the state it stood for"), this ships `closure: guard` citing `tests/unit/stage-b-evidence-code-binding.test.ts` (the version-independence and drift tests fail on any reintroduction of a version-bound or manifest-less path). No self-triggered controller is added or modified — the gate blocks a human-invoked publish; nothing fires on its own.
