# Wait for the grant's actual receipt

The combined locked-Mac proof harness joins several separately reviewed changes: native observation, required persistence before Enter, exact guard acknowledgement, measured before-Enter timing, positive next-grant evidence, human sequencing, and the bounded watch-end fixture. All of those checks need to agree about which approved desktop request is being tested.

A browser can make its control panel visible while the harness is still reading the approved response body. Previously, grant opening could return at that point with no recorded request identity or expiry. The next proof step would begin with incomplete evidence. A test using the real grant-opening method and a deliberately delayed response body reproduced this ordering.

Grant opening now requires both visible controls and the positive approved request receipt. The receipt must contain a request UUID and a future expiry. The harness waits at most five seconds using a monotonic clock, then refuses if the information is missing or expired. It does not guess an identity from another response or continue with a default. This changes only proof sequencing; product authorization and native relock policy are unchanged.

The combined branch also preserves both independent cleanup mechanisms and native observation when resolving overlapping methods. A watch test explicitly supplies inert guard-ACK cleanup so its test cannot accidentally invoke the real proof fixture. The branch is a local integration candidate, not a live-Mac acceptance result. No password, desktop operation, signing identity, TCC permission, or fleet deployment is changed by this follow-up.
