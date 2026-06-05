# Side-effects review — re-arm two quarantined CI gates + ambient-credential test hygiene

Found during the 2026-06-05 full-suite triage (37 local failures enumerated and
classified to root cause). Two of the repo's own source-content GUARDS had
rotted while parked in the vitest.push.config.ts quarantine list — CI never ran
them, so the exact bug classes they exist to catch reached main unnoticed.

## 1. The change

- **`src/monitoring/mcpProcessReaperDeps.ts`** — the `ps | egrep | grep -v`
  shell pipeline (bare `execSync`) becomes `execFileSync` with argv arrays (no
  shell, no interpolation surface); the coarse egrep pre-filter moves into JS
  (`new RegExp(mcpGrepAlternation(), 'i')`) ahead of the existing precise
  `matchMcpSignature` second stage. Behavior-preserving: same ps fields, same
  two-stage filtering, same empty-string-on-failure contract.
- **`src/core/PostUpdateMigrator.ts`** — `migrateFrameworkShadowCapabilities`
  markers[] gains the coordination-mandate capability family
  (`**Coordination Mandate**`, `**ReviewExchange (autonomous code review)**`,
  `**Cutover Readiness**`). These are framework-agnostic HTTP capabilities in
  BOTH templates.ts and the migrator, but were never mirrored to AGENTS.md /
  GEMINI.md — a Codex/Gemini agent under a future mandate would never learn
  `/mandate/evaluate` and would improvise around the gate (the Secret Drop
  lesson). Mirroring is the existing idempotent slice-and-append mechanism;
  no new mechanism.
- **`tests/unit/feature-delivery-completeness.test.ts`** — tracks the mandate
  family as featureSections (template ↔ migrator ↔ shadow-marker parity now
  enforced) + the four content-sniff keys as alternate checks.
- **`tests/unit/watchdog-bind-probe.test.ts` /
  `tests/unit/serendipity-capture.test.ts`** — ambient-credential hygiene: both
  spread `...process.env` into child envs, and on agent boxes the REAL
  `INSTAR_AUTH_TOKEN` preempted the fixture tokens (Authorization-header and
  HMAC-key assertions failed locally while green in CI). The sandboxes now
  strip the ambient token; a test that wants one sets it explicitly.
- **`vitest.push.config.ts`** — security.test.ts +
  feature-delivery-completeness.test.ts REMOVED from the quarantine (re-armed;
  both are deterministic source guards — the "environment-dependent" label was
  wrong). TunnelManager.test.ts stays parked but its label now states the
  truth: 22/29 tests fail because the suite predates the provider/tier rewrite
  with the real reachability probe; rewrite tracked as a durable commitment.

## 2. Blast radius

- The reaper deps refactor is invisible to consumers (identical output
  contract; the factory has no direct unit tests — covered by typecheck and
  the McpProcessReaper suite, re-run green).
- The markers addition only ever APPENDS missing sections to existing
  AGENTS.md/GEMINI.md shadows on the next migration run — idempotent,
  no-op for Claude-only installs, copies content verbatim from the
  just-migrated CLAUDE.md so the files cannot drift.
- Re-arming the two gates makes CI run 84 currently-green deterministic tests
  it previously skipped. Risk is future-positive: regressions in these guards
  now fail PRs instead of rotting.

## 3. Test coverage

- 5 directly-touched/affected files re-run green locally: 164 tests
  (run WITH the real INSTAR_AUTH_TOKEN still exported — proving the hygiene
  fix, since these exact assertions failed before it).
- Full PostUpdateMigrator + shadow-capability surface: 49 files / 324 tests
  green after the markers change.
- `npx tsc --noEmit` clean.
