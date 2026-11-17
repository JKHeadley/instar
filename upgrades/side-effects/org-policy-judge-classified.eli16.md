# The organization rule checker is listed in the AI component records (ELI16)

## What was wrong

Instar keeps several lists of every place where it asks an AI model to make a decision. Each list answers one question about that decision maker: does it read text that a stranger could have written, does it judge an agent's own claims, does its answer get parsed into a fixed set of verdicts, which kind of model should handle it, is it scored by a benchmark yet, and is a record of each decision kept for later review. Automated tests make sure every decision maker appears in every list, so a new one can't slip in without anyone thinking about these questions.

The organization rule checker (OrgPolicyJudge), which reads an action and decides whether it breaks one of the organization's "never" rules, was registered as a gate but missing from these lists. Six of those tests failed on the merge line.

## What changed

The checker is now in every list: it reads text a stranger could have written, it judges actions rather than an agent's claims, its yes/no verdict with a rule number is a fixed-shape answer, it is routed like the other safety judges, and its benchmark and decision record are queued with the others still waiting. Adding it to the queued lists is a deliberate, visible edit to the pinned baselines. How the checker behaves did not change.

## Evidence

The six rule tests pass, 98 of 98.
