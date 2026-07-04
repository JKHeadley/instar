# Side-Effects Review — Doorway/Model Knowledge Registry, increment 5 (flip freshness lint to strict + ratify the "Keep the Doorway/Model Map Current" standard)

**Version / slug:** `doorway-model-registry-inc5`
**Date:** `2026-07-04`
**Author:** `echo`
**Spec:** `docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md` (approved:true, review-convergence tagged) — §Rollout step 5 (companion-gated), §3 (the standard + its ratification precondition), §1.4 (derived-frontier lint).
**Second-pass reviewer:** `not-required` — this increment adds NO runtime block/allow authority. The only "gating" it activates is a **build-time CI lint** (`scripts/lint-model-registry-freshness.mjs`) that fails `npm run lint` on a stale/drifted model pin — a build-time ratchet over git-tracked source, not a runtime gate over messaging, dispatch, sessions, coherence, or trust. Nothing here touches the message path, session lifecycle, compaction/respawn, or any runtime sentinel/guard/gate/watchdog. See §4. (The driving spec already went through 7 spec-converge rounds including dedicated security + adversarial reviewers.)

## Summary of the change

Fifth and FINAL rollout increment of `DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md` (§Rollout step 5, the companion-gated enforcement activation). It does three things, all documentation/config-value scope — no `src/*.ts` runtime change, no new route, no new job, no probing, no spend:

1. **Flip the freshness lint from `report` to `strict`** — `scripts/model-registry-freshness.manifest.json`: `"enforcement": "report"` → `"strict"`, plus a rewritten `$enforcementNote` documenting the flip, why it's safe now, and the one-line rollback (set it back to `"report"`). The lint (`scripts/lint-model-registry-freshness.mjs`) reads this field; strict makes it exit 1 (fail CI) on any finding. It runs in the `npm run lint` chain.
2. **Reconcile-verify `flaggedStale`** — the spec's ratification precondition requires the registry be genuinely fresh before the strict flip. The prior flagged pins were already operator-confirmed + reconciled into `topModels` in increment 1 (`flaggedStale` is `[]`, documented in `$flaggedStaleNote`). Verified: under strict, staleness (reviewed 2026-07-03, 45d window) + all four pins' derived-frontier drift pass clean → the flip does not break the build. No new reconciliation edit was needed; the verification is the reconciliation for this step.
3. **Add the constitutional standard "Keep the Doorway/Model Map Current"** — `docs/STANDARDS-REGISTRY.md`, Building family, using the spec §3 proposed entry text and matching the existing entry format (Rule / In practice / Earned from / Traces to the goal / Applied through). The `**Applied through.**` line names the structural guards (the doorway-scan job + prober, the strict freshness lint, the enriched manifest, the routing narrative), all resolving on disk.

Also updated: `tests/unit/model-registry-freshness.test.ts` — the "shipped manifest" test now asserts the manifest is `enforcement:"strict"` (`r.strict === true`) AND clean under strict, regression-guarding both the flip and a silent revert.

## Decision-point inventory

- **`scripts/model-registry-freshness.manifest.json` `enforcement` field** — `modify` (`report` → `strict`) — turns an existing CI lint from non-gating to gating. Build-time only; no runtime decision surface.
- **`docs/STANDARDS-REGISTRY.md` new article** — `add` — documentation (a constitutional standard). Parsed by the read-only, non-gating enforcement-coverage auditor. NOT a decision point.
- **`tests/unit/model-registry-freshness.test.ts`** — `modify` — a test assertion strengthened. NOT a decision point.
- No message/dispatch/tone-gate/session-lifecycle/coherence/trust runtime decision point is touched.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No runtime block/allow surface — over-block is not applicable at runtime. The nearest analogue is the CI lint now failing the build: it "rejects" a commit/build only when a model pin genuinely drifts off its door's derived frontier set, a `flaggedStale` row is present, or `lastReviewedAt` has aged past the 45-day window. That is exactly the intended anti-rot signal, not an over-block — the manifest is currently clean under strict (verified), so it does not reject the present state. A false-positive would require a legitimate pin that is genuinely off the reviewed frontier set, which by definition is the drift the guard exists to catch (reconcile the manifest to clear it — that IS the review). The window is 45 days, giving ample lead time before a staleness age-out.

## 2. Under-block

**What failure modes does this still miss?**

The lint is model-id-AGNOSTIC by construction — it asserts internal consistency (pins ⊆ derived frontier set) and review freshness; it does NOT verify that the operator-confirmed frontier ids are objectively the true current frontier. A registry that is internally consistent but collectively behind the real world (every pin + every `topModels` entry stale in lockstep, re-reviewed within the window) passes. This is the accepted, documented gap the recurring doorway-scan job (still dark, operator step 4) exists to close by live-re-probing the doors and surfacing "a new frontier model exists that no pin references." The standard's own text names this: scan-liveness monitoring is a tracked follow-up whose anti-rot backstop is this lint. So the strict lint is the tripwire; the scan is the engine — this increment activates the tripwire, and the engine remains a deliberate operator enablement.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The `enforcement` value lives in the single human-edit manifest that the lint already reads — the one source of truth; flipping it there (not in code) keeps the toggle reversible and data-driven, exactly as the lint was designed (spec §1.4, PR #1359). The standard lives in `docs/STANDARDS-REGISTRY.md` alongside every other constitutional standard, parsed by the same auditor. The test change lives in the existing lint test. No new abstraction is introduced; nothing is re-implemented. This is precisely the "flip a manifest field + ratify a doc standard" shape the spec's rollout step 5 prescribes.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no runtime block/allow surface. The only authority it activates is a **build-time CI ratchet** over git-tracked source (a lint that fails `npm run lint` on stale/drifted model pins). That is the sanctioned shape for a freshness ratchet (a deterministic, model-id-agnostic consistency check — not an LLM judgment, not a message/dispatch gate). The added standard is documentation; the enforcement-coverage auditor that reads it is explicitly observe-only / non-gating ("a gap is a signal to build a guard").

