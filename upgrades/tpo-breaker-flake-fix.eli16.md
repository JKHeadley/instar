# A flaky safety-net test now waits for the finish line, not the halfway mark

Instar has a "circuit breaker" for conversation settings: if an operator pins a topic to a model that keeps failing to launch, the breaker parks the bad pin, reverts to the last working settings, and restarts the session — so a typo'd model name can never brick a conversation.

The breaker itself works fine. Its TESTS, though, were flaky — they'd pass most of the time and occasionally fail on the build servers (twice tonight alone, blocking an unrelated PR from merging). Flaky tests are poison: every red build that ISN'T real teaches people to ignore red builds.

The root cause is a classic race. When the breaker trips, it does several things in a row: park the bad pin → revert → un-park the resume entry → write an audit record → tell the user → restart the session. The tests waited for the FIRST visible step ("is the pin parked yet?") and then immediately checked ALL the later steps. There's a tiny window where the park is visible but the rest hasn't happened yet — normally sub-millisecond, but on a loaded build machine the test's polling could land exactly inside it and fail on assertions about steps that were still in flight.

The fix: the tests now wait for the audit record — which the breaker writes only AFTER everything else in the trip is done — before checking any of the trip's effects. Same coverage, zero timing dependence. Verified by running the test file 25 times in a row under load (the old version failed on the very first try of a 15-run loop).

No production code changed at all — this is a test-only fix. The breaker behaves exactly as before; its report card just stopped lying about it.
