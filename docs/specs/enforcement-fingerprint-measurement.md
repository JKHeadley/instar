# Enforcement fingerprints — the measurement pass

**Charter item from Justin, 2026-08-08.** For each standard: WHERE, WHEN and HOW is it enforced — and
how do we know that set of enforcement points is complete enough that violations cannot sneak through
between them?

**Status, updated 2026-08-08 (evening).** Step 1 (this document) measured the surfaces. **Step 3 is
built** — `scripts/lint-enforcement-fingerprint.mjs` refuses a NEW standard with no fingerprint. **Step 4
is built in shape** — the two dated findings below are now gap records in `docs/enforcement-gaps.json`.
**Step 2 is NOT done**: 86 of 87 standards carry no fingerprint and sit in a shrink-only grandfathered
baseline. Retrofitting them is real per-standard analysis, not a formatting pass.

## 0. Vocabulary (fixed by the operator, 2026-08-08)

| Term | Meaning |
|---|---|
| **STANDARD** | a rule we enforce |
| **SURFACE** | a place where enforcement can act (§1) |
| **MOMENT** | when a surface acts (§2) |
| **FINGERPRINT** | a standard's recorded mapping — which surfaces watch it at which moments, plus what its violations look like |
| **GAP** | a recorded **failure-shape**: the way a violation slipped past a fingerprint |

**The gap-propagation loop** is the design's payoff, and it is the operator's extension rather than
mine. When a standard fails *despite* a fingerprint, that failure is evidence about **fingerprints**, not
about that one standard. So a gap records the **nature** of how it got through — stated so it can be
matched against others — and is swept against every fingerprint, so one failure upgrades every standard
sharing the hole-shape. The week that produced this is the proof: `alive-but-inert` appeared in three
independent guards inside 48 hours, and under this loop the first would have flagged the other two before
they failed.

The mechanism that keeps a sweep honest is **staleness**: a sweep records the exact population it ran
against, so the moment a standard gains a fingerprint, every sweep that predates it fails. You cannot add
a fingerprint without checking it against every known failure-shape. Proven by injection, not asserted:
attaching a fingerprint to a second article turned all three sweeps red simultaneously.

---

## 1. The surfaces that actually exist, counted

Counted from the tree, not asserted. Each number is reproducible.

| # | Surface class | Count | What it is |
|---|---|---:|---|
| 1 | CI workflows | 12 | workflow files |
| 2 | CI jobs | 25 | distinct jobs across those workflows |
| 3 | Build-time lint chain | 42 | `node scripts/…` entries in the lint script |
| 4 | Git hooks | 2 | `pre-commit`, `pre-push` |
| 5 | Scheduled job templates | 33 | shipped job definitions |
| 6 | Per-outbound-message rules | 21 | `B…` rules in the messaging tone gate |
| 7 | Response reviewers | 11 | reviewer modules |
| 8 | Session hook scripts | 12 | installed agent hooks |

**The point of the count is not the total.** It is that these are *different moments*, and a standard
can be covered at several of them and still be unguarded at the one that matters.

## 2. The moments, which is the axis the registry has never recorded

1. **Author-time** — session-start injection, the dispatch table (surfaces 8)
2. **Commit-time** — pre-commit, the instar-dev gate (4)
3. **Push-time** — pre-push (4)
4. **CI-time** — 25 jobs, 42 lints (1, 2, 3)
5. **Per-outbound-message** — 21 tone-gate rules, 11 reviewers (6, 7)
6. **Periodic** — 33 scheduled jobs (5)
7. **Always-on runtime floors** — spawn cap, test-runner bound, permission-prompt resolver

A standard's fingerprint is the subset of these moments where something actually acts on it, plus the
argument that the moments its violations OCCUR at are inside that subset.

## 3. The case that motivated this, re-measured — and it is worse than "no surface"

Justin's framing was that the self-unblock standard "passed every existence check and still failed,
because nothing enforced it at the one moment violations occur: the sending of an escalation."

**Measured, that framing is too kind to us. Something IS there at that moment.** The tone gate carries
five rules in exactly this family, all classified `blocking`:

`B15_CONTEXT_DEATH_STOP` · `B16_UNVERIFIED_WALL` · `B17_FALSE_BLOCKER` · `B18_AUTONOMY_STOP` ·
`B19_PARKED_ON_USER`

And their populations plausibly cover what happened on 2026-08-07. B16 catches telling the user a path
is blocked "WITHOUT any evidence that the agent first inventoried the capabilities it already has."
That is a fair description of reporting a peer agent's dead channel as an external blocker and waiting.
B19 catches deferring a follow-up action onto the user.

**The gate was live** — it held one of my messages earlier today for an unrelated leak. So: the moment
was watched, by rules whose stated population plausibly covers the manifestation, and the violation
went through anyway.

## 4. Why we cannot say more than that — which is the finding

**The gate's rule-level verdicts are not recorded anywhere.** The advisory log
(`GET /messaging/advisory-log`) captures the DETERMINISTIC preflight layer — entries carry
`advisories: []` and `action: "clean"` — and nothing on disk records which `B…` rules were evaluated
against a message or what each returned.

So for the surface that sits at the most consequential moment we have, we cannot answer:

- did the rule fire and get overridden, or never fire at all?
- is its population too narrow for this manifestation, or was the judgement simply wrong?
- has it ever fired?

**A surface whose decisions leave no trace cannot be audited for effectiveness.** That is precisely why
the 2026-08-07 failure was invisible: not because nobody was watching the moment, but because nothing
recorded that the watcher looked and passed it.

## 5. What this means for the fingerprint design

If a fingerprint records only *which surface* and *which moment*, it is an existence claim wearing a
new name — and we will have rebuilt this week's central defect one level up. A fingerprint needs three
legs, and today only the first is available for most surfaces:

1. **Which surface, at which moment** — derivable now.
2. **Which manifestations it covers** — stated by the rule, checkable only by reading its population.
3. **Observed effectiveness** — has it ever fired, and on what — which requires the surface to keep a
   record. For the tone gate, leg 3 does not exist.

**Dated findings, not papered over:**

- The per-outbound-message surface — the one guarding the moment where self-unblock, sovereignty and
  the whole self-stop family manifest — keeps no rule-level verdict record, so its effectiveness is
  unmeasurable. `2026-09-07`, tracked as `STD-SUBCOUNTDOWN-outbound-verdict-record`. **Now recorded as
  `GAP-watched-but-unauditable`** in `docs/enforcement-gaps.json`, swept.
- No standard in the registry carries a fingerprint field, so no standard's moment-coverage can be
  checked at all. `2026-09-07`, tracked as `STD-SUBCOUNTDOWN-fingerprint-field`. **Now recorded as
  `GAP-no-moment-declared`**, swept.

A third gap was recorded at the same time because it is the loop's proof case rather than a new
discovery: **`GAP-alive-but-inert`**, the shape behind all three of this week's guard failures. Its sweep
found something on day one — *Deferral = Deletion*'s fingerprint cites two surfaces, and only ONE of them
has a proven negative control. The commit-time arm is believed to work because it has been in place a
long time, which is exactly the belief this shape defeats. That finding is the loop working: a shape
learned from three OTHER guards immediately flagged a half-proven claim in the newest one.

## 6. What is NOT claimed here

That the five self-stop rules are broken. They may be working exactly as designed and the 2026-08-07
message may have fallen honestly outside their populations — I cannot tell, and neither can anyone
else, which is the point. Establishing that would need the verdict record that does not exist.