No brittle logic gains runtime blocking authority — there is none here. The lint's decision (pass/fail) rests on objective, decidable checks: a regex match against a source file, set membership in a derived list, and a date comparison. It is fed by the manifest (the operator-reviewed source of truth), never by inference.

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** none. The lint is the last entry in the `npm run lint` chain and independent of the others; flipping its enforcement changes only its own exit code on its own findings. The new standard article is appended at the end of the Building family (a unique `### Keep the Doorway/Model Map Current` heading) — it is picked up by the parser as one more article and does not shadow or collide with any existing article's heading or enforcement-ref extraction.
- **Double-fire:** none. The lint runs once per `npm run lint`; there is no second consumer of `manifest.enforcement` (verified: the only reader is `scripts/lint-model-registry-freshness.mjs`; unrelated `.enforcement`/`enforcementKind` references in `StandardsEnforcementAuditor`/routes are a different field on a different object). The three route/e2e fixture manifests that set `enforcement:"report"` write their OWN fixtures and are unaffected by the shipped manifest's value.
- **Races:** none — a config value and a doc addition; no shared mutable runtime state.
- **Feedback loops:** none. The lint reads the manifest and source pins; it writes nothing. The auditor reads the registry; it writes nothing.

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents / users:** the standards registry gains one article (visible to any agent reading the constitution, and to the enforcement-coverage audit `GET /conformance/coverage` as one more enforced `gate` row). The manifest flip is invisible to end users (a CI/dev-time behavior). No runtime behavior changes for any running agent.
- **External systems:** none (no Telegram/Slack/GitHub/Cloudflare surface touched).
- **Persistent state:** none — no ledger, DB, or memory-file writes. Both changed files are git-tracked source.
- **CI:** the flip makes the model-freshness lint gating. The shipped manifest is clean under strict, so CI stays green today; a future stale/drifted pin will (by design) fail CI until reconciled — this is the intended ratchet, not a regression.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing action is added or touched. There is no dashboard form, approval page, or grant/revoke/secret surface in this change. Not applicable.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. This change touches no dashboard renderer/markup, approval page, or grant/revoke/secret-drop form (only a JSON config value, a markdown standards entry, and a unit test).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**replicated (via git-tracked source).** All three artifacts — `scripts/model-registry-freshness.manifest.json`, `docs/STANDARDS-REGISTRY.md`, and the test — are committed instar source, identical on every machine the moment they ship (the same distribution path as every lint and standard). The lint runs in CI (one canonical run) and locally per checkout; the `enforcement` value is the same everywhere by construction. There is no machine-local state, no per-machine scan-state touched here (the live scan-state remains dark/unwritten in this increment). It emits NO user-facing notices (no one-voice-gating concern), holds NO durable runtime state (nothing to strand on topic transfer), and generates NO URLs. The canonical/reviewed manifest layer is deliberately identical across machines (spec §1.1); only the LIVE scan-state layer is machine-local by design, and this increment does not touch it.

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release:** trivial. Set `scripts/model-registry-freshness.manifest.json` `"enforcement"` back to `"report"` (documented in the `$enforcementNote`) and ship as the next patch — the lint reverts to non-gating (prints findings, exits 0). The standard can be left in place (documentation) or removed in the same revert; the enforcement-coverage auditor treats its absence as one fewer article (non-gating).
- **Data migration:** none — no persistent state.
- **Agent state repair:** none — existing agents need no notification or reset; nothing runtime changed.
- **User visibility:** none — no user-visible runtime regression during a rollback window (the change is CI/dev-time + documentation only).

---

## Conclusion

This review confirms the increment is a documentation + config-value activation with no runtime block/allow surface. The single meaningful side effect is intended: the model-registry freshness lint becomes gating, and it is verified clean under strict before the flip (staleness fresh, all pins in their derived frontier sets, `flaggedStale` empty), so CI stays green today and only a genuine future drift/age-out fails the build — the anti-rot ratchet the standard names, ratified WITH its teeth per the spec's explicit precondition. Rollback is a one-line manifest edit. No design change was required by the review. Clear to ship — this completes the DOORWAY-MODEL-KNOWLEDGE-REGISTRY spec rollout.

---

## Second-pass review (if required)

Not required — see the header rationale (no runtime block/allow authority; the only gating is a build-time model-id-agnostic CI lint over git-tracked source).

---

## Evidence pointers

- `node scripts/lint-model-registry-freshness.mjs` → `enforcement=strict`, exit 0, PASS (staleness OK reviewed 2026-07-03 1d ago window 45d; all four pins in their derived frontier set; `flaggedStale` empty).
- `npx vitest run tests/unit/model-registry-freshness.test.ts` → 20 passed (incl. the strengthened shipped-manifest strict-and-clean assertion).
- `npx vitest run tests/unit/standards-enforcement-auditor.test.ts tests/unit/standards-registry-applied-through.test.ts tests/unit/standard-enforcement-extractor.test.ts` → 23 passed; the real-registry coverage audit classifies "Keep the Doorway/Model Map Current" as an enforced `gate`, danglingCount 0, total standards 70.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect fixed, and no self-triggered controller (loop/monitor/sentinel/reaper/scheduler/recovery path) added or modified — not applicable. This increment flips an existing CI lint's enforcement value and adds a constitutional-standard doc entry; it introduces no new control loop and fixes no defect in an LLM prompt/hook/config/skill/standards-text artifact.
