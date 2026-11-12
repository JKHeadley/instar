# Post-review: the "every ask carries its links" rule and the trial design

Written 2026-11-11 by Echo. These are two side stages of the effort. Both hit the round-2 tripwire, both were cut down, and Justin chose the smaller form of each.

## Stage: "every ask carries its links" (Justin's rule request, 17:16 PST)

**What happened**
- Round 1 reviewed a live check in the outgoing-message reviewer. Fable 5.2 and GPT 6 Astra had source access.
- Round 2 found a constitutional conflict. The 2.0 rule book says to judge patterns afterwards and to judge live only when the moment is irreversible, and a missing link is reversible. The round also found 3–4 machinery gaps.
- I stopped and gave Justin two routes. He chose route 2 (rule plus retrospective) and added an escalation ladder.
- Part A round 2 found 13 design findings, then 7. That is not halved, so the tripwire fired, and the design was cut to three pieces:
  - **A1:** the rule line plus the standards clause. Built and pushed (`echo/approval-ask-links`), Tier 1.
  - **A2:** the send helper and retrospective review, initiative `ask-links-helper-and-review`.
  - **B:** the ladder, initiative `owner-expectation-ladder`.

**What went well**
- The tripwire caught a second sprawl early. A1 ships the part Justin actually asked for today. A2 and B carry every reviewer finding forward as named inputs, so nothing is lost.
- The constitutional conflict was caught in review, not after shipping a fleet-wide live check with no off-switch.

**What went badly**
1. **I drafted the 1.x design first.** It copied the existing page-link check without first asking whether the 2.0 book allows a new live check. Cost: one full review round.
   *Action:* any new outbound-message check starts by quoting the 2.0 "judge in retrospect" line and saying why the moment is or is not irreversible. Added to MEMORY.md.
2. **The A1 PR is still not open.** The Studio's session cap (5/5, held by other work) blocks the helper that creates PRs, and this machine's token cannot create them.
   *Action:* a combined helper request, which creates both PRs, adds Justin as reviewer and starts Local Verify, retries every 4 minutes. The fix belongs to the Studio cap, not to this effort, and I don't own those sessions.

## Stage: the low-effort trial (option B)

**What happened**
- Option B, an alternating-day trial with its own journal, went from 9 design findings to 7. That is not halved, so the tripwire fired.
- All 7 were bookkeeping for the custom journal.
- I proposed B-lite instead: no new code, one job on low effort, compared against the cost report's frozen baseline. Justin chose B-lite, as a 2-day trial (18:40 PST).
- The full B spec is shelved, uncommitted, in `.worktrees/thinking-mode-pilot`.

**What went well**
- The descriptive trial needs no new code at all. The job-effort piece plus the existing JobCostReport carry it.
- The limits are stated up front: it is not controlled, engine versions may differ, and there are about 24 runs a side.

**What went badly**
1. **I designed for a question nobody asked.** Statistical rigour went into a trial that Justin had already said should be descriptive. Cost: two review rounds.
   *Action:* trial designs start from the owner's stated decision ("what would change your mind?") and from the cheapest data source that already exists.

## Proportion

- The rule stage took 3 review rounds and produced 1 Tier-1 build plus 2 initiatives.
- The trial stage took 2 review rounds and needs no build.
- Both stopped where the process says to stop, which is the process working, not a failure.
