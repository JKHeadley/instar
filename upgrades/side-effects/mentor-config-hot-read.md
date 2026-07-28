# Side-Effects Review — Mentor config hot-read

**Version / slug:** `mentor-config-hot-read`
**Date:** `2026-05-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `instar-codey second-pass checklist`

## Summary of the change

This change makes the mentor runner read the mentor block from the agent config
file each time it needs configuration. The startup mentor config is retained as
the fallback for missing, unreadable, or malformed config reads. This lets
operators adjust the mentor curriculum and runtime settings without restarting
the server while keeping mentor ticks defensive.

## Decision-point inventory

- `readMentorConfigFromDisk` — add — reads and merges the current on-disk mentor
  block with defaults, or returns the startup fallback on unsafe reads.
- `AgentServer.buildMentorRunner` — modify — passes a fresh-reading getConfig
  closure to the mentor runner instead of closing over startup config.
- Mentor route and e2e tests — modify — pin route-level and server-level hot-read
  behavior.

---

## 1. Over-block

A malformed mentor block now falls back to the startup snapshot rather than
partially applying valid fields around the malformed value. That is intentional:
the config edit is not trustworthy enough to merge safely, and keeping the last
known startup behavior is less surprising than accepting a half-bad shape.

## 2. Under-block

The helper performs only shallow shape validation, matching the previous runtime
behavior that trusted the loaded config shape. Invalid field values inside an
object can still flow through. This PR does not add schema validation because the
request was scoped to hot-reading and defensive read failures, not changing the
mentor config contract.

## 3. Level-of-abstraction fit

The hot-read belongs at the `AgentServer` runner boundary, where the server
already wires state directory access into the mentor runner. The runner remains a
pure dependency-injected orchestrator and still receives a simple getConfig
function.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [x] Not applicable to conversational/product judgment — this is runtime config
  loading for a dormant/off-by-default mentor job.

## 5. Interactions

- **Shadowing:** The helper reads only the mentor block and does not mutate the
  main server config object.
- **Double-fire:** No new timers or routes are introduced; existing mentor status
  and tick calls simply observe fresher config.
- **Races:** A config write racing with a mentor tick can produce a transient
  parse failure. The fallback path handles that by using the startup snapshot.
- **Feedback loops:** Live mentor delivery can now observe changed topic or
  curriculum settings without restart. Outstanding-prompt safeguards remain
  unchanged.

## 6. External surfaces

Operators can update mentor settings while the server is running. A bad edit no
longer risks throwing through a mentor tick. No public API shape changes, data
migrations, Telegram topic creation, or dashboard changes are introduced.

## 7. Rollback cost

Rollback is a code and test revert. No persisted data is migrated or rewritten.

## Conclusion

The change addresses the stale mentor config cache directly and keeps the mentor
loop defensive under malformed runtime config edits. Unit, integration, and e2e
tests cover the hot-read and fallback behavior.

---

## Second-pass review (if required)

**Reviewer:** instar-codey second-pass checklist
**Independent read of the artifact:** concur

The second pass agrees that the helper is scoped to mentor config only, preserves
the runner abstraction, and does not introduce new authority or delivery paths.

---

## Evidence pointers

- `tests/unit/AgentServer-mentor-config-hot-read.test.ts`
- `tests/integration/mentor-routes.test.ts`
- `tests/e2e/mentor-onboarding-lifecycle.test.ts`
