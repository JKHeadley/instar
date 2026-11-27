# Small peer verification review

Chief approved the revised design at 10:20:43 PST on November 24, 2026. The approval covers the sample timestamp and sequence check, removing the launchd job before releasing an empty scope, and using the same measured Darwin collector in calibration and production. Defaults remain off. Activation applies only to the Mini after testing and release.

Six external Codex rounds and the physical Mini measurements are in the Studio evidence directory .instar/reports/throughput-improvement/mini-trial-reviews. The internal independent review identified main arbitration's separate routing, the asynchronous admission race and detached process accounting. The corrected design covers those cases. Implementation must prove the protections before activation.

## Controlled runtime measurements

Four isolated runs used the production collector on the 16 GiB Mini. The fixture allocated up to 32 MiB in 1 MiB increments while ignoring TERM. A separate observer sampled the host about ten times a second through final exit. From the last observation before the trigger to the minimum through exit, measured available memory fell by up to 287.91 MiB. The largest difference between adjacent observations was 301.69 MiB. Host-wide movement includes other applications.

A repeat of the four fixtures after implementation review measured host-wide changes of up to 746 MiB between observations. The revised pilot floor is 5.125 GiB (5,502,926,848 bytes). The 4 GiB reserve is the proposed operating margin for this 16 GiB Mini. Normal native pressure, no additional swapouts during the idle baseline and minima above 4.9 GiB throughout the bounded runs informed this choice. The additional 1,152 MiB covers the largest observed decline through exit (288 MiB), the largest adjacent-observation fluctuation (747 MiB), and 117 MiB of rounding margin. An early draft based on the first four runs underestimated these fluctuations. A full PR can allocate more rapidly than the bounded fixture. The first three admitted PRs require observation for this reason. The recovery window is three seconds above the floor with observations less than two seconds apart.
