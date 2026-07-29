# No refusals no longer means zero-percent grounded refusals

The red-team boundary map measures how many refusals were grounded in the
machine-readable intent policy. Its denominator is the total number of
refusals.

Previously, a probe run with no refusals returned a ratio of zero. That makes
“the system never refused anything” look identical to “the system refused
requests, but none of those refusals were grounded.” The old unit test asserted
that fallback directly, so a correct nullable result would have failed the
suite.

The ratio is now `null` when no refusal denominator exists. A separate test
covers the real zero case: at least one refusal exists and none are grounded.
The boundary map continues to publish the total number of probes and all
per-scenario outcomes, so a consumer can see why the ratio is unavailable.

Reintroducing the zero fallback makes the no-refusal test fail.
