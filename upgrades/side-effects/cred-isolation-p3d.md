# Side-effects review — credential-resolution audit + boot coherence (Inc-P3d)

## What this change does

Adds Caroline-class OBSERVABILITY to the per-agent credential-isolation
work: (1) the SafeGitExecutor funnel now records its identity-resolution
decisions (repo-local-strip / host-identity-inject) to
`.instar/audit/credential-resolution.jsonl`, and (2) `AgentServer.start()`
takes a one-line boot coherence sample comparing the agent's repo-local
identity against the machine's other identity surfaces (inherited identity
env vars, machine-global gitconfig, gh CLI auth-state presence). Both are
signal-only.

## Decision boundary (both sides tested)

- Identity stripped (Caroline shape) → one `resolution` entry with
  `decision: repo-local-strip` and the stripped keys. Proven by a REAL
  funnel commit under a fully polluted env (integration tier).
- Nothing to strip → NO entry (unit tier).
- Host identity injected (repo without local identity) → one
  `host-identity-inject` entry with the injected keys (unit tier).
- Boot with divergent surfaces → one `boot-coherence` entry + one console
  warning; boot proceeds (e2e tier, real `AgentServer.start()`).
- Boot with clean surfaces → zero divergences (unit tier, deterministic via
  a homeDir override so the host machine's real `~/.gitconfig` can't leak
  into assertions).
- `INSTAR_AUDIT_LOG_DISABLED=1` → no writes anywhere; operations and boot
  unaffected (unit + integration + e2e).

## Blast radius

- `src/core/SafeGitExecutor.ts`: new exported `appendCredentialResolutionEntry`,
  `auditBootCredentialCoherence`, `CredentialResolutionEntry`,
  `BootCredentialCoherenceReport`; emit calls inside `sanitizeEnv` (both
  branches). All probes and writes are pure `node:fs` — NO subprocess
  (the P3a lesson: funnel-internal subprocess calls consume mocked
  child_process sequences in downstream suites; verified GitSync.test.ts
  stays green).
- `src/server/AgentServer.ts`: one fail-soft try/catch block in `start()`
  calling the boot sampler with the stateDir's PARENT (the agent repo).
  Console warning only when divergences exist.
- Write volume: resolution entries are deduped per process on
  (decision, cwd, keys) — a sync loop records once, not per tick.
  Boot-coherence is one line per server boot.
- Same `INSTAR_AUDIT_LOG_DIR` / `INSTAR_AUDIT_LOG_DISABLED` env overrides
  as the existing destructive-ops audit; tests use them for isolation.
- No new routes (docs-coverage route floor untouched), no new core class
  files (class floor untouched), no config flag, no migration surface.

## Migration parity

No agent-installed files change (no hooks, no config defaults, no CLAUDE.md
template text, no skills). Behavior ships entirely in code on update.

## Framework generality

Framework-agnostic — the funnel and the server boot path serve every
framework's instar install identically.

## Tests

- `tests/unit/credential-resolution-audit.test.ts` — 10 tests: emit truth
  table both sides, dedupe + reset, disable switch, boot coherence
  (divergent env, clean surfaces, global-gitconfig divergence, gh
  presence, not-a-repo never throws).
- `tests/integration/credential-resolution-funnel.test.ts` — 3 tests: the
  OBSERVED Caroline replay (real funnel commit lands as the agent AND is
  recorded), signal-only with auditing disabled, flood-control under a
  sync-style loop.
- `tests/e2e/credential-coherence-boot.test.ts` — 4 tests: real
  `AgentServer.start()` writes exactly one boot-coherence line with the
  repo-local expected identity, flags the inherited env var, serves authed
  requests despite divergence (200 not 503), boots clean with auditing
  disabled.
- Regression canaries green: SafeGitExecutor (48), GitSync (16),
  no-silent-fallbacks (5) — 69/69; tsc clean.

## Rollback

Delete the emit calls in `sanitizeEnv`, the credential-audit block in
SafeGitExecutor, and the boot-sample block in `AgentServer.start()`. The
JSONL file is inert data; no state or config to unwind.
