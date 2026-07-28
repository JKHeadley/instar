# Side-Effects Review — Telegram inbound files under project dir

**Version / slug:** `telegram-inbound-project-dir`
**Date:** `2026-06-04`
**Author:** `instar-codey`
**Second-pass reviewer:** `not run — sub-agent tool requires an explicit delegation request in this session`

## Summary of the change

Long Telegram inbound payload files and Telegram auto-spawn context files move
from `/tmp/instar-telegram` to `<projectDir>/.instar/telegram-inbound` through a
single helper, `getTelegramInboundDir(projectDir)`. Runtime callsites updated:
`src/core/SessionManager.ts`, `src/commands/server.ts`, and
`src/server/routes.ts`. The cleanup function now targets the same project-local
directory, `.gitignore` excludes it, and focused tests assert that long-message
files land under the configured project directory and that injected references
point there.

## Decision-point inventory

- Telegram long-message file redirect in `SessionManager.injectTelegramMessage`
  — modify — same threshold and same injected reference shape, but the backing
  file path is project-local.
- Telegram bootstrap/context side-file creation in `src/commands/server.ts` and
  `src/server/routes.ts` — modify — same session spawn behavior, but side files
  are readable from sandboxed project workspaces.
- `cleanupTelegramTempFiles` — modify — same 7-day file-only cleanup policy, but
  applied to the new project-local inbound directory.
- No new block/allow authority is added.

---

## 1. Over-block

No block/allow surface — over-block not applicable. This change does not reject
messages, users, topics, sessions, or actions.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Remaining failure modes:
if the configured `projectDir` is wrong, inbound files will consistently be
written under that wrong project. That is not newly introduced by this change;
the same config value already controls session startup, state paths, and other
project-local behavior. If a sandbox denies `.instar/telegram-inbound` despite
allowing the project root, the agent would still receive an unreadable reference,
but that would indicate a broader sandbox/config mismatch.

---

## 3. Level-of-abstraction fit

The helper belongs in the shared messaging layer because the path is a Telegram
messaging primitive used by both core session injection and server-side
Telegram auto-spawn routes. It is not a policy gate and should not live in
`SessionManager` alone, because route code also writes context side files. It is
also not a config migration: this is transient runtime storage derived from the
already-required project directory.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] Yes, with brittle logic — STOP. Reshape the design. Brittle detectors must not own block authority.

This is a storage-location change for already accepted Telegram payloads. It
does not inspect message meaning, classify user intent, block delivery, or
filter content.

---

## 5. Interactions

- **Shadowing:** no gate is shadowed. Existing InputGuard and topic/session
  routing still run before message injection and are untouched.
- **Double-fire:** no new writer is added; existing writers now call the shared
  helper. The same message creates the same one payload file as before.
- **Races:** cleanup still removes only files older than 7 days. It now shares
  the same directory helper as the writers, reducing drift. The cleanup window
  is far longer than any active read window, so it should not race fresh
  inbound messages.
- **Feedback loops:** the injected path is read by the receiving agent. Moving
  the file under `.instar/telegram-inbound` changes the path text the agent
  sees, but does not feed back into routing, dedup, or gate decisions.

---

## 6. External surfaces

This is visible to agents receiving long Telegram messages: the injected file
reference now points under `.instar/telegram-inbound` in the project instead of
`/tmp/instar-telegram`. That is intentional so Gemini CLI can read the file
inside its workspace sandbox. Users should not see a conversational difference
except that long Telegram messages are readable by sandboxed agents. No
Telegram API behavior changes, no Slack behavior changes, no database schema
changes, and no persistent committed state is introduced. The new directory is
ignored by git because payloads may include private user message content.

---

## 7. Rollback cost

Pure code rollback. Reverting the helper use would put future files back under
`/tmp/instar-telegram`; no database migration or state repair is required.
Existing transient files under `.instar/telegram-inbound` can be left in place
or removed by cleanup if the rollback keeps that cleaner. User-visible risk
during rollback is limited to sandboxed agents losing readability of long
Telegram inbound payloads again.

---

## Conclusion

The review found the key risk is path drift across the multiple Telegram
writers and cleanup, so the implementation uses one shared helper and updates
tests that previously encoded `/tmp/instar-telegram`. The change is clear to
ship with focused regression coverage on the relay-sensitive file reference
path.

---

## Second-pass review (if required)

**Reviewer:** `not run`
**Independent read of the artifact:** `not available`

Inbound messaging is relay-sensitive, but the multi-agent tool exposed in this
session is restricted to explicit user-requested delegation. I did not spawn a
reviewer under that constraint. The PR should receive human review on the
runtime callsites and tests before merge.

---

## Evidence pointers

- `npm test -- --run tests/unit/session-telegram-inject.test.ts tests/e2e/input-guard-e2e.test.ts tests/unit/server-temp-cleanup.test.ts tests/unit/bootstrap-file-threshold.test.ts tests/unit/telegram-message-injection.test.ts`
- `rg` check found no remaining runtime `/tmp/instar-telegram` use in
  `src/core/SessionManager.ts`, `src/commands/server.ts`, or
  `src/server/routes.ts`.
