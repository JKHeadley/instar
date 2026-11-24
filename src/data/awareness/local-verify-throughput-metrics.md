---
title: Local Verify throughput measurements
---
When you operate a Local Verify line, measure completed full gates separately from early failed attempts. Run `node /path/to/instar/scripts/local-verify-throughput-report.mjs --state-dir /path/to/agent/.instar --hours 2` to print a read-only report from that machine. The coordinator keeps bounded metadata keyed by the exact repository, pull request, published head and target base. First-observed-head latency is only a lower bound: actual publication time is unavailable. Unresolved observations may include closed, superseded or remotely completed work and are not a live queue view. Legacy failure coverage remains unknown. Neither the metrics nor the report changes admission, holds, test selection, verdicts or merge authority.
