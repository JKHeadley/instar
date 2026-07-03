# Side-Effects Review — Three Operator-Ratified Constitutional Standards (multi-machine-always, self-heal-before-notify, alerts-topic-routing)

**Version / slug:** `three-constitutional-standards`
**Date:** `2026-07-03`
**Author:** Echo (autonomous)
**Second-pass reviewer:** not-required (Tier 1; documentation-only, no runtime surface, no decision point)

## Summary of the change

This change lands the TEXT of three operator-ratified constitutional standards into the constitution and nothing else. It touches two documentation files and adds this review's gate artifacts:

- `docs/STANDARDS-REGISTRY.md` — three new enforceable standard entries: (A) *An Instar Agent Is Always a Multi-Machine Entity*, (B) *Self-Heal Before Notify — The Operator Hears Only When Self-Healing Fails*, (C) *Notices Route to the Alerts Topic, Never a New One*.
- `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` — matching lessons-catalog entries P21, P22, P23, and the reviewer-loop range bump (P1-P20 → P1-P23).
- `docs/specs/three-constitutional-standards.eli16.md` — the plain-English ELI16 overview (this Tier-1 gate artifact).
- `upgrades/side-effects/three-constitutional-standards.md` — this artifact.
- `upgrades/next/three-constitutional-standards.md` — the release-note fragment.

No `src/`, `scripts/`, hook, skill, job, template, or route is touched. This is constitution text. The three standards each name an enforcement build in their "Applied through" section, but that build is a separate, tracked follow-up — it is NOT part of this change. There is no runtime surface here and no decision point is added, modified, removed, or shadowed.

## Decision-point inventory

This change has NO decision-point surface. It adds no gate, sentinel, watchdog, hook, or route; it blocks, allows, filters, or routes nothing at runtime. The standard texts describe decision points that a FUTURE enforcement build will implement, but this change lands only the prose. The rest of this section is intentionally empty per the template's "state that explicitly and skip the rest" instruction.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. This change adds no runtime code path; it rejects nothing at runtime. The one "gate" it interacts with is the spec-converge lessons-aware reviewer, which merely READS these entries and asks their questions of future specs — a reasoning input, not an automated blocker.

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable. There is no runtime check to miss a failure mode. The honest limitation is that landing the TEXT does not by itself enforce the standards: until the tracked enforcement build ships, a spec could still ship an undefended machine-local surface, a first-notify watcher, or a per-alert topic without an automated block. That gap is explicitly named in each standard's "Applied through" section and is out of scope for this text-only change.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Correct layer. These are constitutional standards, so the constitution (`docs/STANDARDS-REGISTRY.md`) and the lessons catalog (`docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`) are exactly where they belong — they are the documents the spec-converge lessons-aware reviewer already loads. Standard (A) is deliberately placed as a sibling of the existing *Cross-Machine Coherence* standard and explicitly distinguishes itself from it (coherence governs lease/seamlessness robustness; (A) governs the default posture of every new feature). Standard (C) is placed as the routing corollary of the existing *Bounded Notification Surface* (P17). No lower-level primitive is re-implemented; each entry points at the machinery that already exists and names the enforcement build that will make it load-bearing.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

This is documentation text. It holds no authority of any kind at runtime — it neither blocks, delays, nor rewrites any message or action. Notably, standard (B) *Self-Heal Before Notify* itself encodes the signal-vs-authority spirit for the future enforcement build (a watcher self-heals first and escalates only on exhaustion), but landing (B)'s text adds no authority now.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** none. No runtime check runs before or after another. The only consumer of these entries is the spec-converge lessons-aware reviewer, which reads them additively.
- **Double-fire:** none. No event is acted on.
- **Races:** none. No shared runtime state is written.
- **Feedback loops:** none at runtime. The one intended "loop" is intellectual: these entries feed the spec-converge reviewer, which asks their questions of future specs — the designed effect, not an uncontrolled feedback path.
- **Document-level composition:** (A) is explicitly reconciled against *Cross-Machine Coherence*; (B) is explicitly composed with *No Silent Degradation* and *Near-Silent Notifications*; (C) is explicitly composed with *Bounded Notification Surface (P17)*. Each entry names the relationship rather than silently overlapping, so no reader is left to guess which standard governs.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- Other agents on the same machine? No.
- Other users of the install base? Only as documentation — instar agents read the constitution; these entries become visible to the spec-converge lessons-aware reviewer on the next spec review. No behavior changes.
- External systems (Telegram, Slack, GitHub, Cloudflare)? No.
- Persistent state (databases, ledgers, memory files)? No — no state file is written or migrated.
- Timing or runtime conditions? No.
- **Operator surface (Mobile-Complete Operator Actions):** No operator-facing action is added or touched. This change adds no dashboard form, no approval page, no grant/revoke/secret-drop surface, and no PIN-gated or approval-class route. Not applicable.

No external surface changes.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. This change touches no dashboard renderer/markup file, no approval page, and no grant/revoke/secret-drop form. It is documentation only.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**When this agent runs on MORE THAN ONE machine, what is this feature's posture?**

**replicated** — these are constitution DOCS. The documentation tree (`docs/`) is versioned in git and ships to every machine through the same git-based distribution as all instar source; there is no per-machine copy and no per-machine divergence. A standard written once is identical on every machine by construction.

Notably, this is the FIRST change authored *under* standard (A), and it satisfies (A) by default: its posture is unified (git-replicated), not machine-local, and it names the replication path (git). It emits no user-facing notice (nothing to one-voice-gate), holds no durable runtime state (nothing to strand on topic transfer), and generates no URLs (nothing to survive a machine boundary).

---

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Trivial. Pure documentation change — revert the commit (or ship a follow-up docs edit) and it is gone. No persistent state to clean up, no data migration, no agent state to repair, and no user-visible runtime regression during the rollback window. The only "cost" of a wrong standard is that the spec-converge lessons-aware reviewer would cite a bad rule until the revert lands — caught at spec-review time, not in a live incident.

---

## Conclusion

This review confirms the change is documentation-only with no runtime surface, no decision point, and no external side effect. It lands the three operator-ratified standard texts (registry + lessons entries) and their Tier-1 gate artifacts. Multi-machine posture is unified-by-git-replication — and this change is itself the first artifact authored under the standard (A) it introduces, satisfying it by default. Rollback is a one-commit revert. The change is clear to ship. The enforcement build that mechanically polices each standard is a tracked, separate follow-up and is explicitly out of scope here.

---

## Second-pass review (if required)

Not required. Tier 1, documentation-only, no block/allow surface, no session-lifecycle or gate/sentinel/watchdog/guard code — the Phase-5 high-risk triggers do not apply to a text-only constitution change.

---

## Evidence pointers

- `git show --stat 11923c4c4` — the two docs files already committed (STANDARDS-REGISTRY + lessons catalog), 84 insertions.
- `docs/specs/three-constitutional-standards.eli16.md` — plain-English overview, 6.8k chars (well over the 800-char floor), first-heading body ~1k chars before the first subheading.
- `node scripts/pre-push-gate.js` — release-note fragment validates and the fresh side-effects artifact is present (this file).
