# Slowdown verification now distinguishes success from missing evidence

After Instar installs a token-use slowdown, it compares the rate from before the
slowdown with a fresh rate several minutes later. A real reduction can support
the “Caught and contained” follow-up, while a rate that did not fall triggers a
warning that the slowdown may not be connected to the offending path.

The old calculation had a third state that it forced into the success path. If
the before-rate was missing or zero, there was no denominator for the
comparison. The code substituted a ratio of zero, interpreted that as a
one-hundred-percent reduction, and could send a reassuring message saying a
component had been contained while both displayed rates were zero. No
before-and-after claim was actually measurable.

Verification results now represent that third state directly. Both the ratio
and `successfullyThrottled` are null when the before-rate is unavailable, zero,
or otherwise invalid. The follow-up says verification was inconclusive, gives
the current sample, and explains that there is no measured baseline. Positive
finite baselines continue through the existing success and failure paths
unchanged.

The regression enters the broken state with a zero before-rate and a zero
current sample. It asserts the two null fields, the explanatory message, and
the absence of “Caught and contained.” Restoring the old zero fallback makes
the test fail. This changes no throttle, threshold, timer, or release behavior;
it only prevents missing evidence from becoming false reassurance.
