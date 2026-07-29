# Side-effects review — Dashboard PIN placeholder-leak fix

## What this change does
Fixes a user-facing leak: `TelegramAdapter.broadcastDashboardUrl` printed the
literal placeholder `(check your config)` in place of the dashboard PIN whenever
`this.config.dashboardPin` was falsy. Live incident (2026-06-06, topic 5): a
transient vault/keychain read failure during a server boot under host pressure
left the loadConfig secret-merge incomplete, so `dashboardPin` arrived as the
unresolved `{secret:true}` ref (or empty), the `|| '(check your config)'`
fallback fired, and the user received `PIN: (check your config)` — a value they
cannot act on, reading like an instruction.

Three pieces:
- `src/core/dashboardPin.ts` (new) — `resolveDashboardPinFromVault(stateDir)`
  and `pickDashboardPin(inMemory, stateDir)`: pure fs/crypto vault reads;
  trim; never the placeholder; return null on absent vault / absent key /
  non-string / whitespace / placeholder / any read error. Never throws. No
  subprocess (the P3a GitSync mock-sequence lesson: messaging-path helpers must
  not consume scripted child_process mock values). Mirrors `ghToken.ts`.
- `TelegramAdapter.resolvedDashboardPin()` (new private seam) — `pickDashboardPin(this.config.dashboardPin, this.stateDir)`. The seam exists
  so the broadcast wiring is unit-testable without network I/O.
- `formatDashboardMessage(url, pin: string | null, isNamed)` — now accepts a
  nullable PIN; a null PIN omits the PIN line and substitutes an honest,
  actionable note ("ask me for your dashboard PIN and I'll send it"). The
  placeholder string is removed from the adapter entirely.

## Blast radius
- **Behavior-preserving for the normal case.** When `config.dashboardPin` is a
  usable string (the overwhelmingly common path — loadConfig resolved it), the
  message is byte-for-byte identical to before: `PIN: \`<pin>\``.
- **Two new recovery behaviors, both strictly safer than the old leak:**
  (1) a transient boot-resolution failure is recovered by re-reading the vault
  at send time, so the user gets the REAL PIN where they previously got the
  placeholder; (2) total unresolvability omits the line honestly instead of
  emitting placeholder/`[object Object]`.
- **Fail-soft end to end.** A corrupt/unreadable vault logs one console.warn and
  the broadcast proceeds with the PIN line omitted (tested with a deliberately
  garbaged vault file).
- **Per-broadcast vault read only on the fallback path.** When the in-memory
  PIN is usable, no vault read happens at all. The dashboard broadcast is a
  rare, edit-in-place operation (on tunnel/restart), so the occasional extra
  decrypt on the fallback path is negligible.
- **No new config, route, migration, or agent-installed file.** This is core
  source compiled into the shipped package; it reaches all agents via the
  normal package/server update — no PostUpdateMigrator entry is required
  (Migration Parity Standard applies only to agent-installed files: hooks,
  config defaults, CLAUDE.md template, hook scripts, skills).
- **Defense in depth retained.** `CoherenceMonitor`'s `(check your config)`
  output-sanity pattern is left in place as a backstop against any other code
  path that might ever produce the placeholder.

## Why a fresh vault read in the adapter (not just omit-on-null)
Omitting the line alone would prevent the leak but would also withhold the
user's PIN during a transient failure (until the next healthy broadcast). The
adapter already carries `this.stateDir` and reads config.json from disk at other
sites, so it can resolve the secret itself — the same means the GitHub-token
resolver uses. Re-resolving recovers the real PIN immediately rather than
degrading. The null-omit path remains as the robust floor for the case where
the vault genuinely cannot be read at send time too.

## Testing-tier applicability
This is a fix to formatting/resolution logic inside an existing messaging
method, not a new feature with HTTP routes or a server-lifecycle surface — so
Tier 2 (HTTP pipeline) and Tier 3 (E2E "feature is alive") have no applicable
surface here. Tier 1 covers it fully, including the wiring-integrity seam
(`resolvedDashboardPin`) the Testing Integrity Standard requires for the
resolution path.

## Test evidence
- `tests/unit/dashboard-pin-vault.test.ts` (16): resolver + picker against a
  REAL on-disk SecretStore (forceFileKey) — happy path, trimming, absent vault,
  wrong key, empty/whitespace, unresolved object, placeholder-never-returned,
  corrupt-vault never-throws, production dual-key read, in-memory-first
  preference, vault fallback for every unresolvable in-memory shape.
- `tests/unit/telegram-dashboard-pin-leak.test.ts` (9): the adapter — renders a
  real PIN (named + quick), omits the line with an honest note on null and
  NEVER emits the placeholder, and end-to-end recovers the real PIN from the
  vault when config holds the unresolved object (never `[object Object]`).
- Canaries green: TelegramAdapter, telegram-tokenless-relay, telegram-messaging,
  secret-migrator, config-secret-merge, gh-token-vault — 81/81.
- `tsc --noEmit` clean; full `npm run lint` clean (no-direct-destructive,
  no-direct-llm-http, url-log, topic-creation, headless-launch, state-registry,
  cas-emit, journal-actuation, codex-rule1 all pass).
