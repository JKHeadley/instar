# Side-effects review — parity-pass request-timeout fix

Live finding (2026-06-05, first real trigger of the just-deployed G2.4 surface): a
real parity pass fetches the FULL live Portal cluster set and takes ~3.5 minutes
(measured 204s). The 30s default request timeout 408'd every trigger; the handler
kept running, and a late failure's 409 crashed into ERR_HTTP_HEADERS_SENT with no
trace of the outcome anywhere.

## 1. The change

- `middleware.ts`: `PARITY_PASS_TIMEOUT_MS = 360_000` + a `buildRequestTimeoutOverrides`
  entry for `/cutover-readiness/parity-pass` — the exact `/spec/conformance-check`
  precedent (single heavy call, per-path budget). Longest-prefix matching means the
  read-only `GET /cutover-readiness` sibling keeps the 30s default (tested).
- `routes.ts` (trigger route): the outcome is now ALWAYS logged server-side
  (recorded/failed + reason), and the response is skipped when `res.headersSent`
  (a 408 already went out) — never a double-respond crash, never a silent outcome.

## 2. Blast radius

Two files, additive. No other route's budget changes. T7 unchanged: the trigger
still computes server-side; failures still record nothing.

## 3. Test coverage

5 new tests: override resolves for the trigger (≥ the measured real-pass duration)
and ONLY the trigger; over real HTTP with a tiny budget — a slow SUCCESSFUL pass
still records after the 408 with the outcome logged and no crash; a slow FAILED
pass records nothing with the reason logged; the fast path still 200s. Existing
override wiring suite green (20 total).
