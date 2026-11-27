# Bound tmux setup in GitHub CI

Three active CI jobs spent hours in `apt-get update && apt-get install tmux`, before any test started. That holds GitHub runner capacity and leaves a required check waiting. The workflow currently repeats the install for unit, integration, and end-to-end jobs, even if tmux is already on the runner.

Each test job should first check whether `tmux` exists and verify its version. Only a runner without tmux should use apt. Bound each apt command to three minutes, with a further ten seconds to kill a process that ignores the first timeout signal, and use short network retries for the package index. If setup still fails, the job reports a failure promptly so the issue can be retried or diagnosed; it must never report a passing test without tmux.

This change does not skip any test or change the required check names. Its effect depends on the runner image: when tmux is present, the package network is avoided; when absent, the setup time has an upper bound instead of the default six-hour job timeout.
