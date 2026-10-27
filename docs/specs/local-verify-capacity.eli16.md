# A second machine for pull-request test runs — plain-English overview

Before a pull request can merge, its tests run on the Studio, one pull request at a time, about 18 minutes each. On busy days more pull requests are waiting than the Studio can get through, even after this week's speed-ups. The Mac Mini sits mostly idle.

**What this adds.** The Mac Mini can run pull-request test runs that the Studio hands it. The Studio stays in charge: it keeps the line, decides what to hand over, and is still the only machine that merges. The Mini only runs the tests and keeps the result. The Studio then fetches that result and treats it like one of its own.

**Why it's safe to trust the Mini's result.** Each hand-off gets a one-time id. The Studio accepts a result only if all of these hold:
- it answers exactly that hand-off;
- it tested exactly the code that was handed over (same pull request, same commit, same version of main);
- it used the same version of the testing program and the same rules;
- the Studio is still the machine in charge, without a hand-over in between.

Anything else is thrown away, and the pull request simply stays in the Studio's line.

**What happens when things go wrong.** If the Mini goes quiet, restarts, or takes too long, the Studio takes the pull request back after a set time and runs it itself. Each pull request is tried on the Mini at most twice. If the Mini keeps failing, the Studio stops using it for 30 minutes and raises one alert. The Studio never waits for the Mini before starting its own next run.

When an Instar update is waiting for a test run to finish, both machines wait instead of starting another run. This lets the update complete without another test holding it back.

**What this does not do.** It doesn't test several pull requests together in one run ("batching"). The review showed that, done simply, batching could let untested code onto main, and it would only speed things up by about 20% at today's pass rate.

**Trust, stated plainly.** The Mini is treated like the Studio: if someone took over the Mini, they could fake a passing result, just as they could if they took over the Studio. That is the same trust that already covers all of the operator's machines.

What you need to decide: nothing to turn this on; it ships switched off and I turn it on once it's merged. The only open question is whether to drop batching.
