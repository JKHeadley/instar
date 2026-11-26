# relay-send falls back to Node's default dispatcher when Node's fetch rejects the undici package Agent

Tier 1. One call site gets a rejection-only retry. Rollback is a revert.

- What changed. `sendMessageViaHttp` (src/threadline/mcp-http-client.ts) now calls `fetchRelaySend`, which passes the 325s `undici` Agent as before. If Node's fetch throws a `TypeError` whose cause code is `UND_ERR_INVALID_ARG`, it resends the same request once without a dispatcher and records, for the process, that the package Agent cannot be used. Same shape as `fetchWithTelegramDispatcher` in src/messaging/telegram-egress.ts.
- Evidence. On Node 26.13.0 (bundled undici 8.12.2) with the `undici` 6.27.0 package, `tests/e2e/threadline/send-honest-error-e2e.test.ts` failed on unmodified main with `Failed to reach agent server on port N: fetch failed`; the fetch error's cause was `UND_ERR_INVALID_ARG invalid onError method`. A plain fetch to a 127.0.0.1 server in the same Node succeeds. CI runs Node 20/22, where the two undici versions agree, so CI never saw it. `package.json` engines allow `>=20.12.0`, so Node 26 users hit it in production: every MCP `threadline_send` failed.
- Duplicate delivery. None possible from the retry: the rejection is raised inside `Agent.dispatch` before a connection opens, and only that exact error is retried. Any other error (ECONNREFUSED, abort, timeout) is handled exactly as before, with no retry.
- Under-block. After a rejection, relay-send runs on Node's default 300s headers/body wait instead of 325s. A reply wait that runs past 300s then reads as outcome-unknown (the existing honest result for a timeout) instead of waiting the extra 25s. Only on Nodes that reject the Agent, where today the send fails outright.
- Over-block. None. No check is added or weakened.
- External surfaces and multi-machine posture. None. No persisted format, config or route change.
- Rollback. Revert the commit.

Verification: new `tests/unit/mcp-http-client-dispatcher-rejection.test.ts` (resend once without dispatcher, then remembered; a real ECONNREFUSED is not retried). The e2e `send-honest-error-e2e.test.ts` now passes on Node 26. Mutant (retry removed): the unit test fails 1/2 and the e2e fails with the original "Failed to reach agent server". The three existing unit files for this helper pass (39/39 with the new file). `tsc --noEmit` exit 0.
