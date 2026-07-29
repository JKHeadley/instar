# New trust profiles no longer start at zero-percent success

Threadline keeps counts of successful and failed interactions for each known
agent. Its status surfaces divide successes by all completed interactions to
show a success rate.

Previously, a newly created profile with zero successes and zero failures
reported a zero-percent success rate. That looks like every interaction failed,
even though no interaction had happened. The HTTP stats and OpenClaw status
therefore turned missing history into a real-looking poor result.

The success-rate field is now null until at least one success or failure is
recorded. OpenClaw still shows both zero counts, but labels the rate “unknown.”
Once an interaction exists, the existing numeric calculation is unchanged.
Trust levels, permission checks, explicit allow and block lists, automatic
downgrades, and interaction recording do not read this rate and are unchanged.

The regression covers both the raw stats object and the text an operator sees.
Restoring the old zero fallback produces failures in both tests, including the
exact old “0.0% success rate” output.
