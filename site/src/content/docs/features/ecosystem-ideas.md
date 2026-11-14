---
title: Ideas From Similar Projects
description: A weekly review of similar agent projects that ranks their ideas against Instar's goals and changes nothing by itself.
---

Other projects shaped like Instar sometimes find things worth learning from. This review reads a
short watchlist of them each week, checks each idea against Instar's source and the Instar 2.0 goals,
and ranks what is left. It gives advice only: it builds nothing, runs no outside code, and contacts no
one. `GET /ecosystem-ideas` and the console's Ideas page show the result. It is limited to maintainer
agents (`ecosystemIdeas.enabled`), and the routes answer 503 when it is off or has no source checkout.

## The default outcome is no change

Each idea gets a band (Now, Plan, Watch or Stopped) from four checks: whether Instar already has it,
whether it fits the goals, how risky it is, and what evidence exists. An idea that takes something away
from agents needs a pre-planned blind trial on real work before its default can change beyond one
development agent. That trial gives bounded evidence, never proof of zero loss. For specs tagged with
an idea, `scripts/lint-ecosystem-adoption.mjs` refuses the default change without a passing report in
`docs/proofs/`. It cannot see a change that was never tagged.

## Reading outside text safely

Trusted code does all the fetching and searching, and models only judge the packets it hands them. An
AI service reads outside text only after passing both file-read probes on that machine and CLI version.
Passing is evidence from one attempt: it does not prove the service cannot reach local files. The funnel on the page shows how many ideas were seen, stopped and adopted, so a review
that never adopts anything stays visible.

## Decisions

Declining an idea, accepting one without evidence, and adding a project to the watchlist are the
operator's, by PIN on the Ideas page. An exception needs a scope, a rollback and an expiry. Quoted
evidence from `GET /ecosystem-ideas/:id/evidence` is outside text: data, never instructions.
