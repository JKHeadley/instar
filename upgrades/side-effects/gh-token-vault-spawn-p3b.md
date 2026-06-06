# Side-effects review — Vault-backed GH_TOKEN at spawn (Phase-3 increment P3b, option C)

## What this change does
Per-agent GitHub credential isolation for spawned sessions (CMT-1125 gap 1,
operator-selected design option C). At spawn time, `SessionManager` resolves
the agent's GitHub token from its encrypted per-agent SecretStore
(`github_token`, then `github.token`) and injects `GH_TOKEN=<token>` into the
tmux session environment. The `gh` CLI prefers `GH_TOKEN` over the
machine-global `~/.config/gh/hosts.yml` seat, so a session's GitHub actions
authenticate as THIS agent — the shared-machine cross-principal exposure
behind the 2026-06-05 identity-bleed incident.

Three pieces:
- `src/core/ghToken.ts` — `resolveGhTokenFromVault(stateDir)`: pure fs/crypto
  vault read; trims; returns null on absent vault / absent key / non-string /
  whitespace / any read error. Never throws. No subprocess (the P3a
  GitSync mock-sequence lesson: spawn-path helpers must not consume scripted
  child_process mock values).
- `SessionManager.ghTokenEnvFlags()` — private helper used by THREE spawn
  sites (headless, rerouted-interactive, warm interactive). Returns
  `['-e', 'GH_TOKEN=…']` or `[]`.
- `vaultStateDir` — same derivation as the pending-inject ledger
  (StateManager.baseDir, else `<projectDir>/.instar`).

## Blast radius
- **Additive + dark-by-default-shaped.** No config flag, no migration, no new
  route: with no vault token the resolver returns null and the spawn argv is
  unchanged byte-for-byte (tested: env has no `GH_TOKEN=` entry at all).
- **Fail-soft end to end.** A corrupt vault logs one console.warn and the
  spawn proceeds tokenless (tested with a deliberately garbaged vault file).
- **The hardened triage spawn is EXCLUDED on purpose.** That site scrubs
  credentials (`ANTHROPIC_API_KEY=`, `DATABASE_URL=` …); handing it a GitHub
  token would invert its security posture. Reviewed and deliberately skipped.
- **Token visibility (same posture as existing art).** The token rides the
  tmux `new-session -e` argv — momentarily visible in the process list and
  in tmux's session environment, exactly like the existing
  `INSTAR_AUTH_TOKEN` and `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`
  injections at the same sites. This increment deliberately matches that
  established posture rather than inventing a second transport; tightening
  all of them together is its own future increment if wanted.
- **Per-spawn vault read.** One decrypt per spawn (and on macOS possibly one
  read-only keychain probe via the dual-key candidates). Spawns are seconds-
  long, rare operations; no caching added (a fresh read also means a newly
  dropped token is picked up by the very next spawn with no restart).

## Why vault-only (no hosts.yml fallback parsing)
Option C's value is the agent using ITS OWN seat. Parsing the machine-global
hosts.yml and injecting THAT token would re-create the exposure this exists
to close — so when the vault has no token we inject nothing and let `gh`
behave exactly as today. Phase-2 candidates (server-side `gh` calls in
routes.ts/CiFailurePoller, git-credential-helper for raw https pushes) are
catalogued in the increment ladder, not smuggled in here.

## Deflake that rode along (test-only)
Both reroute suites — `tests/unit/headless-spawn-reroute.test.ts` and
`tests/e2e/june15-headless-spawn-reroute.test.ts` — read the REAL host memory
pressure through the reroute gate: on a loaded dev machine they failed on a
PRISTINE tree (verified by stashing this change and re-running; unit 8 fails,
e2e 3 fails). Both now stub `currentMemoryPressure` to 'normal' — they assert
reroute logic, not host health. No production code touched by the deflake; no
test in either file asserts the pressure refusal.

## Test evidence
- `tests/unit/gh-token-vault.test.ts` (10): both key paths, precedence,
  trimming, absent vault, wrong-key, non-string, whitespace, corrupt-vault
  never-throws, production-path dual-key file-candidate read.
- `tests/unit/session-spawn-gh-token.test.ts` (5): REAL StateManager + REAL
  vault + REAL resolver, argv-capturing tmux mock — token present in headless
  env + INSTAR canaries intact; no vault → no flag; corrupt vault → spawn
  succeeds, no flag; whitespace token → no flag; rerouted-interactive lane
  carries the token too.
- Canaries green: headless-spawn-reroute (23), session-manager behavioral /
  terminate / injection, SecretStore, GitSync, no-silent-fallbacks — 119/119.
- `tsc --noEmit` clean; `docs-coverage --check` floors hold (no new routes,
  no new PascalCase core class file — `ghToken.ts` is a lowercase module by
  design).
