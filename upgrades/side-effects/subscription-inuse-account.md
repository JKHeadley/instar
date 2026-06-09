# Side-effects review — subscription-pool "in-use account" dashboard surface

## What changed
- New `src/core/InUseAccountResolver.ts`: resolves which pool account the agent is CURRENTLY running on, by probing `claude auth status` (the authoritative active-account surface) and matching its email to a pool account. Read-only; probe + clock injected; result cached (TTL 60s) with concurrent-probe coalescing.
- `src/server/routes.ts`: new `GET /subscription-pool/in-use` → `{ enabled, activeAccountId, activeEmail }`. Registered before `/subscription-pool/:id` (literal beats param). Lazy-constructs a resolver if none on ctx; never 500s/503s.
- `src/server/AgentServer.ts` + `src/commands/server.ts`: wire a single shared resolver instance through the ctor → RouteContext (so the cache is honored).
- `dashboard/subscriptions.js`: controller fetches `/in-use` (best-effort, its failure can't blank the accounts list) and badges the in-use account card. `renderAccounts` gained an OPTIONAL trailing `inUseAccountId` param (backward compatible — existing callers/tests unaffected).
- `dashboard/index.html`: CSS for the in-use badge + card highlight.

## Blast radius
- Purely ADDITIVE + READ-ONLY. No change to session launch, account selection, swapping, or any mutation path. A pool of zero accounts → route answers `{ enabled:false }`; single-account agents unaffected.
- The only new side effect is spawning `claude auth status` (read-only, 15s timeout, maxBuffer bounded) at most once per 60s when the dashboard `/in-use` route is hit. If `claude` is missing or errors, the resolver degrades to `activeAccountId:null` (no badge) — never throws, never blocks.

## Framework generality
- Does NOT touch the session launch/inject abstraction (frameworkSessionLaunch / MessageDelivery). The resolver is claude-code-specific by design (it answers "which Claude account"), and `matchAccountByEmail` filters to anthropic/claude-code accounts, so a codex/gemini account can never be mis-reported as the active Claude login.

## Honest scope note
- This is the DISPLAY half of the request ("show which account is in use"). It reflects reality: normal sessions run on the default config, which this resolves authoritatively. The DETERMINISM half (pinning sessions to an explicit pool account so the default is never ambiguous) touches the critical session-launch path and is intentionally a separate, carefully-reviewed change — not bundled here. <!-- tracked: CMT-1185 -->

## Migration parity
- No agent-installed files change (no settings.json, config defaults, CLAUDE.md template, hooks, or skills). New route + dashboard asset ship with the package; existing agents get them on update. No `PostUpdateMigrator` entry needed.

## Tests
- Unit: `in-use-account-resolver.test.ts` (matcher both sides, resolve, cache TTL, coalescing, failure-degradation); `subscriptions-render.test.ts` (in-use badge present/absent).
- Integration: `subscription-inuse-route.test.ts` (HTTP route: match / no-match / dark / does-not-shadow-`:id`).
- E2E: `subscription-inuse-lifecycle.test.ts` (feature-alive: 200 in dark + live).
