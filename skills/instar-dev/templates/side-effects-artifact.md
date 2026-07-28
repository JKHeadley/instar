<!--
  Side-Effects Review Artifact — template.

  Fill in every section. "No issue identified" is a valid answer and must be
  stated explicitly. Omitting a section is NOT valid and the pre-commit hook
  will reject the commit.

  When shipping a release, rename this file to match the version:
    upgrades/side-effects/0.28.43.md
  For in-flight work, use a descriptive slug:
    upgrades/side-effects/signal-vs-authority-rework.md
-->

# Side-Effects Review — [change title]

**Version / slug:** `[0.28.43 or descriptive-slug]`
**Date:** `[YYYY-MM-DD]`
**Author:** `[agent or human name]`
**Second-pass reviewer:** `[agent name, or "not required"]`

## Summary of the change

[One paragraph. What this change does, at the level an experienced instar developer can orient in 30 seconds. Include the files touched and the decision points the change interacts with.]

## Decision-point inventory

[List every decision point this change touches. For each, state whether it's being added, modified, removed, or merely passed through. If the change has no decision-point surface, state that explicitly and skip the rest of this section.]

- `[Decision point name / location]` — [add | modify | remove | pass-through] — [one-line description]

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

[Concrete examples. "A legitimate user message containing the word 'test' would be blocked." Not abstractions — specific input shapes.]

[If the change has no block/allow surface, state: "No block/allow surface — over-block not applicable."]

---

## 2. Under-block

**What failure modes does this still miss?**

[Concrete examples. "A duplicate reply generated 6 minutes after the original would pass the 5-minute window." Specific scenarios, not abstractions.]

[If the change has no block/allow surface, state: "No block/allow surface — under-block not applicable."]

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

[Answer specifically: is this a detector (low-level, cheap, brittle)? An authority (high-level, context-rich, reasoning)? Or something that should have been one and is accidentally the other? Does a higher-level gate already exist that this should FEED instead of running parallel-to? Does a lower-level primitive already exist that this should USE instead of re-implementing?]

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design. Brittle detectors must not own block authority. Either promote the logic to smart-gate level (with proper context) or demote it to a signal that feeds an existing smart gate.

[Narrative explanation of which checkbox applies and why.]

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**Does this change add a static heuristic at a competing-signals decision point? If yes: why is it not a judgment point within a floor?**

[A "competing-signals decision point" is one where multiple live signals (work evidence, liveness, recency, ownership, urgency) can genuinely conflict and the right answer is not statically enumerable. Per the **Judgment Within Floors** standard (`docs/STANDARDS-REGISTRY.md`), a new static heuristic at such a point must state why it is not a judgment point — valid answers include: the domain is enumerable (it's an invariant, name it), the choice is a safety guard on an irreversible action (deterministic by design), or a floor + arbiter is declared in the driving spec's `## Decision points touched` section. "No new static heuristic at a competing-signals decision point" is a valid answer and must be stated explicitly.]

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** does this run before/after an existing check, and could it shadow it or be shadowed?
- **Double-fire:** could this and another piece of infrastructure both act on the same event?
- **Races:** does this share state with concurrent code (cleanup, retry, lifecycle)?
- **Feedback loops:** does this change input to a system that feeds back into it?

[Concrete findings per bullet. "The new check runs before the existing X check in `/telegram/reply`. If the new one returns 422, X never runs — we confirmed X isn't relied on for logging." Not abstractions.]

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- Other agents on the same machine?
- Other users of the install base?
- External systems (Telegram, Slack, GitHub, Cloudflare, etc.)?
- Persistent state (databases, ledgers, memory files)?
- Timing or runtime conditions we don't fully control?
- **Operator surface (Mobile-Complete Operator Actions):** does every operator-facing action this change adds or touches have a phone-completable surface — a dashboard form or a link the agent can send? A PIN-gated or approval-class route with no human surface is an incomplete feature, not a finished API (the 2026-06-12 floor-grant lesson: the route was correct, signed, audited — and laptop-bound). "No operator-facing actions" is a valid answer; an API-only operator action is not.

[Specific findings. "The response format for 422 changes — callers parsing the `issue` field will still see a non-empty string. Verified in telegram-reply.sh." "No external surface changes" is also valid if true.]

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

**REQUIRED whenever this change touches an operator surface** — a dashboard renderer/markup file (`dashboard/*.js`, `dashboard/*.html`), an approval page, or a grant/revoke/secret-drop form. The pre-commit gate (`scripts/instar-dev-precommit.js`) refuses the commit if this section is missing when an operator-surface file is staged. Reachable-but-bad still fails the operator (the 2026-06-12 "abysmal" Mandates-grant-form lesson, CMT-1434): Mobile-Complete asks *can they do it from a phone?*; this asks *is it good when they do?*

Answer each in writing (a "no" or unjustified "n/a" blocks the commit):

1. **Leads with the primary action?** The thing the operator came to do is visible and actionable on arrival — never collapsed behind a toggle, below the fold, or after explanatory prose.
2. **Zero raw internals as primary content?** No JSON blobs, fingerprints, UUIDs, hashes, or enum/slug values shown as headline content — only human language; identifiers de-emphasized as support metadata when genuinely needed.
3. **Destructive actions de-emphasized?** Revoke/delete/stop is visually quieter than the constructive primary action and never appears above it.
4. **Plain language + phone width?** Labels/states read the way a non-engineer would say them; verified at phone width — real tap targets, readable type, no horizontal scroll, no truncated table hiding the answer.

[Specific findings per criterion. "Grant form renders open as the card's primary block (mnd-grant-block); Revoke demoted to a collapsed mnd-revoke-details below it; bounds/fingerprints humanized, raw ids kept only on the muted 'For support' line; audit table stacks at ≤640px." If this change touches NO operator surface, state: "No operator surface — not applicable."]

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**When this agent runs on MORE THAN ONE machine, what is this feature's posture?**
Declare exactly one, with the reason. "I didn't think about multi-machine" is the
defect this section exists to catch — ~20 features shipped machine-blind before this
question was added (2026-06-12 audit, topic 13481; the converged
MULTI-MACHINE-SEAMLESSNESS-SPEC is the cleanup bill).

- **replicated** — the state/behavior follows the agent across machines (name the
  replication path: coherence-journal kind, secret-sync, heartbeat field, …).
- **proxied-on-read** — machine-local state served pool-wide via a merged/scoped read
  (name the read: `?scope=pool`, mesh relay, …).
- **machine-local BY DESIGN** — give the reason it SHOULD differ per machine
  (machine-specific truths, security boundary, pure per-machine observability).
  "By design" without a reason is not an answer.
- **single-machine-only assumption** — NOT a valid posture for new features. If the
  feature breaks or duplicates when a second machine exists (double notices, stranded
  state, dashboard blindness, broken links), that is a finding to resolve before
  shipping, not a posture to declare.

Also answer explicitly: does it emit user-facing notices (one-voice gating needed?),
hold durable state (does it strand on topic transfer?), or generate URLs (do they
survive machine boundaries?).

[Specific. "Machine-local by design: the reap-log is a per-machine audit trail; the
pool-wide question is answered by a proxied-on-read merged view." Not abstractions.]

---

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release:** revert the code change, ship as next patch.
- **Data migration:** does the change leave persistent state that needs cleanup?
- **Agent state repair:** do existing agents need to be notified or reset?
- **User visibility:** will users see a regression while rollback propagates?

[Be honest. "Pure code change — revert and ship a patch. No persistent state, no user-visible regression during rollback window." Or: "Introduces a new column in the jobs ledger. Rollback requires deleting the column, which will need a small migration. Estimated 10 minutes downtime."]

---

## Conclusion

[One paragraph. What this review produced. Any design changes made because of the review. Any concerns flagged for follow-up. Whether the change is clear to ship or needs another iteration.]

---

## Second-pass review (if required)

**Reviewer:** [agent name]
**Independent read of the artifact: [concur | concern]**

[If concur: one sentence affirming the review's conclusions. If concern: specific issues raised, one per bullet, with recommended resolution.]

---

## Evidence pointers

[Optional. Links or file paths to the live verification artifacts produced during `/build` — reproduction steps, before/after logs, test output. These feed the "Evidence" section in the upgrade notes if the change is shipping as a release.]

---

## Class-Closure Declaration (display-only mirror)

**REQUIRED whenever this change FIXES a defect in an agent-authored artifact** (an
LLM prompt, hook, config, skill, or standards text — see
`docs/specs/class-closure-gate.md`) **— OR adds/modifies a self-triggered
controller (the `unbounded-self-action` class: a loop, monitor, sentinel,
reaper, scheduler, or recovery path that fires a restart / swap / respawn /
spawn / notify / retry / re-drive / kill on its own — see
`docs/specs/self-action-convergence.md`).** For the self-action case, author the
convergence argument (control-loop edge + steady-state bound + settling brake)
INTO `guardEvidence.howCaught`, and cite the ratchet
`tests/unit/self-action-convergence.test.ts`. This section is the human-readable MIRROR of
the machine-readable `classClosure` block in the commit's decision-audit entry
(the host the CI lint validates). **Display-only:** the lint counts the
decision-audit host ONLY and NEVER sums this mirror — the two are asserted to
AGREE, never added (C1). If this change fixes no agent-authored-artifact defect,
state: "No agent-authored-artifact defect — not applicable."

- **`defectClass`** — a class id from `docs/defect-classes.json`, or `novel`. A
  `novel` class is not a free pass: it REQUIRES a full new registry entry in the
  same change carrying `nearestExistingClass` + ≥1 `includes` + ≥1 `excludes` +
  `severity`, and it enters `status: "unconfirmed"` (an unconfirmed class CANNOT
  satisfy `closure: guard` — its fix carries `closure: gap` until the operator
  confirms it).
- **`closure`** — either `guard` (the standard/test/lint that makes the class's
  recurrence structurally refused or detected, cited by path/symbol) or `gap` (a
  tracked standards-gap evolution-action id when the class-level guard is out of
  this fix's scope).
- **`guardEvidence`** (required with `closure: guard`) — the guard's enforcement
  type as graded by the coverage audit's grader (`ratchet` / `gate` / `lint`),
  the citation, and one line on *how this guard would have caught THIS defect*. A
  citation that does not resolve to a LIVE enforcing guard on disk automatically
  downgrades the declaration to `closure: gap` (G3 — a dark/spec-only artifact
  guards nothing).
- **`gap`** (with `closure: gap`) — the evolution-action id tracking the missing
  guard. A gap is not fire-and-forget: it counts as escalation evidence and
  re-surfaces on the evolution-action cadence.

[Fill in the four fields (or "not applicable"). Example: "`defectClass:
injection-credulity`, `closure: guard`, `guardEvidence: {enforcementType: gate,
citation: src/core/promptClauses.ts#authorityClause, howCaught: the authority
clause separates the trusted instruction surface from the quoted untrusted
transcript excerpt, so the injected instruction is data not command}`."]
