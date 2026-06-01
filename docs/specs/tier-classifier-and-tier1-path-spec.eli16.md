# Plain-English overview: the gate that suggests a tier and opens a lighter lane

## What this is

This is the first build step of the tiered-development project you approved. It changes
the commit gate (the check that runs every time the agent tries to commit code) to do two
new things:

1. **Suggest a tier.** Before a commit, the gate looks at how big the change is *and* how
   risky it is, and prints a suggested tier (1, 2, or 3) with the reasons. A tiny,
   low-risk change → suggested Tier 1. Anything near the dangerous areas (secret-handling,
   auth/tokens, the message-delivery path, the destructive-file/git guards, or the
   migration/fleet-release machinery) → bumped up,
   no matter how small.

2. **Open the Tier-1 lane.** If the change is Tier 1, the agent can commit it with just a
   plain-English overview (ELI16) + a short side-effects note + passing tests — **no
   full pre-approved spec.** Bigger changes (Tier 2 and up) still go through the full
   spec process exactly as today.

## The important part: the gate suggests, the agent decides

This is the new constitution article ("The Body and the Mind") in action. The gate does
**not** decide the tier — it *suggests* one and shows its reasoning. The **agent** picks
the final tier and writes down *why*. Every one of those decisions is **recorded** to a
log (what the gate suggested, what the agent chose, and why). If the agent ever picks a
*lower* tier than the risk signals warrant, the gate doesn't block it — but it prints a
loud notice and stamps the record as an "override," so it's visible and reviewable.

That record is a **learning signal, not a security wall**: it only catches cases the gate
*noticed* were risky, and the agent could still under-declare a risk the heuristics missed.
The real human gates are the **pull-request review** (every Tier-1 change is a PR you see)
and the **operator spot-check** on auto-merge. What the log gives us is the data to make
both the gate's suggestions and the agent's judgment better over time — and to grow the
risk list when a blind spot shows up.

## What already exists / what's new

- The commit gate, the spec requirement, the ELI16 requirement, and the side-effects note
  all already exist. Today they apply to *everything* the same way.
- **New:** the tier suggestion (size + risk), the agent's recorded tier choice, the
  audit log, and the lighter Tier-1 lane.

## Why it's safe

It's strictly additive. If the agent doesn't declare a tier at all, the gate behaves
**exactly like today** (full spec required) — so nothing existing breaks. The only thing
that gets *easier* is small, low-risk changes, and even those still need the overview, the
side-effects note, and green tests. The risk floor is a loud, logged signal, never a
silent downgrade.

## What you need to decide

This is a Tier-2 step, so per our own rules it gets a real spec (this), goes through
cross-model review (convergence), and waits for your approval before I build it. If the
design looks right, say so and I'll run convergence and bring it back to build. The
specifics most worth your eye: the size threshold (≈40 lines / ≈3 files for Tier 1), the
list of "high-risk" areas that force a bump, and where the audit log lives
(`.instar/instar-dev-decisions.jsonl`).

## How we'll know it worked, later

A one-line observability fix will commit as a quick Tier-1 (overview + note + tests, no
spec); a change touching the secret-handling code will refuse to be Tier-1 even if it's
one line; and the decisions log will show, for every commit, what the gate suggested vs.
what the agent chose — with any "override" clearly flagged.
