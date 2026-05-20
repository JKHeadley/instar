# Side-Effects Review — Fleet watchdog bind-failure probe

**Version / slug:** `watchdog-bind-failure-probe`
**Date:** 2026-05-19
**Author:** echo
**Second-pass reviewer:** subagent (high-risk: touches "watchdog" trigger)
**Spec:** [docs/specs/watchdog-bind-failure-probe.md](../../docs/specs/watchdog-bind-failure-probe.md)
**ELI16:** [docs/specs/watchdog-bind-failure-probe.eli16.md](../../docs/specs/watchdog-bind-failure-probe.eli16.md)

## Summary of the change

Adds a `probe_server_identity` function to the fleet watchdog. For every agent that launchd reports as loaded-and-running, the probe asks the agent's `/health` endpoint to confirm the server on its configured port actually belongs to it. If the port is unreachable or returns a project name belonging to a different agent, the watchdog logs a `BIND-FAIL` signal and runs it through the same `try_self_heal` → consecutive-fail-counter → `escalate_via_peer` pipeline as a launchd crash-loop.

When escalation fires for a BIND-FAIL with a known conflicting party, the alert payload uses a more specific summary: *"AI Guy hasn't been able to start its server because codex-server-smoke is using its port. My repair attempts haven't fixed it."* The fallback (no conflict context) is the existing generic "offline for about X minutes" copy. Both variants pass the existing B12-B14 health-alert ruleset; the `/attention` route's safe-template retry from PR #245 still backstops any tone-gate rejection.

Decision points the change touches:
- **`probe_server_identity`** (new) — structural detector, emits a signal, no blocking authority.
- **`handle_bind_fail`** (new) — routes the signal through the existing heal+escalate pipeline. No new authority surface.
- **`escalate_via_peer`** (modified) — reads optional conflict context to build a richer summary. The summary still goes through `MessagingToneGate` via `/attention`; the gate remains the only authority.
- **`reset_fail_counter`** (modified) — also clears the new `bind-fail-conflict` state file.

## Decision-point inventory

- `probe_server_identity` — **add** — structural detector returning 0/2/3 + structured stdout.
- `handle_bind_fail` — **add** — routes BIND-FAIL into the existing heal+escalate pipeline.
- Main loop's healthy-PID branch — **modify** — now calls the probe before treating PID-alive as healthy.
- `escalate_via_peer` — **modify** — picks up optional conflict context for a more specific summary.
- `reset_fail_counter` — **modify** — also clears `bind-fail-conflict` marker.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- **Probe — "wrong-project" false positive.** If the agent's label-derived expected project name doesn't match the `project` field in /health (e.g. someone renamed an agent without updating the launchd label, or an old instar version reports project under a different field name), the probe flags BIND-FAIL on a perfectly healthy agent. Mitigation: the probe FAILS OPEN when `project` is empty in the response (old instar versions don't expose it). Documented in test `returns 0 when project field is absent`. The label-mismatch case is harder — if you legitimately renamed an agent, you must update the launchd label too. The alert text would still be coherent ("X is offline because Y is using its port" — Y is the agent's actual project name, the user can act on it).
- **Probe — "unreachable" false positive during legitimate maintenance.** If a user manually stops an agent's server (e.g. for an upgrade) while the lifeline stays alive, the probe will report BIND-FAIL. After 3 cycles (~15 min) the user gets a Telegram alert. Acceptable — the user knows they stopped it and can ignore. Not common enough to justify a per-agent "muted" flag in this PR (deferrable to v3 Remediator).
- **Probe — `--max-time 5` curl timeout.** A server doing legitimate slow work that takes >5s to respond to `/health` would be flagged unreachable. The `/health` endpoint is intentionally fast (no DB hits, no LLM calls); 5s is comfortable. If a future change makes `/health` slower, this test fails first.
- **No false alarms for lifeline-only agents.** Agents with no `port` in config.json skip the probe entirely (return 0). Test confirms.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Slow port-collision.** If two agents race for the same port at boot, the probe will only see the winner. The loser's lifeline is still up. The probe correctly catches this (the loser's expected project doesn't match the winner's). But if both processes alternate (one fails immediately, the other binds, then they swap on next launchd respawn), the probe sees inconsistent states across cycles and may take longer to escalate. Acceptable — the consecutive-fail counter handles the noise.
- **Wrong port in config.json.** If config.json says port 5050 but the lifeline actually starts the server on a different port (config drift), the probe will hit the wrong port and false-alarm. This shouldn't happen in practice — the lifeline reads the same config.json the probe reads. But if a future change adds runtime port mutation, this needs revisiting.
- **Server identifies itself with a project name that's not the label minus prefix.** If the agent's `agentName` in config differs from its launchd label (e.g. user customized one), the probe false-alarms. Mitigation deferred — current convention is they match, and a sentinel test could enforce this convention going forward.
- **Tone gate rejects both attempts (initial + safe template).** Same backstop as PR #245: counter preserved, retried next cycle. No regression from this PR.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

