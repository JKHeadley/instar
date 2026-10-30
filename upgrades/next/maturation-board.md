## What Changed

New read-only maturation board: `GET /maturation/board` and the page `/dashboard/maturation/`
(also a "Feature maturation" tile in the console's Work group). It lists every feature the
`feature-maturation-review` job assesses, with that review's verdict (shown verbatim and
labelled model-assessed), evidence, decision, linked follow-ups and their status, plus live
records from every machine (D7 readiness, rollout stage, dark-flag first-seen dates and
deadlines, guard posture). It stores nothing, writes nothing, calls no model, and answers
`advisory: true, authority: "none"`. Follow-up is three-valued (linked / no linked follow-up /
can't tell) and counts only explicit links; a delivered commitment reads "handed off", never
"fixed". Dates come only from recorded deadlines (a commitment's `checkInAt`, a dark-flag
deadline, a review's written expected-by date). `?scope=pool` merges every machine; the review
rows come from the machine with the newest valid review, and a machine that does not answer is
named on the page. The dark-flag registry instance is now shared read-only with this route.
Dev-gated: `maturationBoard.enabled` (live on a development agent, 503 on the fleet).

## What to Tell Your User

On a development agent there is a new page that shows how every feature on its way to being
switched on is doing: the latest review's verdict, what measures it, what is being done about it,
and its dates, with colours, filters and sorting. It works on a phone with the dashboard PIN.
Nothing changes on other agents.

## Summary of New Capabilities

- `GET /maturation/board` (`?scope=pool` for every machine): the maturation board data.
- `/dashboard/maturation/`: the standalone board page; same view inside the console's Work group.

## Evidence

Ran the real route over the two existing reviews (25 and 28 Oct, 179/183 rows) and the Studio's
real commitments: 182 features, 0 unparsed rows after widening ids for compound names, 97
stalled/regressed/blind with 89 having no linked follow-up. Unit (35 builder + 13 view-model and
jsdom), integration (9, including real peer servers, a future-dated peer review refused, a dead
peer named, symlink refusals) and e2e (3: alive on a dev agent with the registry wired, 503 on a
fleet agent, page served) tests. Spec converged in 3 rounds with GPT-6 Astra
(docs/specs/reports/maturation-board-convergence.md).
