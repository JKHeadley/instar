# Side-Effects Review — Credential redaction in URL logging (MM-Bootstrap Track B)

**Spec:** `docs/specs/MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.md` §Track B (approved PR #465).

**Scope.** `src/core/redactUrl.ts` (new), `src/commands/machine.ts` (3 log sites),
`scripts/lint-no-direct-url-log.js` (new, wired into `npm run lint`),
`src/templates/scripts/convergence-check.sh` (own-tunnel-domain allowlist sub-fix),
`tests/unit/redactUrl.test.ts` (new).

**Problem.** During `instar join` on 2026-05-27, when the pair-verification fetch
failed, instar logged `err.message` — which contained the full clone URL
*including a live GitHub token* (`https://x-access-token:gho_…@github.com/…`).
Node's own fetch/URL errors echo the credentialed URL in `err.message`, so even
catching the error and logging its message leaked the secret to stdout (and the
shell transcript, and likely local logs).

**Fix.**
- `redactUrl(input)` — strips the `user:pass@` userinfo segment (string-splice
  so the rest of the URL is byte-preserved + logs stay useful), plus scrubs
  standalone known-token shapes (GitHub `gh[posru]_`, fine-grained `github_pat_`,
  Slack `xox[baprs]-`, Telegram `<id>:<secret>`, OpenAI `sk-`).
- `redactUrlsInText(text)` — for error messages / prose that embed a URL
  somewhere inside; regex-scrubs every `scheme://userinfo@` + standalone tokens.
- Applied at the 3 join-flow leak sites in `machine.ts` (clone error, the
  "Contacting <url>" line, the contact-server error).
- `scripts/lint-no-direct-url-log.js` bans (a) `scheme://user:pass@` string
  literals and (b) `console.* (...repoUrl|cloneUrl|remoteUrl|pushUrl|gitUrl...)`
  without `redactUrl` on the same line, outside the funnel module. Wired into
  `npm run lint` (CI Type-Check job) — defense-in-depth so a future leak can't
  ship.
- Convergence-check sub-fix: the outbound-message gate's URL-provenance
  allowlist now skips the agent's OWN live tunnel host (read from
  `.instar/state/tunnel.json`) + the common tunnel domains (`dawn-tunnel.dev`,
  `trycloudflare.com`), so the agent can send links to its own private views
  without the gate flagging them as fabricated. (Separate annoyance hit the
  same night; folded in per spec.)

**Side-effects review.**
- **Logs stay useful.** Redaction replaces only the userinfo with `***`; host,
  path, and query are preserved. A reader still sees which repo/host failed.
- **Fail-OPEN to the SAFE side.** On any parse failure, `redactUrl` still
  regex-scrubs rather than returning raw input — it never leaks on the error
  path, and it never throws (verified by test).
- **Idempotent.** Re-redacting an already-redacted string is a no-op (test).
- **No behavior change to the join logic itself** — only what gets *logged*
  changes. The fetch still constructs the same URL (the separate
  api/pair-hits-the-wrong-URL logic bug is out of Track B scope; noted for
  Track E).
- **No false-positive risk in the lint** — it flags only the two concrete
  credential-bearing shapes, not every URL log. The tunnel-URL log sites
  (`server.ts`, `machine.ts:236`) carry no userinfo and are not flagged.
- **Convergence-check is additive** — it only ADDS skips to the allowlist;
  no previously-flagged URL becomes un-flagged except the agent's own tunnel
  + the two common tunnel domains (all legitimately the agent's own surfaces).

**Test coverage (3-tier).**
- Unit: `tests/unit/redactUrl.test.ts` — 13 cases incl the exact 2026-05-27
  leak string, basic-auth, user-only, token-in-query, Telegram-bot-token path
  form, multiple URLs in one string, malformed-input-never-throws, idempotency,
  empty string, URL-object input. All green.
- Integration: a join-flow redaction test (invoke join with a fake credentialed
  URL that fails, scrape stdout, assert no `gho_`/`:secret@` present) — see
  `tests/integration/join-credential-redaction.test.ts`.
- Lint (CI): `scripts/lint-no-direct-url-log.js` runs in `npm run lint`.

**Migration parity.**
- `redactUrl.ts` + `machine.ts` are server source — existing agents pick up the
  fix on next dist refresh (auto-update). No agent-installed-file change.
- `convergence-check.sh` is a built-in script installed at
  `.instar/scripts/convergence-check.sh`; built-in hooks/scripts are
  always-overwritten on every migration run (per the Migration Parity Standard),
  so existing agents receive the updated allowlist on their next update.
- The lint script is dev/CI-only; not installed into agents.

**Rollback.** Revert the PR. URL logging returns to unredacted (the prior,
leaky behavior) and the lint rule + convergence-check skip go with it. No data
corruption, no migration to reverse.
