# Side-Effects Review — ai-employee-roadmap (docs-only)

**Change:** adds `docs/AI-EMPLOYEE-ROADMAP.md` — the program-level roadmap from
the apprenticeship program to a full AI-employee posture (multi-machine
coherence, first-class Slack citizenship, multi-principal service), with
per-capability stage ladders and evidence-gated exit bars. Plus the standard
artifacts (this review, the ELI16, the release fragment). **No source, config,
template, hook, job, or test files are touched.** Documentation-only, no
runtime surface.

## Phase 1 principle check (recorded)

Does this change involve a decision point? **No.** The document describes a
program and its graduation criteria; it ships no validator, gate, sentinel, or
any code that evaluates anything. The graduation decisions it describes are
explicitly human/overseer acceptances recorded as artifacts — and none of that
machinery ships here. Signal-vs-authority is not implicated: nothing here can
block, allow, or judge.

## 1. Over-block

Nothing can be over-blocked: documentation-only, no runtime surface. The change
introduces no blocking surface of any kind — no CI check, no gate, no hook. The
only "block" it could ever exert is social (a reader citing the roadmap), which
is outside the runtime.

## 2. Under-block

Nothing can be under-blocked: documentation-only, no runtime surface. No
enforcement is promised by this change, so there is no enforcement to be
incomplete. The exit bars the document names are enforced (or not) by the
machinery of their own workstreams, each with its own specs and reviews.

## 3. Level-of-abstraction fit

Right layer. A program-level roadmap belongs in `docs/` at the repo root
(`docs/AI-EMPLOYEE-ROADMAP.md`), above the individual capability specs it
references and below nothing — it is the map that points at the specs, not a
duplicate of any of them. It deliberately contains no schedule and no
organization-specific content (agent names, staffing, rollout order stay with
the operator, outside this public repo).

## 4. Signal vs authority compliance

Compliant vacuously: documentation-only, no runtime surface. The change creates
no authority (nothing blocks) and no signal (nothing observes). The document
itself *describes* the signal→authority discipline of the apprenticeship
(observe-only guards graduating to enforcing on evidence), which is consistent
with `docs/signal-vs-authority.md`, but describing it is not implementing it.

## 5. Interactions

None at runtime: documentation-only, no runtime surface. No job, sentinel,
route, or hook reads this file. Repo-level interactions are benign: it cites
existing specs (e.g. the apprenticeship scaffold spec, framework stall-coverage
work) by path; if those move, the references go stale — a docs-freshness
concern (the cartographer sweep's domain), not a behavior risk.

## 6. External surfaces

None: documentation-only, no runtime surface. No API route, no config key, no
message to any user, no notification, no npm-shipped runtime change (the file
rides the package inertly as documentation). The document was deliberately
written organization-agnostic for this public repo — it names no organization,
person, or deployed agent.

## 7. Multi-machine posture

**Unified-via-git.** The document is a repo-tracked file; every machine sees
the same content at the same SHA. No per-machine runtime state is created, so
there is nothing to strand, sync, or reconcile.

## 8. Rollback cost

Revert the doc (one revert of this commit). No data migration, no agent state,
no config, no deployed-behavior change to unwind. Cheapest possible rollback
class.

## Second-pass review

**Not required.** The second-pass trigger is for changes that wire
block/allow decisions, session-lifecycle, messaging, or dispatch behavior —
this change wires nothing: documentation-only, no runtime surface, no decision
point, no enforcement. There is no code for a second reviewer to contradict
against the artifact; the only reviewable claim ("the doc says what the ELI16
and fragment say it says") is verified by reading the three files side by side.
