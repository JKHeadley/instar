# BRIEF 4 — Shipping: a tracked deferral must close, expire, or escalate

**Take-or-decline. Self-contained. Produces a proposal document, never a registry edit.**

## The finding, verbatim

> *No Deferrals* similarly **lacks an obligation to close, expire, or escalate tracked deferrals**.

## The state of play, already established on the branch

*No Deferrals* now declares (landed 2026-08-07): MEASURED — a spec carrying deferral language declares
each instance with a marker or frontmatter field. CERTIFIED — the deferral is **TRACKED**, not that
anyone follows through. And the article's own Rule says "active follow-through", which is the stronger
claim the marker does not substantiate.

**The dependency worth knowing before you start:** the article had been leaning on *Close the Loop*
for the follow-through half — and *Close the Loop* is itself a `documented-only` gap under a countdown
expiring **2026-09-07**. So the follow-through obligation currently rests on an unenforced article.
That is now stated rather than hidden, and it is precisely the hole this brief fills.

## The question to answer

**What must happen to a tracked deferral, and what forces it to happen?**

The shape is already proven in this constitution — the `Documented-only until` countdown built under
ruling 4 does exactly this for an unenforced standard: a deadline plus a tracked id, with a lint that
fails the build when the date passes. **Ask whether a deferral wants the same mechanism**, and if so
say why it should be a separate one rather than a second consumer of the existing check.

Things a good draft will confront:

- **Re-dating must stay legal.** A check that forces "ship it or delete it" buys honesty with worse
  engineering. The countdown lint permits deliberate re-dating on purpose; say whether that applies
  here.
- **Expiry is not the same as escalation.** A deferral that lapses quietly is the failure; one that
  surfaces to a human is the fix. Which is the obligation?
- **The population problem.** The existing countdown check's population is DECLARED, not discovered —
  a relabelled article nobody adds is invisible. A deferral mechanism inherits that weakness unless
  it is anchored to something enumerable. Name the weakness either way.

## Deliverable

`docs/proposals/standard-proposal-deferral-lifecycle.md`: the obligation; the forcing mechanism;
whether it amends *No Deferrals* or extends the countdown machinery; what it MEASURES vs CERTIFIES;
one deferral that would escape it; and the interaction with *Close the Loop*'s own countdown — since
two overlapping follow-through mechanisms would be the redundancy defect these same reviews found
three times.
