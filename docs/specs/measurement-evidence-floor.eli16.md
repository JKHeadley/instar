# Require evidence before a measured feature moves up

A feature can currently pass its activity thresholds and waiting period without having a recorded starting point for its intended outcome. This proposal adds an evidence requirement to the existing feature-move operation. The reviewer would still decide whether a feature deserves to advance, and the existing safety limits would still apply.

Before making that move, the system would check the exact feature's recorded baseline and its recent results under the same measurement method. It would require real observations, enough samples and the declared quality safeguards. Missing, stale or conflicting evidence would hold the move and say what is missing. A good result from a parent effort, a different feature or another machine would not fill the gap.

This does not turn off features already running or interrupt everyday services. It does not introduce a word filter that decides what the agent can say. The existing recurring review already has instructions to withhold improvement claims and promotion recommendations when proof is missing. This proposal would make the managed move operation enforce the corresponding evidence requirement as well.

A stricter requirement can leave older features waiting while meaningful baselines are recorded. That is deliberate, and first starts have to meet the same requirement: starting live work cannot be disguised as a harmless way to collect a baseline. The proposal does not grant new activation permission. It also does not claim to control every direct configuration change or code release.

The exact design, tests and independent review will be prepared before any request for approval. Independent review settled the first-start rule and kept threshold results separate from actual permission to move. This is still a proposal. No new enforcement code or deployment is claimed.
