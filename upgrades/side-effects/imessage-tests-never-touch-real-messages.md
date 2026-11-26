# Side-Effects Review — iMessage tests never touch the real Messages database

**Version / slug:** `imessage-tests-never-touch-real-messages`
**Date:** `2026-11-20`
**Author:** `echo (instar-dev agent), topic 146369`
**Second-pass reviewer:** `not required` (no messaging block/allow decision, no session lifecycle, no gate/sentinel/guard/watchdog authority touched)

## Summary of the change

**Tier 1** (small, reversible). Size: 2 files, ~+45/-2 LOC in `src/messaging/imessage/IMessageAdapter.ts` and `tests/unit/imessage-adapter.test.ts`. Effort: 0 spec-review rounds (Tier 1, ELI16 + this artifact), 1 commit attempt expected. `IMessageAdapter.ensureChatDbHardlink(stateDir)` hard-linked the REAL `~/Library/Messages/chat.db` into the agent's state dir whenever `config.dbPath` was unset — including under the test runner. On the Studio (2026-11-20 from ~12:46 PST) macOS parked that `link()` syscall waiting on a Full Disk Access (TCC `kTCCServiceSystemPolicyAllFiles`) approval that nobody at an unattended machine answers; the vitest worker sat in an uninterruptible kernel wait, the unit lane never exited, and every PR verify died at the 40-minute deadline. Fix: the helper takes `messagesDir` as a parameter whose default is `defaultMessagesDir(stateDir)` — the real folder in production, a never-created stand-in inside `stateDir` when `process.env.VITEST` is set. Four unit tests pin the behaviour. Diagnosed live by `sample` + `lldb -p` on the stuck workers (the `link()` source register held the real chat.db path) and the kernel log.

## Decision-point inventory

No agent-behaviour decision point is touched. The only branch added is `defaultMessagesDir`: `process.env.VITEST` set → stand-in directory under `stateDir`; otherwise → `~/Library/Messages`. It selects a filesystem path for a startup side effect; it does not gate information flow, block actions, filter messages, or constrain what the agent may do.

- `IMessageAdapter.defaultMessagesDir` — add — environment-keyed default source directory for the chat.db hard link.
- `IMessageAdapter.ensureChatDbHardlink` — modify — gains an optional `messagesDir` parameter; production call site unchanged.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The one input shape affected: a test that *intends* to exercise the real Messages folder with no explicit `dbPath` now gets the stand-in instead. No such test exists (grep of `tests/` for `Library/Messages` and `ensureChatDbHardlink` returned nothing), and a test that wants the real folder can pass it explicitly.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Residual gap worth naming honestly: this fix closes the *adapter's* reach into `~/Library/Messages`. Any **other** production code path that defaults to a TCC-protected folder (`~/Library/Messages`, `~/Documents`, `~/Desktop`, `~/Downloads`, iCloud Drive) and is constructed under test without an override would hang the same way on a machine whose TCC state answers with an approval wait. `NativeBackend` hard-links attachments from the real Attachments folder, but only after it has successfully opened a chat.db — which under test is now never the real one, so that path is not reached. A global test-setup guard that makes any test-time `link/open` under a TCC-protected prefix fail fast is a stronger structural answer; it is filed as a separate improvement (see Conclusion), not bundled here, because patching `fs` for all ~3,900 test files is a wider blast radius than this hang warrants tonight.

---

## 3. Level-of-abstraction fit

Right layer. The adapter is the only place that *decides which Messages folder to link from*; making that decision a parameter with an environment-aware default is the smallest change at the point of origin. Alternatives considered and rejected: (a) adding `dbPath` to every one of ~37 test constructions — fixes symptoms, leaves the next new test exposed; (b) raising the Local Verify lane deadline — a symptom-level fix that makes a never-returning syscall take longer to be killed; (c) a `vi.mock` of `os.homedir` in each test — same per-test fragility as (a). The `VITEST` env check is the same mechanism the codebase already uses for test-only behaviour (`PostUpdateMigrator.ts`, `TrustRaiseGuard.ts`).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It neither produces a signal nor holds authority over agent behaviour. It changes which filesystem path a startup helper reads from under the test runner.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The `VITEST` branch is an enumerable invariant ("tests must not read the operator's private Messages data"), not a judgment between live competing signals.

---

## 5. Interactions

