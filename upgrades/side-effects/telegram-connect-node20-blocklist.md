# Side effects: telegram-connect-node20-blocklist

- Scope: test-only (`tests/unit/telegram-connect-attempt-window.test.ts`). No runtime, setting or retry-authority change.
- On Node >= 22.13 the assertion is equivalent to before (`['ETIMEDOUT', 'ERR_IP_BLOCKED']`).
- On Node 20 the second attempt must now be one of ENETUNREACH / EHOSTUNREACH / EADDRNOTAVAIL, because Node 20 ignores `blockList` on net.connect and cannot produce ERR_IP_BLOCKED.
- Verified by direct probe: node v20.20.2 -> EHOSTUNREACH, v22.23.5 -> ERR_IP_BLOCKED, v26.13.0 -> ERR_IP_BLOCKED. CI node 20 evidence: runs 45314092055, 45319690472, 45333629883 (ENETUNREACH).
- Residual risk: on a Node 20 host that silently DROPS IPv6 instead of refusing it, the fallback can still wait on the OS. #3709 fixed that for Node 22+, and CI runners refuse the address at once.
- Revert: plain git revert.
