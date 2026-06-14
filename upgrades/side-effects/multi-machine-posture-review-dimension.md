# Side-Effects Review — Multi-machine posture review dimension (Cross-Machine Coherence widening)

**Trigger:** operator question, 2026-06-12 topic 13481 ("we have developed so many
features that have gaps … is it the constitution or our enforcement?"). The audit
answer: both, but chiefly enforcement — NO review surface ever asked the multi-machine
question, so ~20 features shipped machine-blind.
**Change:** (1) side-effects template gains mandatory §7 "Multi-machine posture"
(replicated / proxied-on-read / machine-local-by-design-with-reason; single-machine
assumption is a finding, not a posture); (2) the matching Phase-4 question in the
instar-dev SKILL; (3) a mandatory posture check in spec-converge's
integration/deployment reviewer charter; (4) the Cross-Machine Coherence article's
"Applied through" widened to name these gates (so the conformance audit can verify
them); (5) PostUpdateMigrator migration delivering the updated skill content to
deployed agents (Migration Parity, "updating existing skill content" — pattern copy of
migrateSpecConvergeFoundationAudit: marker-sniffed, fingerprint-guarded, idempotent,
customized files untouched).

## 1. Over-block
The new review question blocks nothing programmatically — it is a required SECTION in
a review document and a reviewer charter line. The cost it adds is one honest
paragraph per change. A genuinely machine-agnostic change answers "machine-local by
design: <reason>" in one line. No legitimate change becomes unshippable.

## 2. Under-block
The question is willpower-adjacent until the conformance audit verifies the section's
presence (the registry now names the gates, which is what the Standards Enforcement
Coverage audit reads). A reviewer can still write a lazy posture answer — the
spec-converge integration reviewer's charter makes a silent single-machine assumption
a MATERIAL finding, which is the structural counterweight. Programmatic
section-presence checking in the pre-commit gate is a natural ratchet if lazy answers
show up (the registry text gives it a home).

## 3. Level-of-abstraction fit
Right layer: the defect was a missing QUESTION at review time, so the fix adds the
question to both review surfaces (side-effects + spec-converge) and anchors it in the
constitution article those surfaces trace to. Not duplicated logic — one rule, named
in the registry, asked at the two existing chokepoints.

## 4. Signal vs authority compliance
No new blocking authority. The template/charter additions are review-content
requirements; the only "block" is the existing spec-converge materiality bar, which is
already the convergence mechanism. The migration is a content patch with no decision
logic.

## 5. Interactions
- The migration follows the established skill-content-update pattern and runs once
  (marker check). It cannot fight installBuiltinSkills (which never overwrites).
- Renumbering Rollback cost §7→§8 in the template: existing committed artifacts are
  unaffected (the pre-commit gate checks artifact existence/coverage, not section
  numbering).
- The spec-converge charter addition extends the integration reviewer's prompt
  composition; no phase logic changes.

## 6. External surfaces
None outside the install base. Deployed agents receive updated skill files on their
next update via the migration; operator-customized files are left untouched and
reported in the migration result.

## 7. Multi-machine posture (Cross-Machine Coherence)
**machine-local BY DESIGN, with reason** — these are agent-installed skill/template
files: each machine's install legitimately carries its own copy at its own installed
version, kept current per machine by PostUpdateMigrator on that machine's update
cycle. Version skew between machines is bounded by the existing update train (drift
promoter). No user-facing notices, no durable runtime state, no generated URLs.
(This section is itself the new question, answered — dogfooded on its own PR.)

## 8. Rollback cost
Revert the template/SKILL/registry edits and ship; the migration is marker-gated so a
reverted bundle simply stops patching (already-patched agents keep the question — a
benign residue: it asks reviewers for one honest paragraph). No data, no config, no
runtime behavior.

## Second-pass review
Not required — no block/allow decisions, no session lifecycle, no
gate/sentinel/watchdog runtime surface (docs/skills content + a content-patch
migration following an established pattern).
