# Enforcement fingerprints — the measurement pass

**Charter item from Justin, 2026-08-08.** For each standard: WHERE, WHEN and HOW is it enforced — and
how do we know that set of enforcement points is complete enough that violations cannot sneak through
between them?

**Status:** step 1 only (MEASURE FIRST). Steps 2-4 — a fingerprint field on every standard, required at
birth, with dated findings where the fingerprint is empty at the critical moment — are not built yet
and are not claimed here.

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
  unmeasurable. `2026-09-07`, tracked as `STD-SUBCOUNTDOWN-outbound-verdict-record`.
- No standard in the registry carries a fingerprint field, so no standard's moment-coverage can be
  checked at all. `2026-09-07`, tracked as `STD-SUBCOUNTDOWN-fingerprint-field`.

## 6. What is NOT claimed here

That the five self-stop rules are broken. They may be working exactly as designed and the 2026-08-07
message may have fallen honestly outside their populations — I cannot tell, and neither can anyone
else, which is the point. Establishing that would need the verdict record that does not exist.
