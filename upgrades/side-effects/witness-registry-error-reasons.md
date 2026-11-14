# Side-Effects Review — Witness: print the registry's returned reason on errors

**Version / slug:** `witness-registry-error-reasons`
**Date:** `2026-11-06`
**Author:** `Echo`
**Second-pass reviewer:** `not required`
**Tier:** 1 (small, reversible; a revert fully undoes it; no gate, no authority over any agent). Size: 2 source files, 1 test file, README, docs; about 20 source LOC. Effort: 0 spec rounds (Tier 1, ELI16 + this artifact).

## Summary of the change

`packages/witness` (the standalone `instar-witness` CLI, not Instar server code). `publish` printed the registry's `reason` only for a 422. Other statuses went to the shared `unexpected()` helper, which printed the first 300 characters of the raw body. A new `registryErrorReason()` in `registry.ts` reads `reason` or `error.message` from the parsed body, and `unexpected()` prints that when present, falling back to the same raw-text output otherwise. Closes #2354.

## Decision-point inventory

No decision point. The change only alters the text of an error message that was already being printed; every path that failed before still fails, with the same exit code.

---

## 1. Over-block

No issue identified. Nothing is newly refused.

---

## 2. Under-block

- A body with neither a `reason` nor an `error.message` string still prints truncated raw text, by design. The issue names these two shapes, and a third would be a guess.
- The registry's text is printed as sent, including any control characters. The raw-text path and the 422 path already do this, so this is not new exposure.
- A returned reason is not capped at 300 characters, matching the 422 path. It is bounded by the existing 4 MiB response cap. Truncating it would recreate the reported complaint.

---

## 3. Level-of-abstraction fit

Right layer. Parsing the registry's response shape belongs beside the rest of the client in `registry.ts`, and formatting belongs in the CLI's one helper. Fixing the helper rather than `publish` alone means `lookup`, `get` and `stats` get the same message, since all four share it.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over any agent.

The server's text is displayed, never acted on. Whether a command succeeded is still decided by the status and the locally computed hash.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new heuristic at a competing-signals decision point.

---

## 5. Interactions

- **Shadowing:** the 422 path runs first and is unchanged, including its wording.
- **Success path:** a 200/201 whose body is not `ok: true` with a `recordHash` still fails through `unexpected()`; if that body has a `reason`, it is now what gets printed.
- **Double-fire / races:** none; each command is one request.

---

## 6. External surfaces

- Other agents: output text changes for anyone reading `witness` error messages. `registry answered <status> to <command>: ` is preserved; only the text after it changes. A script matching raw JSON in that message would notice. Nothing in this repo does.
- Install base: Instar agents are unaffected; nothing in `src/` imports the package.
- External systems: merging triggers `publish-witness.yml`, which patch-bumps and publishes `instar-witness` to npm. No request sent to the registry changes.
- Operator surface: none.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** A stateless message format in a user-run CLI: no durable state, notices, URLs or topic-bound data.

---

## 8. Rollback cost

Revert the PR, which publishes a new patch of the package. No data, migration or agent state is involved.

---

## Conclusion

A message-only change with unchanged exit codes and raw text kept as the fallback. Clear to ship.

---

## Second-pass review (if required)

Not required: no messaging, session-lifecycle, gate, sentinel, guard or watchdog surface.
