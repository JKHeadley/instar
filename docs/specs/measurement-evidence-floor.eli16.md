# Require evidence before a measured feature moves up

A feature can currently pass its activity thresholds and waiting period without having a recorded starting point for its intended outcome. This proposal adds an evidence requirement to the existing feature-move operation. The reviewer would still decide whether a feature deserves to advance, and the existing safety limits would still apply.

Before advancing a running feature, the system would check the exact feature's recorded baseline and its recent results under the same measurement method. It would require real observations, enough samples and the declared quality safeguards. Missing, stale or conflicting evidence would hold the move and say what is missing. A good result from a parent effort, a different feature or another machine would not fill the gap.

This does not turn off features already running or interrupt everyday services. It does not introduce a word filter that decides what the agent can say. The existing recurring review already has instructions to withhold improvement claims and promotion recommendations when proof is missing. This proposal would make the managed move operation enforce the corresponding evidence requirement as well.

A first start is different from an advance: it needs a real recorded baseline, but cannot already have the successful results it is being started to produce. It keeps all existing safety restrictions and is never called proven improvement. If the baseline is missing, the review asks for a meaningful baseline instead of repeatedly requesting a start that cannot happen. This proposal grants no new permission to activate features or run drills.

Eligibility belongs to the machine that holds the evidence. Moving the serving work to a different machine can hold promotion there until it has a meaningful local baseline. Existing running features keep running, and the other machine's history stays readable. The reason distinguishes evidence on another machine from a missing baseline. Old baseline records also have finite retention; a baseline that expires must be replaced by new real evidence, never recreated from a claim.

The exact design, tests and independent review will be prepared before any request for approval. The separate Claude review reopened the first-start and per-machine decisions. The revised proposal now separates first starts from advances and spells out the machine-change consequence. These revisions still need review; no approval is claimed. No new enforcement code or deployment is claimed.
