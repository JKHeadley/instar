# Side-Effects Review — ACT-1174: two deterministic lint floors (Standards A + B)

**Version / slug:** `act1174-lint-floors`
**Date:** `2026-07-04`
**Author:** `echo (build hand)`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

Ships the two DEFERRED deterministic lint floors named in
`docs/specs/three-standards-enforcement.md` (§178-202 for A, §256-289/§343-361 for B) —
the "registry ship" the spec hard-sequences against each standard's registered guard.
Two no-LLM parser scripts + their unit tests + fixtures, plus the STANDARDS-REGISTRY
guard-registration rows that let the conformance auditor grade Standards A and B as
enforced by a deterministic `lint`.

Files touched:
- `scripts/lint-machine-local-justification.js` — Standard A marker floor (no-LLM).
- `scripts/lint-self-heal-fields.js` — Standard B self-heal field-schema floor (no-LLM).
- `tests/unit/lint-machine-local-justification.test.ts`, `tests/unit/lint-self-heal-fields.test.ts` — self-tests.
- `tests/fixtures/spec-lint/*.md` — positive / negative / bidirectional / out-of-scope fixtures.
- `docs/STANDARDS-REGISTRY.md` — the two `**Applied through.**` rows now cite the lints (enforcement registration, NOT new ratification prose).
- `upgrades/eli16/act1174-lint-floors.eli16.md`, `upgrades/side-effects/act1174-lint-floors.md`, `upgrades/next/act1174-lint-floors.md` — gate artifacts.

No constitutional text is minted or re-ratified (the standard TEXTS were ratified by the operator 2026-07-03). No runtime `src/` code changes.

## Decision-point inventory

- `Standards Enforcement-Coverage auditor classification (StandardsEnforcementAuditor)` — pass-through — the audit reads the registry and now classifies A + B as `lint` because the two rows cite `scripts/lint-*.js` (verified: baseline lint 0 → 2, A/B out of the gaps list, dangling still 0).
- `/spec-converge integration reviewer` — pass-through — the semantic authority is unchanged; these lints are the deterministic SIGNAL beneath it.

---

## 1. Over-block

The lints DO have a block/allow surface, but ONLY under `--strict`. In report mode (the shipped default) they never block. Under `--strict` the plausible over-block is: a spec that legitimately mentions "machine-local" inside its `## Multi-machine posture` section as prose discussion (not a real surface) would trip A1. This is mitigated by scoping A1's trigger to the posture section AND skipping `<placeholder>` marker values, and by the report-first default — a false positive is a printed line, never a blocked commit. `--strict` is opt-in (tests + a future graduation), so no live over-block exists today.

---

## 2. Under-block

The deterministic floor is PRESENCE + well-formedness only, by design (Signal vs. Authority). It misses: a marker whose key is valid but substantively WRONG (A), and a self-heal whose fields are all present but whose remediation is a plausible-but-ineffective no-op or whose severity class is dishonestly `recoverable` (B). Those are exactly the semantic calls left to the `/spec-converge` reviewer — the lint is not meant to catch them. A spec that omits a posture section entirely is also not flagged (that is the reviewer's §168 call).

---

## 3. Level-of-abstraction fit

Correct layer: a cheap, brittle DETECTOR that produces a signal, explicitly paired with the existing high-context `/spec-converge` reviewer that owns the semantic authority. This is the constitutional Signal-vs-Authority / Body-and-Mind split the spec mandates (§87-95). The lint does NOT hold blocking authority over a merge in its shipped (report) mode.

---

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change produces a signal consumed by an existing smart gate (the `/spec-converge` integration reviewer), and in its shipped mode it does not block at all.

The lints are deterministic signals. Their `--strict` FAIL capability exists for tests and a future, separately-decided CI graduation; it is not wired into the blocking `npm run lint` chain. The reviewer holds semantic authority.

---

## 5. Interactions

- **Shadowing:** none. The lints are standalone scripts, not wired into the blocking lint `&&`-chain, so they cannot shadow an existing lint or be shadowed.
- **Double-fire:** none. No runtime path invokes them; they are dev/CI tooling run explicitly or by their tests.
- **Races:** none. Pure fs-read parsers, no shared state.
- **Feedback loops:** none.

The one real interaction is the Standards Enforcement-Coverage auditor: the registry rows now resolve to on-disk `lint` guards, which RAISES the enforced ratio (0.4429 → 0.4714). That is the intended effect, not a regression; the coverage ratchet (`standards-coverage.mjs --check`) passes (floors: ratio ≥ floor, dangling ≤ 0).

---

## 6. External surfaces

- Other agents on the same machine? No.
- Install base? These are instar-repo dev/CI tooling; they do not ship into agent homes as runtime behavior.
- External systems? No.
- Persistent state? No (the coverage script's `.instar/standards-coverage.json` output is untracked runtime state, never a committed baseline).
- Operator surface (Mobile-Complete): No operator-facing actions — dev/CI tooling only.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN — pure per-machine dev/CI tooling with no durable state.** These lint scripts + tests + fixtures are repo source, replicated to every machine via git like all source (so there is no per-machine divergence to reconcile). They emit no user-facing notices (no one-voice gating needed), hold no durable state (nothing to strand on a topic transfer), and generate no URLs. The registry rows they add are likewise git-replicated source. There is no runtime state surface introduced by this change, so the multi-machine posture question is satisfied structurally: source is uniform across machines by construction.

---

## 8. Rollback cost

Pure additive dev/CI change — revert the commit and ship as the next patch. No persistent state, no data migration, no agent-state repair, no user-visible regression. The registry rows revert cleanly (the conformance auditor simply re-grades A/B back to their prior kind). Because the lints ship report-first and are not in the blocking chain, a rollback cannot un-block anything that was blocking.

## Conclusion

The review produced no design changes. The two lints are correctly scoped as deterministic signals beneath the existing reviewer authority, ship report-first per the spec's honesty / hard-sequencing clause, and are registered so the conformance auditor grades Standards A and B as `lint`-enforced. Clear to ship as a Tier-1 change.

---

## Second-pass review (if required)

**Reviewer:** not required (Tier 1)
**Independent read of the artifact: [concur]**

Tier-1 low-risk additive tooling; no independent reviewer required per the tier policy.

---

## Evidence pointers

- `npx vitest run tests/unit/lint-machine-local-justification.test.ts tests/unit/lint-self-heal-fields.test.ts` → 13 passed (7 A + 6 B).
- `node scripts/standards-coverage.mjs` → `lint 2` (baseline 0), A/B absent from the gaps list, dangling 0, enforced-ratio 0.4429 → 0.4714.
- Manual fixture runs: A good-defended/good-ratified pass `--strict`; A-bad-undefended (A1), A-bad-spurious-key (A2), A-bad-ratified-noref (A2) fail `--strict`; B-good-complete + B-out-of-scope pass; B-bad-missing-fields (B1), B-bad-noop-and-unitless (B2/B3/B4) fail `--strict`; report mode exits 0 on all bad fixtures.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable. This change adds enforcement lints; it does not fix a defect in an LLM prompt/hook/config/skill/standards-text, and it introduces no loop/monitor/sentinel/reaper/scheduler/recovery path.
