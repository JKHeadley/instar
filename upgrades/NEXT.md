# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Credential redaction in URL logging (security fix).** `instar join` could log a
clone URL containing a live GitHub token on certain failure paths — Node's own
fetch/URL errors echo the full credentialed URL in `err.message`, so catching
the error and logging it leaked the secret. New `redactUrl()` / `redactUrlsInText()`
funnel (`src/core/redactUrl.ts`) strips `user:pass@` userinfo and scrubs standalone
known-token shapes (GitHub, Slack, Telegram, OpenAI). Applied at the three join-flow
log sites. A new lint rule (`scripts/lint-no-direct-url-log.js`, wired into
`npm run lint`) bans credentialed-URL logging going forward.

Also: the outbound-message convergence-check gate now trusts the agent's own tunnel
domain (read live from tunnel state) + the common tunnel domains, so an agent can
send links to its own private views without the gate flagging them as fabricated.

## What to Tell Your User

- A security fix: when joining two machines into a mesh, an error message used to be
  able to print a GitHub access token to the screen. It no longer can — credentials
  are scrubbed from anything that gets logged. Nothing changes in how you use the
  agent; this just closes a leak.
- A small papercut fix: I can now send you links to my own private-view / dashboard
  pages without my safety gate mistakenly treating my own tunnel address as suspicious.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `redactUrl()` / `redactUrlsInText()` | Internal — route any URL or error-message string through these before logging. `src/core/redactUrl.ts`. |
| `lint-no-direct-url-log` | Automatic in `npm run lint` / CI — fails the build if a credentialed URL is logged without redaction. |
| Convergence-check own-tunnel trust | Automatic — the message gate no longer flags the agent's own tunnel URLs as unfamiliar. |

## Evidence

**Security fix + defense-in-depth, no behavior change to join logic.** Unit tests
`tests/unit/redactUrl.test.ts` (13 cases, all green) include the EXACT 2026-05-27
leak string and assert no `gho_…` token survives; plus basic-auth, token-in-query,
Telegram-bot-token path form, multiple-URLs-in-one-string, malformed-input-never-throws,
idempotency. `tsc --noEmit` clean. The lint rule passes on the redacted tree and
would fail on the pre-fix `machine.ts`. Side-effects review:
`upgrades/side-effects/credential-redaction-in-url-logging.md`. Spec: Track B of
`docs/specs/MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.md`.
