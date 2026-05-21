# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- minor = new agent-facing capability without breaking changes -->

## What Changed

**feat(secret-drop): ship the hardened retrieve helper as a template — and rewrite every line of agent guidance that previously taught the unsafe pattern.**

The 2026-05-20 incident exposed a credential-leak class: when an agent retrieved a Secret Drop submission via a raw `curl /secrets/retrieve/TOKEN`, the response body — including the secret value — landed in the Bash tool transcript. The fix existed as a one-off `secret-drop-retrieve.mjs` on a single agent's machine, but no other agent had it, and every line of agent-facing guidance (CLAUDE.md template, the spawned-session system message, the stuck-consumer retry message) still recommended the unsafe `curl` pattern.

This release closes the gap on six interlocking surfaces:

1. **Ship the hardened helper as a template.** `src/templates/scripts/secret-drop-retrieve.mjs` streams the requested field value to stdout, prints field NAMES + lengths to stderr, and structurally refuses to print the response body. New agents get it via `installSecretDropRetrieve` (called from three `init.ts` paths next to `installSerendipityCapture`).

2. **Migrate existing agents.** `PostUpdateMigrator.migrateScripts` always-overwrites `.instar/scripts/secret-drop-retrieve.mjs` on every update (same pattern as `convergence-check.sh`). Idempotent — running the migrator twice produces identical content.

3. **Rewrite the spawn message.** `src/server/routes.ts` no longer instructs the agent to `curl ... /secrets/retrieve/TOKEN` when a Secret Drop arrives. The new message points at `node .instar/scripts/secret-drop-retrieve.mjs TOKEN <field-name>` with an explicit warning against the raw curl pattern.

4. **Rewrite the stuck-consumer retry message.** Same hardened command form, same explicit warning.

5. **Rewrite the CLAUDE.md template.** `src/scaffold/templates.ts` documents the hardened command as the required retrieval pattern, with a one-line explanation of the leak class.

6. **Rewrite existing CLAUDE.md files.** `PostUpdateMigrator.migrateClaudeMd` detects the legacy `curl /secrets/retrieve/TOKEN` line (port-tolerant — matches any local port literal) and replaces it with the hardened guidance. Idempotent: a CLAUDE.md that already documents `secret-drop-retrieve.mjs` is left alone.

7. **Update the /capabilities `secrets.retrievalHint`.** The hint now gives the actual command form so an agent reading `/capabilities` learns the safe pattern directly from the discovery surface.

## What to Tell Your User

No user-visible behavior change. Agents will start using the hardened retrieve helper automatically — the next time they receive a Secret Drop submission, the spawned session reads the hardened command form from the system message, not the unsafe curl. Existing agents pick up the helper script and the CLAUDE.md rewrite on the next instar update run.

If you were ever shown the unsafe curl-against-secrets-retrieve pattern in chat, that guidance has been retired across every surface; the hardened helper is the only documented path now.

## Summary of New Capabilities

For the agent:

- `.instar/scripts/secret-drop-retrieve.mjs TOKEN field-name` — streams the value to stdout, never prints the body.
- `.instar/scripts/secret-drop-retrieve.mjs TOKEN --names` — discover field names + lengths.
- `.instar/scripts/secret-drop-retrieve.mjs TOKEN field-name --consume` — opt into one-shot semantics.

## Evidence

The leak class was reproduced before the fix: running `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/secrets/retrieve/<token>` against a known submission prints the full JSON `{"values":{"password":"actual-secret-here"}, ...}` to stdout, which lands in the Bash tool transcript.

After the fix, the hardened helper isolates the value path: `node .instar/scripts/secret-drop-retrieve.mjs <token> password` streams only `actual-secret-here` to stdout (no newline, pipeable), and prints nothing else. The `--names` mode prints only `password (length 16)` to stderr; stdout stays empty.

New tests:
- `tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts` — 8 cases covering script install (presence, executable bit, content invariants, idempotency) + CLAUDE.md rewrite (legacy → hardened, idempotent, port-tolerant).
- The existing `tests/unit/capabilities-discoverability.test.ts` continues to pass with the updated `secrets.retrievalHint` string.

Spec: `docs/specs/secret-drop-hardened-retrieve-template.md`
ELI16: `docs/specs/secret-drop-hardened-retrieve-template.eli16.md`
Side-effects: `upgrades/side-effects/secret-drop-hardened-retrieve-template.md`

Origin: 2026-05-20 leak incident (topic 9984) + 2026-05-21 case-study audit (topic 11141, follow-up #1).
