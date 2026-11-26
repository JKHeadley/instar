# Convergence report: session-pool-default-on

**Outcome: stopped by the cut rule after 3 rounds, not by a round with zero findings.** Each round kept
finding design problems, so the spec was cut to the smallest step that is safe: a read-only report and
one printed line. Everything that changes behaviour moved to later steps, with the findings attached.

## Iteration summary

| Round | Standards-Conformance Gate | Internal | Outside (codex-cli, gpt-6-astra) | Result |
|---|---|---|---|---|
| 1 | ran (2 flags) | 11 findings | serious issues, 4 | activation at pairing cut from step 1; it would have lost messages on non-development agents |
| 2 | not rerun | 6 findings | minor issues, 4 | readiness line definitions fixed; `/health` git read removed |
| 3 | not rerun | 4 findings | not rerun | lease store fix cut to step 3 after review showed a swap is the wrong fix |

The two conformance flags (framework-agnostic wording, verifying state rather than symbol) were answered
in the design. The gate was not rerun in rounds 2 and 3, and the outside reviewer did not see the final
round's text. Round 3 removed behaviour rather than adding it.

## What was wrong along the way

The author first claimed takeover needs a shared git remote. Echo's own lease store disproved that, and
the claim was corrected in the topic. The failure is a defect in how the store behaves with no remote.

## Limits left behind

- Readiness lines are signals. `ready` does not prove a placement works.
- `no start failure seen` cannot prove a login.
- Takeover stays broken on a pair with no remote until step 3.
- Steps 2 and 3 need their own specs. Their starting lists are in this spec.
