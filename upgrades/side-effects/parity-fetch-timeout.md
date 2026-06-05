# Side-effects review — parity snapshot fetch hang fix

Live finding (2026-06-05, the very next trigger after #807 deployed): a parity
pass hung past 12 minutes with NO outcome line and nothing recorded. #807 fixed
the response-side (realistic 360s budget + always-logged outcome), but the
outcome log fires only when the server-side `prepare()` await RESOLVES — and
`HttpParitySource.prepare()`'s page fetches carried no AbortSignal and no
timeout. One silently-stalled Portal page request (the endpoint's auth wall
answered in 0.2s; the authenticated data path just never returned) hangs the
pass forever: nothing logs, nothing records, the parity window starves.

## 1. The change

- `HttpParitySource.ts`: every page fetch now carries
  `AbortSignal.timeout(min(pageTimeoutMs, remaining-total-budget))` —
  `pageTimeoutMs` default 90s (healthy pages measured ~15s → 6× headroom),
  `totalTimeoutMs` default 600s hard-bounds the whole snapshot even at the
  200-page safety cap. Aborts map to a classified `HttpParitySourceError(504)`
  naming the page and both budgets; non-abort fetch failures propagate
  unchanged (not masked).
- `AgentServer.ts`: config passthrough only —
  `feedbackMigration.paritySource.pageTimeoutMs` / `.totalTimeoutMs` (both
  optional; absent = defaults). No migrateConfig entry by design: absence
  preserves shipped defaults, same pattern as the sibling `pageSize`/`status`.

## 2. Blast radius

Two files, additive. The error path lands in the route layer's existing
classified-failure handling from #807: outcome ALWAYS logged
(`parity pass FAILED (nothing recorded): …504…timed out…`), nothing recorded —
T7 unchanged. Healthy passes are untouched (a 204s real pass sits far inside
both budgets). No route timing changes; #807's 360s response budget is
orthogonal (response side vs upstream-fetch side).

## 3. Test coverage

4 new unit tests in the existing HttpParitySource suite (14 total green):
stalled page fetch aborts at `pageTimeoutMs` → 504 naming the page; every page
fetch carries an AbortSignal (no unbounded request can be issued); the total
budget is enforced between pages (504 before issuing the next page, verified by
call count); a non-abort fetch failure (TypeError) propagates unchanged.
