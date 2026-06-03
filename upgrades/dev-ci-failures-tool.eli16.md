# `instar dev:ci-failures` — ELI16

Viewable private artifact:
https://echo.dawn-tunnel.dev/view/41bc3523-a95d-4038-bd43-af8a942e0008?sig=e785278aea6a2e82502cc55fe56b98e55ab4cef543b71ddf32c953db7985c191

When a pull request's automated tests go red, you want to know *which* test broke and where.
Normally you'd open the CI logs — but in some setups the command that fetches those logs comes
back completely empty, so a red run tells you "something failed" and nothing else. I hit this
repeatedly while shipping fixes this run, and had to re-discover a workaround each time.

This turns that workaround into a permanent tool. `instar dev:ci-failures <pr>` reads a
*different* GitHub endpoint (the per-check "annotations") that still reports the exact failing
file, line number, and assertion message even when the logs are blank. It also tidies the
output: it merges the duplicate failure that the Node-20 and Node-22 test shards both report,
and it hides the generic CI-runner noise ("Process completed with exit code 1").

It's read-only and informational — it never changes anything, it just shows you the failures.
Pairs with `instar dev:preflight` as the contributor dev-loop toolkit.

_Tier-2 · branch `echo/dev-ci-failures-tool` · the first of the "turn this run's friction into
infrastructure" improvements._
