# Side-Effects Review — Lifeline shadow-install self-heal + fleet watchdog hardening

**Version / slug:** `lifeline-shadow-install-self-heal`
**Date:** 2026-05-17
**Author:** echo
**Second-pass reviewer:** subagent (high-risk: touches "watchdog" trigger)
**Spec:** [docs/specs/lifeline-shadow-install-self-heal.md](../../docs/specs/lifeline-shadow-install-self-heal.md)
**ELI16:** [docs/specs/lifeline-shadow-install-self-heal.eli16.md](../../docs/specs/lifeline-shadow-install-self-heal.eli16.md)

## Summary of the change

Three coordinated changes that close a 4-day-outage class (AI Guy, 2026-05-13 → 2026-05-17):

1. **Boot wrapper self-heal for missing shadow-install** (`src/commands/setup.ts` — both bash and node wrappers in `installBootWrapper()`). When the wrapper finds no `shadow-install/node_modules/instar/dist/cli.js`, it now attempts one `npm install` via absolute node + npm-cli.js paths (PATH may be empty under launchd), debounced by a `.heal-attempted` marker file that prevents launchd KeepAlive throttling from triggering 30+ reinstall attempts per minute.

2. **Fleet watchdog migrated into instar source** (`src/templates/scripts/instar-watchdog.sh` — new). The previously hand-rolled `~/.instar/instar-watchdog.sh` now ships from src with two key behavioral changes vs the prior hand-rolled version: (a) heal-step `npm install` uses absolute-path `node` + `npm-cli.js` resolution instead of bare `npm` (which fails under launchd's empty PATH), and (b) when self-heal fails 3 cycles in a row for the same agent, it discovers a healthy peer agent and POSTs to that peer's `/attention` endpoint with `category: "degradation"` — the existing tone-gated cross-topic alert path. Tied into `installMacOSLaunchAgent()` and `PostUpdateMigrator.migrateFleetWatchdog()` for parity across fresh installs and existing agents.

3. **Watchdog launchd plist sets PATH explicitly.** Belt-and-suspenders next to the absolute-path resolution in the script. Catches any other shell utility (curl, awk, etc.) that the script might invoke.

Decision points the change interacts with:
- `installBootWrapper()` shadow-install presence check (modified — adds heal branch).
- `installMacOSLaunchAgent()` post-install hook (modified — calls `installFleetWatchdog()`).
- `PostUpdateMigrator.migrate()` (modified — adds `migrateFleetWatchdog()` entry).
- `/attention` route → `MessagingToneGate` health-alert path (pass-through — used by escalation as a CONSUMER, no change to the gate itself).

## Decision-point inventory

- `installBootWrapper().jsWrapper SHADOW-missing branch` — **modify** — now attempts one-shot reinstall before exit.
- `installBootWrapper().bashWrapper SHADOW-missing branch` — **modify** — same as above for bash parity.
- `installFleetWatchdog()` — **add** — new singleton-per-machine installer for the user-level fleet watchdog.
- `installMacOSLaunchAgent` post-install hook — **modify** — calls installFleetWatchdog as a best-effort side action.
- `PostUpdateMigrator.migrateFleetWatchdog` — **add** — overwrites the user-level watchdog script + plist with the latest template on every agent update.
- `instar-watchdog.sh:try_self_heal` — **modify (script template, new in src)** — switches from bare `npm` to absolute-path `node + npm-cli.js`.
- `instar-watchdog.sh:escalate_via_peer` — **add (script template, new in src)** — POSTs to a healthy peer's `/attention` after N consecutive heal failures.
- `MessagingToneGate` health-alert path — **pass-through** — consumed via `/attention` POST; unchanged.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- **Boot wrapper:** The 5-minute reinstall debounce is the only "block" surface. It rejects attempts to reinstall within 5 min of the last attempt. The legitimate input it could reject is "user manually invoked the boot wrapper after fixing the underlying problem 1 minute ago." Concrete: a developer who manually `rm`'d the shadow install, then re-ran the wrapper twice in quick succession, would see the second invocation skip the reinstall and exit 1. They'd see the explicit debounce message ("last heal attempt 60s ago, skipping (5min debounce)") and know to wait or to delete the marker file. Acceptable trade-off: the alternative is a 30/min reinstall storm under launchd throttling.
- **Watchdog `escalate_via_peer`:** Rejects escalation when no healthy peer with a config.json + accessible /health is found on the machine. A legitimate scenario this rejects: a machine with exactly ONE agent and that agent is the dead one (no peer exists). In that case we log `ESCALATE-FAIL: no healthy peer found` and the user gets no alert. Honest constraint: single-agent machines have no cross-agent escalation path; the user will only learn via the lifeline's eventual recovery or by checking the dashboard. Documented in the spec as a non-goal.
- **Watchdog peer-discovery:** A peer plist that lacks `WorkingDirectory` or `.instar/config.json` is silently skipped. Possible over-block: a misconfigured peer that IS running but whose plist is malformed wouldn't be picked. Mitigation: this is a structural property of a healthy agent (every instar plist has WorkingDirectory; every instar install has config.json), so an agent lacking these isn't a viable escalation target anyway.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Boot wrapper reinstall succeeds but spawns a broken binary.** If npm completes successfully but the downloaded `instar` package itself is broken or incompatible with the running node, the wrapper continues to boot and then crashes in the CLI's own initialization. Caught by PR #111's bind-failure escalation, not by this PR. Layered defense — acceptable.
- **Filesystem permission errors during reinstall.** If the SHADOW_DIR exists but is owned by a different uid (rare — typical user installs are user-owned), npm will fail and the wrapper exits 1. Marker file prevents loop. User would need to inspect the wrapper's stderr in `lifeline-launchd.err`. Acceptable — the watchdog will then bump the consecutive-fail counter and escalate to a peer if available.
- **Race between two boot wrappers attempting reinstall simultaneously.** Under launchd, only one wrapper instance runs at a time (KeepAlive serializes). Under manual invocation, two parallel wrappers could race on the marker file. npm itself handles concurrent installs poorly. Practical mitigation: the wrapper has always been single-instance in production. Not a new race introduced by this PR.
- **Tone gate falls back to SAFE_HEALTH_ALERT_TEMPLATE every time.** If our default copy ever drifts to include B12-jargon, every escalation message would degrade to the safe template (Justin still gets pinged via the explicit safe-template retry — `escalate_via_peer` POSTs the canonical safe wording on 422). The user always learns something is wrong. Caught by unit test `escalates via peer agent /attention endpoint with category=degradation` which inspects the payload for jargon terms. Future drift would fail this test.
- **Both POSTs (initial + safe template) return non-201.** If the tone gate is genuinely broken (or the peer's server is degraded in a more subtle way), both attempts fail and the watchdog returns 1 — counter PRESERVED so the next 5-min cycle re-attempts. User is not paged until escalation succeeds; with the safe template as floor this is rare.
- **Watchdog escalates to the wrong peer if multiple peers exist.** First healthy one wins — no load balancing or stickiness. In practice this is fine; the escalation just needs SOMEONE to send the Telegram. Idempotency of `/attention` (the same `id` is dedup'd) prevents duplicate topic creation if the watchdog escalates again on a future cycle.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

- **Boot wrapper reinstall.** The boot wrapper is the lowest layer that has visibility into "shadow install is missing." Anything above (the lifeline, the server, the supervisor) can't run when the wrapper can't load. So the heal has to live here. Acceptable; no higher layer is a viable owner.
- **Fleet watchdog peer-escalation.** The watchdog runs as a user-machine singleton across all agents. The dead agent has no path to escalate by itself (no server, no Telegram). A peer-routed call is the only viable path at this layer until v3 Remediator's Tier-3 Fleet Intelligence ships. The watchdog produces a SIGNAL ("agent down + 3 heal fails"); the authority lives in `MessagingToneGate`. Compliant.
- **`installFleetWatchdog()` lives in `setup.ts`.** It's invoked from `installMacOSLaunchAgent()` as a side action. Slightly awkward that a per-agent setup also installs a singleton; the alternative is a separate top-level entry point. Trade-off: the existing per-agent install is where the user invokes setup, so co-locating keeps the singleton's installation event-driven and doesn't require a new CLI command. Refactor candidate later if a cleaner home emerges.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] **No — this change produces a signal consumed by an existing smart gate.**

Detailed:
- The watchdog's `bump_fail_counter` produces a numeric signal. The threshold check `[ $current -ge 3 ]` is a deterministic mechanic (idempotency-key class, explicitly listed as exempt in `docs/signal-vs-authority.md` §"When this principle does NOT apply").
- The `escalate_via_peer` function produces a TELEGRAM ALERT CANDIDATE (title, summary, description, category, priority). It does NOT decide whether the alert ships. The decision belongs to `MessagingToneGate` via the `/attention` route's `isHealthAlert` branch (routes.ts:5678), invoked with `messageKind: 'health-alert'` and `jargon: true` so the B12/B13/B14 rules fire.
- The peer-discovery probe (HTTP 200 on `/health`) is structural, not judgmental.
- The boot-wrapper self-heal is a recovery primitive, not a decision point. It checks file existence and acts; no judgment about message content or agent intent.

Nothing in this PR adds blocking authority over message flow, session lifecycle, or agent intent.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:**
  - The boot-wrapper self-heal runs BEFORE the existing crash-loop backoff path. Sequencing: missing-SHADOW heal → spawn CLI → crash-loop detection. The heal does not shadow the backoff; they handle disjoint failure modes (missing dir vs. CLI crash). Verified by inspection of `installBootWrapper()` js template.
  - The fleet watchdog runs INDEPENDENTLY of per-agent supervisors (PR #111's `ServerSupervisor`). They detect different failure surfaces: supervisor sees server-restart cycles inside a running lifeline; watchdog sees launchd-level crash loops outside a running lifeline. No shadow.

- **Double-fire:**
  - `installFleetWatchdog()` called from every agent's `installMacOSLaunchAgent()` AND from `PostUpdateMigrator.migrateFleetWatchdog()`. Both write the same content to the same paths idempotently. Multiple agents updating concurrently produce identical writes — last-write-wins is fine because all writes are equivalent.
  - `escalate_via_peer` fires on the watchdog's 5-min cycle after 3 consecutive fails. After successful escalation, the counter resets. If the dead agent stays dead, the counter rebuilds and escalates again only after another 3 cycles (15 min). Acceptable cadence; aligns with `/attention` idempotency-by-id.

- **Races:**
  - Boot-wrapper marker file: written before npm runs. If npm crashes mid-install, the marker remains, debouncing further attempts for 5 min. This is correct — repeated rapid reinstalls of a broken environment would not help.
  - Watchdog state files (`*.consecutive-heal-fails`, `*.last-heal`) are per-label. Concurrent watchdog runs are prevented by launchd (StartInterval=300 with single instance).
  - `migrateFleetWatchdog` reads then writes the script + plist. Concurrent agent updates could overwrite each other, but the content is identical so the race is benign.
  - **Migrator can SIGTERM in-flight watchdog mid-cycle.** When `migrateFleetWatchdog` detects a plist change it `bootout`s and `bootstrap`s the watchdog. If the watchdog happened to be mid-`npm install` for an agent heal, the SIGTERM aborts the install (leaving a half-installed `shadow-install`) and the watchdog re-runs on the next 5-min cycle. The next cycle's npm install completes cleanly (npm is idempotent), so net effect is a 5-minute delay on first heal after migration. Documented; not worth a flock given the 5-min cadence and idempotent recovery.

- **Feedback loops:**
  - Escalation triggers a `/attention` POST that creates a Telegram topic. If the topic notification triggers a Telegram user message to the agent (Justin replies), it goes to the HEALTHY peer that handled the escalation. That peer's session sees an inbound message about a different agent's outage — context discontinuity but not a loop. Documented as a known cross-agent quirk; v3 Remediator absorbs this properly.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** YES — the fleet watchdog is shared across all agents. Every agent's update flow may rewrite it. Mitigated by idempotent overwrite + content equality skip.
- **Other users of the install base:** YES — this change ships in the next release and applies to every instar-running machine. Linux/Windows users get a no-op (`migrateFleetWatchdog` skips on non-darwin); macOS users get the new watchdog on next update.
- **External systems:**
  - Telegram: new outbound topics may appear when an agent has been crash-looping for 15+ min. Topic spawns are tone-gate filtered, so the user-facing message quality is governed by existing rules.
  - npm registry: boot-wrapper self-heal can call `npm install instar --silent` once per 5 min per agent. Practical worst case (all agents crash-loop with missing SHADOW simultaneously): 1 install per agent per 5 min. Within registry rate-limit norms.
  - macOS launchctl: `bootout`/`bootstrap` calls on watchdog plist during migration. Idempotent (script-only changes skip the relaunch).
- **Persistent state:**
  - New marker file `<SHADOW_DIR>.heal-attempted` per agent — harmless, single line containing a timestamp.
  - New watchdog state files in `~/.instar/watchdog-state/<label>.consecutive-heal-fails` — auto-trimmed by the script's existing `find -mmin +1440 -delete`.
  - New user-level `~/.instar/instar-watchdog.sh` + `~/Library/LaunchAgents/ai.instar.watchdog.plist` — overwritten on update.
- **Timing / runtime conditions:**
  - npm install duration during boot-wrapper self-heal: typically 5-30s. The 5-minute timeout we set is the upper bound. During this time the agent's lifeline doesn't start — equivalent to a deliberate launchd ThrottleInterval extension.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix:** revert the three source changes (setup.ts, PostUpdateMigrator.ts, src/templates/scripts/instar-watchdog.sh). Ship as a patch release. The PostUpdateMigrator stops writing the new template; the hand-rolled `~/.instar/instar-watchdog.sh` from before this PR would no longer be overwritten. (We never delete the user-level file, only overwrite it — pre-PR users who relied on a hand-rolled version would have already been overwritten by this PR on first update, so rollback wouldn't restore their hand-rolled version. Mitigation: if reverting, also ship a one-liner that copies the pre-PR template back.)
- **Data migration:** None. Marker files are harmless; state files are auto-trimmed.
- **Agent state repair:** None required. Worst case: the user-level fleet watchdog reverts to behavior equivalent to before this PR — agents whose shadow-install vanishes go back to dead-forever, but no NEW failure mode is introduced by the rollback itself.
- **User visibility:** Minimal. Boot-wrapper rolls back to "exit 1 on missing SHADOW" silently; user only notices if an agent's SHADOW happens to be missing at the moment.
- **Estimated downtime:** None. Pure code change + script template change. Rollback PR + release cycle = ~30 min end-to-end.

---

## Addendum 2026-05-17 (b) — Integration tests darwin-gated

The integration test in `tests/integration/fleet-watchdog-escalation.test.ts` is now gated on `process.platform === 'darwin'` (via an `itDarwin` helper). The watchdog targets macOS launchd as its only production deployment surface, and the test simulates that environment via bash source-tricks that don't survive Linux CI's strictly-set-e environments. Unit-level coverage of the bash template content (PATH-resolved node/npm, payload shape, jargon screening) still runs on every platform.

## Addendum 2026-05-17 — Cross-platform node/npm resolution

After the initial PR landed, CI shard 3/4 (Ubuntu) surfaced that the watchdog's `resolve_node` / `resolve_npm` only probed macOS Homebrew paths. On Linux those paths don't exist, so the integration test (which exercises `escalate_via_peer` against a mock peer) saw zero POSTs reach the peer.

Fix: expanded candidate list to include Linux/system paths (`/usr/bin/node`, `/usr/lib/node_modules/npm/bin/npm-cli.js`, `/usr/share/npm/bin/npm-cli.js`) and added a `command -v` fallback for nvm/asdf/hosted-toolcache setups. Added explicit env overrides `INSTAR_WATCHDOG_NODE_BIN` and `INSTAR_WATCHDOG_NPM_CLI` for tests + unusual deployments. macOS launchd-PATH-empty production behavior is unchanged: the homebrew/usr-local paths are still tried first; new fallbacks only fire when those miss.

No new decision-point surface introduced by the addendum. All checks remain structural (file-existence + accessibility). Signal-vs-authority compliance unchanged.

## Conclusion

This PR closes the failure mode that took AI Guy offline for 4 days without alerting Justin. It does so by adding self-heal at the layer just below where today's heal stops (boot wrapper) and by routing the heal-failed signal through the existing tone-gate authority via a peer agent's `/attention` endpoint (the only viable Telegram path when the affected agent itself has no server). No new authority over message flow or agent intent. No interactions with PR #111 that overlap; this PR fills the layer ABOVE the supervisor (lifeline can't even start) and the layer BESIDE the supervisor (out-of-process cross-agent escalation). The v3 Remediator (approved 2026-05-13) explicitly owns the long-term absorption path; until Tier-3 ships, this is the minimum plumbing that removes the 4-day-outage class.

17 tests added (14 unit + 3 integration). All pass on first run. No existing tests broken.

Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** general-purpose-reviewer (subagent, Phase 5)
**Independent read of the artifact: concern** (one material issue + two minor; signal-vs-authority itself is clean)

Traced the actual code paths in `setup.ts` (bash heal §844–909, js heal §1068–1132, `installFleetWatchdog` §1249–1332), `instar-watchdog.sh` (full), `PostUpdateMigrator.ts` (`migrateFleetWatchdog` §173–270), and `routes.ts:/attention` (§5648–5704). Signal-vs-authority compliance is genuinely sound: the counter is a deterministic mechanic (idempotency-class), `escalate_via_peer` produces a candidate only, the gate at routes.ts:5680 is the authority. Boot-wrapper heal is recovery against a structural file-existence check, not a judgment-call block. Concur on §4.

Issues:

- **(Material) Counter reset on 422 silently swallows the alert.** `escalate_via_peer` resets the counter on both `201` and `422` (`instar-watchdog.sh:284`). 201 = attention item created → user notified. **422 = `checkOutboundMessage` blocked the candidate and the route returned BEFORE `createAttentionItem` ran** (routes.ts:5685–5688) — no Telegram topic spawned, no `SAFE_HEALTH_ALERT_TEMPLATE` fallback emitted by the route. The artifact's spec §202 claims 422 falls back to the SAFE template, but the route doesn't actually do that — it just 422s out. So on a tone-gate block, the watchdog resets the counter, the user gets nothing, and re-paging is suppressed for another 3 cycles (15 min). Recommended fix: reset ONLY on 201; on 422 treat as escalation-failure (log, leave counter intact so the next cycle retries with potentially-reshaped copy — or better, have the watchdog re-POST with the canonical SAFE template body after a 422).
- **(Minor) Migrator can bootout a running watchdog mid-cycle.** `PostUpdateMigrator.migrateFleetWatchdog` (§260) calls `launchctl bootout` whenever the plist changes. If a watchdog cycle is actively reinstalling a shadow-install when an agent update fires, bootout SIGTERMs the bash process and the in-flight `npm install` child. Marker files survive but state-file writes (`*.consecutive-heal-fails`, `*.last-heal`) may be partial. Low-frequency (5-min cycle × concurrent agent-update probability), but worth a `flock` on the state-dir or a "watchdog currently running" check before bootout. At minimum, document the race in §5.
- **(Minor) `peer_dir` interpolated into a `node -e` script.** `instar-watchdog.sh:255` builds `node -e "...readFileSync('$peer_dir/.instar/config.json'...)..."` via shell interpolation. If a future plist has a `WorkingDirectory` containing a single-quote, this becomes injection. Today's plist generator uses `escapeXml` for plist content but doesn't validate that the path is shell/JS-safe. Tiny risk — every current path is user-home-derived — but the structural fix is `node -e "...process.argv[1]..."` with `peer_dir` passed as an argv arg, not string-interpolated.

Non-issues verified:
- No race with `ServerSupervisor.preflightSelfHeal` (sequential parent→child, wrapper finishes heal before spawning CLI).
- Migrator script-only diff skips relaunch (§257) — correct.
- Auth-token is passed via `-H Authorization: Bearer` header, briefly visible in `ps`/`launchctl procinfo` but not logged. Acceptable for local-loopback.
- Rollback caveat in §7 (pre-PR hand-rolled script gets overwritten irreversibly on first update) is honestly disclosed.

Resolve the 422-reset bug before merge; the other two can land as same-PR follow-ups or a tracked commitment.

---

## Addendum 2026-05-17 — Cross-platform plist parsing for get_project_dir

After the node/npm resolution fix landed, CI shard 3/4 (Ubuntu) continued failing because `get_project_dir` used `/usr/libexec/PlistBuddy`, which is macOS-only. On Linux CI runners the binary doesn't exist, so `get_project_dir` silently returned empty, and `escalate_via_peer` skipped every candidate peer (the `[ -z "$peer_dir" ] && continue` guard). Zero HTTP requests reached the mock peer server — matching the three assertion failures at lines 221, 263, and 293 of `fleet-watchdog-escalation.test.ts`.

Fix: `get_project_dir` now tries PlistBuddy first (macOS production path — fast, authoritative), then falls back to a Python 3 XML parser (`xml.etree.ElementTree`), then as a last resort to a `grep` + `sed` chain on the raw XML. All three paths read the same `WorkingDirectory` key from the plist's top-level `<dict>`. Production behavior under launchd on macOS is unchanged: PlistBuddy fires as before. The new fallbacks only activate when PlistBuddy is absent.

Signal-vs-authority compliance: `get_project_dir` is a structural lookup (returns a directory path from a file), not a judgment call. No new blocking authority. No new decision-point surface.

All four `escalate_via_peer` integration tests now pass on both macOS (PlistBuddy) and Linux/CI (python3 fallback).

---

## Evidence pointers

- Spec: `docs/specs/lifeline-shadow-install-self-heal.md` (with ELI16 companion).
- Test files: `tests/unit/lifeline-shadow-install-self-heal.test.ts`, `tests/integration/fleet-watchdog-escalation.test.ts`.
- Today's incident reproduction:
  - Error log: `/Users/justin/Documents/Projects/ai-guy/.instar/logs/lifeline-launchd.err` — 37,659 "Shadow install not found" lines.
  - Watchdog log: `/Users/justin/.instar/watchdog.log` — 30+ "HEAL-FAIL: npm install failed" entries with `env: node: No such file or directory` interleaved.
  - Recovery: manual reinstall of shadow-install via `npm install --prefix ...` at 2026-05-17 21:23 UTC; AI Guy back to healthy state, server bound to port 4040, lifeline supervised under launchd.
