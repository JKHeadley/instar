# Empty evolution history no longer reports zero-percent acceptance

The trust-elevation system tracks how often evolution proposals are approved.
It may suggest more autonomy only after enough decisions and a high recent
acceptance rate.

Previously, a fresh history with no approved or rejected proposals reported
zero-percent acceptance. That number looked like every proposal was rejected,
even though no decision existed. The minimum-count gate already prevented this
empty value from granting authority, but the API still presented it as a real
measurement.

The overall and recent rates are now null until at least one non-deferred
proposal is decided. The elevation paths explicitly return no opportunity when
the recent rate is unmeasured, in addition to retaining their existing minimum
decision requirements. Once decisions exist, the same ratios and thresholds
apply.

The regression asserts both halves together: empty rates are null, and neither
governance nor profile elevation is suggested. Restoring the old zero fallback
fails the metric assertion without changing the no-elevation proof.