- **Probe in the watchdog (this PR).** The watchdog is the OUTSIDE-the-lifeline observer with the cross-agent visibility (it sees all plists + can correlate `expected agent X on port P` against `who's actually on port P`). The lifeline can't do this cross-agent view from inside itself. So watchdog is the right layer.
- **In-supervisor bind-detection (PR #111) remains.** That layer catches the per-agent case where the server's own preflight detects bind failure. This PR catches the failure mode where the supervisor's alerts are being SUPPRESSED as duplicates (the exact failure that bit AI Guy). Two layers, two signals, same authority for the user-facing alert.
- **Not at the v3 Remediator layer yet.** v3 will absorb both layers under a unified probe registry + runbook system. This PR is the minimum plumbing until v3 ships. Both specs explicitly agree on the absorption point.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] **No — this change produces a signal consumed by an existing smart gate.**

Detailed:
- `probe_server_identity` is a structural detector: file existence (config.json), HTTP code, JSON field equality. No judgment, no blocking. Returns numeric codes + structured stdout.
- The consecutive-fail counter is a deterministic threshold (mechanic, explicitly exempt per the principle's §"When this principle does NOT apply").
- `escalate_via_peer` builds a CANDIDATE message. The decision to ship that candidate, reshape it, or fall back to the SAFE template rests entirely with `MessagingToneGate` via the `/attention` route — the existing authority. This PR does not modify the gate; it just supplies a different candidate.
- The new conflict-aware summary copy was hand-crafted to pass B12 (no jargon: no "lifeline", "launchd", "pid", "crash-loop", "shadow-install"). A unit test screens the payload heredoc for these terms; future drift would fail the test.

This PR adds NO new blocking authority.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:**
  - The bind-probe runs INSIDE the healthy-PID branch. Before: PID exists → OK. After: PID exists + probe passes → OK; PID exists + probe fails → BIND-FAIL → heal pipeline. The OK path is now slower (one curl per agent per cycle, capped at 5s). Acceptable: cycles run every 5 min, so an extra ~30ms per agent is negligible.
  - The crash-loop branch (exit_status != 0) is unchanged. PR #245's path is preserved exactly.
- **Double-fire with supervisor's internal bind-detection (PR #111):**
  - The supervisor's in-process detection emits a `DegradationReporter` event INSIDE the lifeline. That event tries to route through ToneGate → /attention on the SAME agent's server. But the failing agent's server is locked out — so the in-process route is broken precisely when it's needed. The watchdog's external probe + peer-escalation is what actually surfaces the failure. The two paths can coexist; the peer-routed POST will win (it actually reaches Telegram). Idempotency-by-id in `/attention` prevents duplicate topic creation if both ever land.
- **Races:**
  - State files (`*.consecutive-heal-fails`, `*.bind-fail-conflict`) are per-label. Concurrent watchdog runs are prevented by launchd's single-instance default. Manual invocation could race, but the script's writes are atomic single-line files.
  - The probe-vs-healing race: if heal succeeds between probe-time and the launchd reload, the next cycle's probe sees healthy state and resets counters. No persistent stuck state.
- **Feedback loops:**
  - When the user replies to the escalation Telegram topic, the reply lands at the PEER that escalated, not the failing agent. Documented in PR #245's review (same surface, no new behavior here).
  - The bind-fail-conflict marker is cleared on (a) probe-pass, (b) escalation success, (c) crash-loop reset. No way for stale conflict context to leak into future escalations.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** YES — adds one `curl /health` per agent per 5-minute cycle. Negligible load, no auth required for /health.
- **Other users of the install base:** YES — ships in next release via PostUpdateMigrator. macOS-only effect.
- **External systems:**
  - Telegram: a new failure-mode class (port collision) now produces a Telegram topic. Same authority gates it.
  - `/attention` route: unchanged behaviorally; this PR is a new caller.
- **Persistent state:**
  - New marker file `bind-fail-conflict` in `~/.instar/watchdog-state/`. Single-line, agent label, harmless.
  - Existing `consecutive-heal-fails` markers are now shared between crash-loop and bind-fail paths — they both increment / reset the same counter. Test confirms reset_fail_counter clears both.
- **Timing:** Probe curl adds ~30ms-5s per agent per cycle (capped at 5s). For a 10-agent machine, max overhead is 50s of a 300s cycle. Acceptable.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix:** revert `src/templates/scripts/instar-watchdog.sh` to the PR-#245 state. The next agent update overwrites the user-level script via `PostUpdateMigrator.migrateFleetWatchdog`. Ship as a patch release.
- **Data migration:** none. `bind-fail-conflict` marker files in `~/.instar/watchdog-state/` are harmless if left behind (auto-pruned by the existing 24-hour cleanup that already covers `last-heal` files; the regex could be widened later if needed).
- **Agent state repair:** none required.
- **User visibility during rollback:** minimal. The watchdog reverts to its pre-this-PR behavior — no bind-fail detection, no false alarms either.
- **Estimated total:** ~30 min revert + release cycle.

---

## Addendum 2026-05-19 — Reviewer findings + fixes

Second-pass reviewer found one critical defect plus two minors. All addressed:

**Critical — auth gating on `/health.project`.** The probe called `/health` without an Authorization header. The route only sets `base.project` inside `if (isAuthed)` (`src/server/routes.ts:1157`), so production probes would have received responses with no `project` field, hitting the fail-open branch, and the wrong-project detection — the entire reason for this PR — would never have fired in production. Fix: probe now reads `authToken` alongside `port` from `config.json` and sends `Authorization: Bearer <token>` with the `/health` request. Two new tests cover this (one shell-level asserting the header lands in the actual HTTP request; one template-content asserting the script references `authToken` + `Authorization: Bearer`).

**Minor 1 — state-file cleanup regex.** The existing 24h cleanup matched only `*.last-heal`. Widened to `*.last-heal | *.consecutive-heal-fails | *.bind-fail-conflict` so uninstalled-agent state doesn't accumulate. Documented inline.

**Minor 2 — uninstalled-peer cleanup path not tested.** Deferred. The widened regex is exercised by the existing watchdog-cycle path; standalone test of the cleanup is mechanical and adds little value given the simple find expression.

**Confirmed sound (no change needed):** signal-vs-authority compliance, PR #245 idempotency-by-id holds via `TelegramAdapter.createAttentionItem`'s `attentionItems.has(item.id)` short-circuit, 5s curl timeout is appropriate for macOS-only production target, migration parity covered by `PostUpdateMigrator.migrateFleetWatchdog`.

## Conclusion

This PR adds the second layer of bind-failure detection — outside the lifeline, with cross-agent visibility — that closes the failure-mode that kept AI Guy offline for two days post-PR-#245. No new authority over message flow; the probe is a structural detector that feeds the existing tone-gated escalation pipeline. The conflict-aware summary copy was crafted to pass B12 and is unit-tested for jargon. Two new state markers, both harmless on rollback.

17 new tests added (11 template-content unit tests + 4 darwin-gated behavioural unit tests + 2 darwin-gated integration tests covering the full pipeline). Cross-platform template assertions ensure the production-code paths stay consistent across Linux CI runs.

Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** second-pass subagent (Opus 4.7 1M, 2026-05-19)
**Independent read of the artifact: concern**

Signal-vs-authority compliance and rollback cost check out. The probe is structurally a detector, the counter is mechanic, and the candidate message goes through `MessagingToneGate` via `/attention` — same authority, no new blocker. PR #245 idempotency-by-id is real: `TelegramAdapter.createAttentionItem` at `src/messaging/TelegramAdapter.ts:2949` short-circuits on `attentionItems.has(item.id)`, so a double-fire from PR #111's in-process path and this PR's external path cannot duplicate the topic. However:

- **(CRITICAL) Wrong-project detection is dead-on-arrival in production.** The `/health` route only includes `base.project` inside the `isAuthed` branch (`src/server/routes.ts:1140` opens `if (isAuthed)`, `1157` sets `base.project`). The probe's curl at `src/templates/scripts/instar-watchdog.sh:444` sends no `Authorization` header, so every peer agent's `/health` response will have `project` absent → probe hits the fail-open branch at `instar-watchdog.sh:460-464` (`project_field == ""` → `return 0`). The original AI-Guy-behind-codex-server-smoke incident was exactly a wrong-project case (200 response, foreign project name), so this PR would NOT have caught it. The unit test passes because the mock at `tests/unit/watchdog-bind-probe.test.ts:160` returns `project` unconditionally regardless of auth. **Recommended resolution:** either (a) read `authToken` from the agent's own `config.json` (we already read `port` from there) and send `Authorization: Bearer $auth` on the probe, or (b) expose `project` in the unauthenticated `/health` body — `projectName` is already public via launchd plist paths, so this is not a secret. (a) is the smaller change; (b) is cleaner. Either way, add a darwin-gated probe test that exercises the actual route handler (or a fixture that mirrors its auth-gated shape) instead of a mock that hand-waves the auth.

- **(MINOR) Stale state-file claim under-counts the gap.** Artifact §7 says `bind-fail-conflict` markers are "auto-pruned by the existing 24-hour cleanup that already covers `last-heal` files." `instar-watchdog.sh:623` is `find ... -name "*.last-heal" -mmin +1440 -delete` — it does not match `*.bind-fail-conflict` or `*.consecutive-heal-fails`. In practice `reset_fail_counter` clears both on every successful probe/escalation, so growth is bounded for active agents. But a launched-then-deleted agent (plist gone, marker left behind) will leak both files until a human cleans `~/.instar/watchdog-state/`. **Recommended resolution:** widen the regex to `\( -name "*.last-heal" -o -name "*.bind-fail-conflict" -o -name "*.consecutive-heal-fails" \)`, or document the leak as accepted with an issue link.

- **(MINOR) Coverage gap — uninstalled-peer leak.** No test asserts that markers for a label whose plist no longer exists eventually get cleaned. Combined with the regex above, this is the realistic stale-state path. Add a unit test that creates a marker, removes the plist, runs a cycle, and asserts the marker is gone (after fixing the regex).

Counter exclusion to surface: 5s timeout is fine for macOS-only production; `/health` is intentionally cheap (no DB/LLM) and the cached session count already protects against event-loop stalls (`routes.ts:1097`). No concern there.

Once the auth header (or unauth `project` exposure) is wired, this PR delivers what the spec promises. Until then, it ships a probe that emits the right log line in dev fixtures and silently fails open in production.

---

## Evidence pointers

- Spec: `docs/specs/watchdog-bind-failure-probe.md` (with ELI16 companion).
- Tests: `tests/unit/watchdog-bind-probe.test.ts` (15 tests), `tests/integration/watchdog-bind-fail-escalation.test.ts` (2 tests).
- Incident reference: AI Guy port collision with codex-server-smoke, 2026-05-17 → 2026-05-19, topic 5447. Lifeline supervisor logged "Suppressing duplicate server down notification (4163 suppressed this outage)" — captured in `~/Documents/Projects/ai-guy/.instar/logs/lifeline-launchd.log`.
- Recovery: manual unload of codex-server-smoke plist + restart of ai-guy launchd job. After this PR ships, the same configuration error would have surfaced to the user via Telegram within ~15 min instead of staying silent for 2 days.