- **Shadowing:** none. No other code reads or writes `stateDir/imessage/test-runner-no-real-messages`; the name is unique and the directory is never created.
- **Double-fire:** none. The helper runs once per adapter construction, exactly as before.
- **Races:** none new. The helper already handled a pre-existing link (same-inode skip / stale-inode recreate); those branches are untouched and now covered by the explicit-fake test.
- **Feedback loops:** none. Local Verify's progress reporter and lane deadline are unchanged; they simply stop observing the hang.
- **Existing suites re-run against the change:** `imessage-adapter` (43), `identity-piece1eb-imessage-sms`, `imessage-connected-at` (53 unit total), `imessage-outbound-safety` (56), `imessage-review-blockers` (26), `imessage-routes` (17), `imessage-adapter-e2e` (14): all pass.

---

## 6. External surfaces

- Other agents on the same machine: none. Production default and call site unchanged.
- Other users of the install base: none in production. Their test runs (if they run instar's suite) stop touching their private Messages folder — a privacy improvement, not a behaviour change.
- External systems: none.
- Persistent state: none. Under test the stand-in directory is never created; in production the same `stateDir/imessage/chat.db*` links are made as before.
- Timing / runtime conditions: the fix *removes* a dependency on an uncontrolled runtime condition (a machine's TCC approval state).
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The chat.db hard link is to a file that exists only on the Mac whose Messages.app owns it; the link and the stand-in path are per-machine truths and must not replicate. The feature emits no user-facing notices, holds no durable state beyond the pre-existing per-machine link files, and generates no URLs. **Status surfaces:** none new or changed.

Cross-machine observation that motivated the fix: the same test suite hung on the Studio and passed on the M5 because their TCC approval states differ. After this change the outcome no longer depends on either machine's privacy settings.

---

## 8. Rollback cost

- **Hot-fix release:** pure code change — revert and ship a patch. The old behaviour (and the Studio hang) returns immediately.
- **Data migration:** none. No persisted state is introduced; the stand-in directory is never created.
- **Agent state repair:** none.
- **User visibility:** none during a rollback window; production behaviour is identical on both sides of the change.

---

## Conclusion

The review confirmed the change is a minimal, point-of-origin fix with no agent-behaviour decision surface and no production behaviour change; the production default is byte-identical and every production caller is untouched. Evidence of the root cause is first-hand (stuck-worker register read + kernel TCC log + suite reproduction), not inferred from the misleading "still running" file names in the lane's throttled progress file. One item is deliberately *not* bundled and is tracked separately: a global test-setup guard that makes any test-time filesystem reach into a macOS TCC-protected prefix fail fast with a named culprit instead of parking in the kernel, so the next such defect surfaces in seconds rather than as a 40-minute deadline. <!-- tracked: topic 146369 follow-through, filed via /feedback as an instar improvement after this PR merges --> Clear to ship.

---

## Second-pass review (if required)

Not required — the change touches no outbound/inbound messaging block/allow decision, no session lifecycle, no compaction/respawn path, no coherence/idempotency/trust check, and nothing named sentinel, guard, gate or watchdog.

---

## Evidence pointers

- Live diagnosis (Studio, 2026-11-20 16:23–16:37 PST): `sample <pid>` of stuck workers 37651/54663/90382/8247 → main thread in `node::fs::Link → uv_fs_link → link()`; `lldb -p 37651` / `-p 54663` frame-0 register `x2` = `/Users/<operator>/Library/Messages/chat.db`; `/usr/bin/log show` → `kernel: (Sandbox) watchdog expired for approval entry N (kTCCServiceSystemPolicyAllFiles, pid 37651|54663|90382|8247)` every 5 s; `unit.progress.json` reported `finishedFiles: 3925, running: []` while the lane could not exit.
- Negative control: `tests/unit/job-scripts/release-readiness-check.test.ts` (named "still running" in two earlier cut-offs) passes alone in 2.7 s on the Studio — the progress file's names were throttle artefacts, not the cause.
- Before/after proof (a tracer that wraps `fs.linkSync`/`fs.existsSync` and counts calls whose path is under the real `~/Library/Messages`, then constructs an adapter with no `dbPath`): old code with `VITEST` set → `realLinkAttempts: 3, realExistsChecks: 4`; new code with `VITEST` set → `0 / 0`; new code with `VITEST` unset (production) → `3 / 4`, identical to the old code.
- Fix verification: `npx vitest run tests/unit/imessage-adapter.test.ts …` 53/53; integration iMessage suites 99/99; `tests/e2e/imessage-adapter-e2e.test.ts` 14/14; `tsc --noEmit` clean; eslint clean on both changed files.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is in TypeScript source (a production default reachable from tests), not in an LLM prompt, hook, config, skill, or standards text, and the change adds no self-triggered controller.
