# Side-Effects Review — Codex enrollment uses `codex login --device-auth`

**Version / slug:** `codex-enroll-device-auth`
**Date:** `2026-09-21`
**Author:** `Echo`
**Second-pass reviewer:** `required (touches session/login lifecycle)`

## Summary of the change

The per-framework enrollment login-command map (`DEFAULT_ENROLL_LOGIN_COMMANDS`) had `'codex-cli': 'codex login'`. Plain `codex login` uses a localhost-callback browser flow that cannot complete on a headless follow-me target, so the wizard scrapes no code and enrollment throws `EnrollmentDriveError` → `502 login-did-not-start`. Codex's enrollment flow-kind is already `device-code` (`EnrollmentWizard.defaultKind`/`remoteKind` for the `openai` provider), so the command must supply `--device-auth` to actually print a code — exactly as `grok-build` already does. Fix: default becomes `codex login --device-auth`. The map was extracted from a local const in `src/commands/server.ts` to an exported const in `src/core/FrameworkLoginDriver.ts` so a unit test can guard the invariant. Files: `src/core/FrameworkLoginDriver.ts` (export + fixed value + rationale), `src/commands/server.ts` (import instead of local def), `tests/unit/framework-login-driver.test.ts` (regression tests).

## Decision-point inventory

- `DEFAULT_ENROLL_LOGIN_COMMANDS['codex-cli']` (enrollment command selection) — **modify** — changes the spawned login command string so a device-code artifact is produced. This is a data/config value, not a runtime gate; it selects which CLI invocation runs. No block/allow authority.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** This selects a login command string; it neither admits nor rejects any input.

---

## 2. Under-block

**No block/allow surface — under-block not applicable.** The one adjacent safety fence (`OPERATOR_ONLY_SESSION_KEYS` / executable-selection fence on `PATCH /config`) is unchanged; enrollment login commands remain operator-overridable only via the config file, exactly as before.

---

## 3. Level-of-abstraction fit

Correct layer. The command map is data consumed by the enrollment wizard's login driver; the fix is a data correction at that same layer, matching the flow-kind the wizard already resolves for the provider. Moving the map into `FrameworkLoginDriver.ts` places it beside the other enrollment helpers (`enrollPaneSessionName`, `enrollmentBrowserEnv`, `enrollmentCredentialPath`) and the driver that consumes it — a better home than a local variable inside 15k-line server startup. No higher-level gate is bypassed; no lower-level primitive is re-implemented.

---

## 4. Signal vs authority compliance

No authority added. `DEFAULT_ENROLL_LOGIN_COMMANDS` holds no blocking authority; it is a lookup table of command strings. The change adds no gate and touches no detector/authority boundary. `docs/signal-vs-authority.md` — not applicable beyond confirming nothing was granted authority.

---

## 5. Interactions

- **Operator override (`subscriptionPool.enrollment.loginCommands`)** — still merges *on top of* the default (`{...DEFAULT, ...override}`), so a machine that set its own codex command (e.g. the dev Studio, which already had `codex login --device-auth`) is unaffected. Only machines relying on the default change behavior.
- **`EnrollmentWizard.defaultKind`/`remoteKind`** — unchanged; the command now matches the kind those already return (`device-code` for `openai`). The test cross-checks this alignment.
- **`FrameworkLoginDriver.parseArtifact`** — unchanged; it already parses the Codex device-code artifact (URL + `XXXX-YYYY` code). Verified live: `codex login --device-auth` prints `https://auth.openai.com/codex/device` + a `R2A0-YP9AG`-shape code that the existing scraper matches.
- No double-fire, shadowing, or races: this is a single string constant read once at server construction.

---

## 6. External surfaces

- **Codex CLI invocation** changes from `codex login` to `codex login --device-auth` on machines using the default. `--device-auth` is a supported flag in the deployed codex CLI (verified: `codex-cli 0.153.4`, `codex login --help` lists `--device-auth`). Produces only a public URL + one-time code, never a token.
- No change to any HTTP route, dashboard surface, or agent-to-agent surface. The `/subscription-pool/follow-me/*` and `/matrix/start-cell` routes are unchanged; they simply now receive a scrapeable artifact from the target.
- Behavior is deterministic (a constant string); no dependence on timing or conversation state.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design, and that is the whole point.** Each machine reads its own `DEFAULT_ENROLL_LOGIN_COMMANDS` (merged with its own optional config override) at server start; the enrollment login runs on the *target* machine. Nothing replicates and nothing should — the login command is a property of the machine doing the sign-in. The fix specifically repairs the *remote* (headless follow-me target) case: the old browser-callback command worked only on a machine with a browser, so cross-machine enrollment was silently broken; `--device-auth` is machine-independent. No generated URL, durable-state, or one-voice-notice surface is introduced.

## 8. Rollback cost

Trivial. Three ways back, in order of preference: (a) revert the one-line default value; (b) an affected machine sets `subscriptionPool.enrollment.loginCommands["codex-cli"]` in its config to override without a code change; (c) full commit revert (the extract-to-exported-const is inert data movement). No migration, no state repair, no data touched. Existing Codex logins already on disk are unaffected — this only governs *new* enrollments.
