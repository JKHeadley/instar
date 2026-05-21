# Side-Effects Review — Secret Drop Hardened Retrieve Template

**Version / slug:** `secret-drop-hardened-retrieve-template`
**Date:** `2026-05-21`
**Author:** `Echo (instar-developing agent)`
**Second-pass reviewer:** `not required` (template install + documentation rewrite; no new gate/block authority)

## Summary of the change

Ships the hardened `secret-drop-retrieve.mjs` as an `src/templates/scripts/` template; wires it into `init.ts` (for new agents) and `PostUpdateMigrator.migrateScripts` (for existing agents); rewrites the `[secret-drop-received]` spawn message, the `[secret-drop-stuck]` retry message, the CLAUDE.md template, and the `/capabilities.secrets.retrievalHint` to instruct the hardened command form. Adds a `migrateClaudeMd` block that detects the legacy `curl /secrets/retrieve/TOKEN` line and rewrites it in place; idempotent and port-tolerant.

Files touched:

- `src/templates/scripts/secret-drop-retrieve.mjs` — new template.
- `src/commands/init.ts` — `installSecretDropRetrieve` + three call sites.
- `src/core/PostUpdateMigrator.ts` — `migrateScripts` block (always-overwrite); `migrateClaudeMd` block (port-tolerant rewrite).
- `src/server/routes.ts` — spawn message + stuck-consumer retry message + `/capabilities.secrets.retrievalHint`.
- `src/scaffold/templates.ts` — CLAUDE.md Secret Drop documentation block.
- `tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts` — new tests (8 cases).
- `upgrades/NEXT.md` — release notes (minor bump).
- `docs/specs/secret-drop-hardened-retrieve-template.{md,eli16.md}` — spec + ELI16.

## Decision-point inventory

- `[secret-drop-received]` spawn message — **modify** — guidance the agent reads to learn how to retrieve. Unsafe → hardened.
- `[secret-drop-stuck]` retry message — **modify** — same retrieval path on the retry branch.
- CLAUDE.md Secret Drop block (template + migrator) — **modify** — agent's static retrieval guidance.
- `/capabilities.secrets.retrievalHint` — **modify** — discovery-surface guidance.

No new gate/block surface introduced. The `/secrets/retrieve` endpoint behavior is unchanged.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. The migrator's CLAUDE.md rewrite is the closest thing to a block: it refuses to touch a CLAUDE.md that already documents `secret-drop-retrieve.mjs` (idempotent skip). That's the desired behavior — over-block would require the migrator to refuse legitimate rewrites, which it does not.

---

## 2. Under-block

**What failure modes does this still miss?**

The migrator's regex matches the exact legacy-line pattern. A CLAUDE.md that someone manually customized to use a different unsafe pattern (e.g., `wget` instead of `curl`, or a piped one-liner) would slip past the rewrite. Acceptable: the rewrite is the structural fix for the documented unsafe pattern; bespoke unsafe variants are out of scope and would be visible to anyone reading their own CLAUDE.md.

The hardened helper itself still reads `.instar/config.json` for the authToken. If the config file is missing, the script exits 2 with a clear stderr message; if the file is present but `authToken` is empty, the script does a request with an empty bearer and the server returns 401 — the script prints the 401 status (no body). Both paths are safe.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

The change lives at the agent-facing instruction layer, which is the correct level. Three reasons:

1. The leak is caused by the agent running a documented command verbatim. The fix is to make the documented command safe.
2. Adding a server-side gate (e.g., refuse `/secrets/retrieve` without a hardened-client header) would create a brittle detector with block authority — violating the signal-vs-authority principle. The server stays permissive; the agent layer is hardened by making safe the only documented path.
3. The hardened helper itself is a thin wrapper around `fetch`. It doesn't introduce new architecture; it constrains how the value flows out of the response.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface at runtime.

The migrator's CLAUDE.md rewrite has commit-time block authority via the precommit hook, but only by virtue of being a code change; the migrator itself does not refuse anything at runtime. The hardened helper has no gate logic — it just streams a value or exits with an error code.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** the `[secret-drop-received]` spawn message replaces the existing one verbatim (no append, no shadow). The existing 5-minute cleanup timer and the stuck-consumer event from PR #288 are unchanged — both rely on server-side state, not on the system-message content.
- **Double-fire:** the migrator runs each of `migrateScripts` and `migrateClaudeMd` once per `instar update` invocation. Neither path is recursive.
- **Races:** the migrator runs single-threaded against an agent that is not yet started; no concurrent writers to the files it touches.
- **Feedback loops:** none. The agent reading the new guidance produces no input back into the migrator.

The `PostUpdateMigrator.loadRelayTemplate` helper is reused (not duplicated) for loading the new template. Symmetric with `getTelegramReplyScript`.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Agents on the same machine:** yes — every existing agent picks up `.instar/scripts/secret-drop-retrieve.mjs` on the next update, and any agent whose CLAUDE.md still has the legacy retrieve line gets it rewritten in place. The behavioral change is that the agent learns a safer command form. The unsafe `/secrets/retrieve` endpoint continues to work unchanged for any caller (including custom integrations); only the guidance is updated.
- **Other agents on the install base:** same — Codex / Gemini agents that read CLAUDE.md / AGENTS.md / GEMINI.md get the rewrite via `migrateFrameworkShadowCapabilities` (existing migrator path that mirrors CLAUDE.md changes to non-Claude shadows).
- **External systems:** no external surface touched.
- **Persistent state:** none beyond the file install (which is by design).
- **Timing / runtime conditions:** the new helper makes one `fetch` call per invocation; same latency profile as the curl it replaces.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code change. Revert the migrator + init + templates + spec/artifact files. The script previously installed by the migrator stays on disk for existing agents (the rollback doesn't delete). The CLAUDE.md rewrites previously applied to existing agents also stay — which is fine because the hardened guidance points at a script that still exists (the install path doesn't go away during a code-only rollback).

Realistic rollback: revert + patch release. Under 5 minutes. The only concern would be a downstream agent that started depending on a quirk of the hardened helper (e.g., expecting an exact stderr format). The script's output contract is documented in the file header; downstream tooling using it should pin against that, not against ephemeral implementation details.

---

## Conclusion

This is a low-risk hardening change focused on agent-facing guidance. It closes the structural side of the 2026-05-20 leak class: every documented path now teaches the safe pattern. The runtime change is a script install + a sequence of string rewrites; no new decision points introduced; signal-vs-authority preserved. No second-pass review required.

---

## Evidence pointers

- Spec: `docs/specs/secret-drop-hardened-retrieve-template.md`
- ELI16: `docs/specs/secret-drop-hardened-retrieve-template.eli16.md`
- Tests: `tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts` (8 cases, all green).
- Existing coverage that continues to pass with the updated guidance strings: `tests/unit/capabilities-discoverability.test.ts`, `tests/unit/secret-drop-hardening.test.ts`.
- Origin: 2026-05-20 leak incident (topic 9984); 2026-05-21 case-study audit (topic 11141, follow-up #1).
