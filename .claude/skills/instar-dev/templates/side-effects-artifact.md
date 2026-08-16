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

[Specific findings. "The response format for 422 changes — callers parsing the `issue` field will still see a non-empty string. Verified in telegram-reply.sh." "No external surface changes" is also valid if true.]

---

## 7. Rollback cost

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
