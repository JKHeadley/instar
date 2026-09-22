# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Codex account enrollment ran `codex login`, whose default is a localhost-callback
browser flow that cannot complete on a headless follow-me target — so enrolling a
Codex account onto another machine (Mac Mini, laptop) printed no code for the wizard
to scrape and died with `login-did-not-start`. Codex's enrollment flow-kind was
already `device-code` (`EnrollmentWizard.remoteKind('openai')`), so the command had
to supply `--device-auth` to actually produce a code — exactly as `grok-build`
already did. The default Codex enrollment command is now `codex login --device-auth`,
which prints a public verification URL + one-time code that works on any machine,
with no token ever leaving the CLI. The per-framework command map was moved from a
buried local variable in server startup to an exported `DEFAULT_ENROLL_LOGIN_COMMANDS`
in `FrameworkLoginDriver.ts` and a unit test now locks the "command must match the
flow-kind" invariant. The operator override (`subscriptionPool.enrollment.loginCommands`)
still merges on top, unchanged.

## What to Tell Your User

If you have Codex accounts that need setting up on your other machines, those "Set
up" buttons will now actually work hands-off — the sign-in produces a code the agent
can approve, instead of silently failing on a machine with no browser.

## Summary of New Capabilities

- Codex accounts can enroll onto headless / remote machines (device-code sign-in).
- The enrollment command now matches the flow-kind the wizard already expects.
- A regression test guards the invariant so Codex can't silently revert to a
  browser-only login command.
- Operator per-machine login-command overrides are preserved.

## Evidence

- Unit `tests/unit/framework-login-driver.test.ts` (29 passing, 3 new): asserts
  `DEFAULT_ENROLL_LOGIN_COMMANDS['codex-cli'] === 'codex login --device-auth'`; that
  every device-code-kind framework (codex, grok) carries `--device-auth` and its
  provider resolves to `device-code` via `EnrollmentWizard.remoteKind`; and that the
  url-code-paste path (Claude/anthropic) deliberately does not.
- `tsc --noEmit` clean (0 errors) after the export/import refactor.
- Live verification: on the deployed codex CLI (`codex-cli 0.153.4`), `codex login
  --device-auth` prints `https://auth.openai.com/codex/device` + a `XXXX-YYYY` code
  that the existing `FrameworkLoginDriver.parseArtifact` device-code scraper matches;
  a full device-auth sign-in completed end-to-end against a throwaway `CODEX_HOME`.
