# Feature maturation recurring evaluation — plain-English overview

Instar already keeps a rollout card for features that ship turned off or in a testing mode. D7 makes those cards measurable instead of leaving them as prose. Each feature declares a small set of numeric checks, how fresh the evidence must be, and what value counts as healthy. Instar then revisits every feature that is still dark or soaking on a regular schedule.

This does not build another rollout tracker or another metrics service. It adds per-feature observation and evaluation rows to the existing blocker-lifecycle metrics database, and shows the results through the same summary and trend endpoints. The existing rollout reconciler remains the one source of feature identity and stage. The existing six-hour reconciliation pass is also the only recurring driver.

Missing data is never treated as success. A feature is reported as ready only when every declared metric has enough fresh samples and passes its threshold. Missing contracts, insufficient evidence, stale evidence, failed thresholds, and missed evaluation cadences each have separate visible states. The score is descriptive only: it cannot enable a feature, advance a rollout card, or send a notification.

The first supported evidence comes from the already-shipped blocker summary and trend measurements. Decision-quality and benchmark evidence can join later only after those producers publish stable numeric descriptors; this release does not pretend those integrations already exist. All data remains machine-tagged, so one healthy machine cannot hide missing evidence on another.

The rollout starts on the development agent through the existing dark gate. Graduation requires a seven-day soak in which every eligible feature is evaluated when due, no feature is falsely marked ready, missed cadences recover visibly, and the bounded evaluation pass stays within its performance budget.
