# Justin's approval of the Connect direction, with two conditions

Source (verbatim, verified in the Telegram log): Justin, topic 141385, message 145272, 2026-11-18 16:00 PST, after the Chief of Staff's use-case answer (Connect is for PCs where you can't or shouldn't install an agent: short-term help, look-only, locked-down PCs):

> "great! I think that makes perfect sense. As long as we make it very clear what the use case is and that we recommend the main Instar desktop app for most users, then I approve"

Conditions draft 4 must carry, stated up front in the spec AND its ELI16, and in the person-facing surfaces (instar.sh/pc page, the PC window, the agent's offer):
1. The use case is stated plainly: Connect is for a PC where installing a full agent is not possible or not wanted (short-term help, look-only, locked-down or shared PCs).
2. The main Instar desktop app is the recommended path for most people; the agent offers it first and offers Connect only for that use case.

This is approval of the direction, not of a converged spec: the spec still has to converge (it is at draft 3, round-3 findings in converge-r3/plan.md) before the review-convergence tag; the `approved:` frontmatter goes on the converged spec citing this message. The signing-cost request stays separate, in the four-part form.

## Chief of Staff direction for draft 4 (2026-11-18 16:16 PST, message cc795305)

- A side-by-side comparison by a helper session (document bb9d819b, commit 7ab9ef7cc) found that shipping Connect as a **mode of the Instar desktop app** satisfies both conditions; the Chief of Staff put the same idea to Justin. Build that finding into draft 4 and converge it citing message 145272.
- Do NOT send Justin that document's four-part ask. Ask him again only if draft 4 differs materially from what he approved (for example a new paid service beyond the signing request already planned separately).
