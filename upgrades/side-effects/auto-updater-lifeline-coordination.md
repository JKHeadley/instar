# Side-Effects Review — Auto-updater ↔ lifeline coordination + no-deferrals enforcement

**Version / slug:** `auto-updater-lifeline-coordination`
**Date:** 2026-05-22
**Author:** echo
**Second-pass reviewer:** subagent (high-risk: AutoUpdater + lifecycle + watchdog)
**Spec:** [docs/specs/auto-updater-lifeline-coordination.md](../../docs/specs/auto-updater-lifeline-coordination.md)
**ELI16:** [docs/specs/auto-updater-lifeline-coordination.eli16.md](../../docs/specs/auto-updater-lifeline-coordination.eli16.md)

## Summary of the change

Closes the failure class produced by today's b2lead-insights regression — a recurrence of the 2026-05-20 incident two days after PR #284 shipped four of five fixes and explicitly deferred the fifth. The fifth fix — *"lifeline auto-restart on server upgrade"* — is the actual prevention layer, and its deferral allowed the same outage to recur.

This PR ships the missing fix in three writer channels and three reader channels (each independent for redundancy), plus a structural enforcement that prevents future deferrals from rotting.

**Writers** (all write to `state/lifeline-restart-requested.json`):
- `AutoUpdater.requestRestart` — when `crossesBreaking(prev, next)` is true, writes the signal alongside the existing server-restart signal.
- `routes.ts /internal/telegram-forward` 426 path — writes the signal on direct evidence of skew.
- `PostUpdateMigrator.migrateStaleLifelineSignal` — one-time bootstrap for currently-stuck agents.

**Readers**:
- `TelegramLifeline.checkLifelineRestartSignal` — primary; checks every 30s, calls `initiateRestart('plannedUpgrade', ...)`. New `plannedUpgrade` bucket in `rateLimitState.decide` bypasses watchdog cooldown identically to the existing `versionSkew` bucket.
- Fleet watchdog (`src/templates/scripts/instar-watchdog.sh`) — checks every 5 min; force-restarts via launchctl if signal is >60s old. Out-of-process, so it can break a wedged event loop.
- (Future) v3 Remediator Tier-3 probe — explicit absorption point, tracked separately. <!-- tracked: topic-3079-v3-remediator -->

**Structural meta-fix**: `scripts/instar-dev-precommit.js` adds an orphan-deferrals scan. Every "deferred / out of scope today / NOT in this PR / preemptive fix / follow-up" mention in a spec must be linked (`<!-- tracked: <id> -->`) or the spec's frontmatter must explicitly wave it through (`deferrals-tracked: <affirmation>`). Override via `INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS=1`, logged + audited.

**Agent awareness**: CLAUDE.md template gains a "Version-Skew Self-Recovery" section migrated to existing agents.

## Decision-point inventory

- `crossesBreaking(prev, next)` — **add** — semver predicate; mechanic, no judgment.
- `writeLifelineRestartSignal` — **add** — atomic write + idempotent skip-fresh.
- `readLifelineRestartSignal` / `clearLifelineRestartSignal` — **add** — read with expiry check, atomic delete.
- `AutoUpdater.requestRestart` lifeline-signal branch — **add** — fires on major.minor crossing.
- `routes.ts /internal/telegram-forward` 426 lifeline-signal write — **add** — belt-and-suspenders.
- `PostUpdateMigrator.migrateStaleLifelineSignal` — **add** — one-time bootstrap.
- `TelegramLifeline.checkLifelineRestartSignal` — **add** — per-tick consumer.
- `rateLimitState.decide` `plannedUpgrade` bucket — **add** — shares cooldown-bypass + daily-cap with `versionSkew`.
- Fleet watchdog `check_stale_lifeline_signal` — **add** — out-of-process consumer.
- `instar-dev-precommit.js` orphan-deferrals scan — **add** — structural enforcement.
- CLAUDE.md "Version-Skew Self-Recovery" section — **add** (template + migrator).

## Deferrals tracked

Per the new enforcement rule, every potential deferral in this PR is either in-scope (and thus not a deferral) or explicitly tracked:

- v3 Remediator absorption — tracked at topic 3079 with active development; absorption is mechanical when Tier 3 lands. <!-- tracked: topic-3079-v3-remediator -->

No other deferrals. Tests, migration, CLAUDE.md awareness, cross-platform fleet watchdog wiring — all in this PR.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- **`crossesBreaking` fail-safe.** Returns `true` on malformed inputs (missing version, non-semver string). A false-positive triggers a single harmless lifeline restart — strictly better than a false-negative which is the exact incident class. Documented in unit test.
- **PostUpdateMigrator nudge — agent that legitimately wants the old lifeline.** If a user has pinned their lifeline at an older version on purpose (e.g. for compatibility testing), the migrator will signal a restart against their will on next update. Mitigation: a pinned-version operator would also pin the server. Same-major.minor → no signal. The corner case is "user pinned the lifeline only" — explicitly out of supported configurations.
- **Deferrals-check false-positives on technical writing.** A spec might legitimately use "deferred" / "follow-up" in a non-prescriptive context (e.g. quoting an older spec for historical comparison). The override flag `INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS=1` exists for this case, with mandatory audit logging. Practical false-positive rate from the test fixtures: zero (the regex's negation guard handles "no deferrals" / "non-deferred").
- **Server-side 426 writer over-firing on dev/test deployments.** If a dev runs the server with the version handshake disabled (no `authToken`), the 426 path doesn't fire. If they enable auth but mismatch versions intentionally, the signal write happens — but the lifeline's tick consumer is the only one that can act on it, and a dev's lifeline can read it just as well.

## 2. Under-block

**What failure modes does this still miss?**

- **Server downgrade (reviewer nit 2026-05-22, addressed).** `crossesBreaking('1.2.28', '1.1.0')` returns true (the major.minor genuinely changed). The cited "lifeline reads its own running version and skips" pathway (`TelegramLifeline.checkLifelineRestartSignal:1338`) only no-ops when `signal.targetVersion === this.lifelineVersion`. In a genuine server-downgrade scenario the lifeline is on the HIGHER version, the signal targets the LOWER version, and `lifelineVersion !== targetVersion` so the lifeline WOULD restart. After restart, the new lifeline matches the new lower server version — recovery is correct, just an extra restart on an intentional downgrade. Acceptable because downgrades through the auto-updater are not a supported flow; manual-install downgrades trip this once per downgrade, no worse than the manual-replace operator would already expect.
- **Lifeline that's both wedged AND offline from the fleet watchdog.** If `launchctl bootout` itself hangs (rare but possible under macOS sandbox bugs), the watchdog's force-restart doesn't land. No recovery within this PR. The fleet watchdog's existing 5-min retry plus the eventual launchd ThrottleInterval re-spawn provide eventual recovery; not always sub-15-minute.
- **Two AutoUpdater instances racing.** Idempotency-by-targetVersion handles the common case. If two AutoUpdaters write SIMULTANEOUSLY with the same target, the atomic rename ensures one wins cleanly. Different targets → second write replaces the first; either way the lifeline restarts to a coherent target.
- **Signal corruption (truncated write, half-written JSON).** Reader returns null for corrupt JSON; next writer replaces. Worst case: one missed cycle (~30s for lifeline tick, ~5 min for watchdog).
- **Tone gate B12 on the "Heads up" alert.** PR #284 already shipped this alert via the existing tone gate. This PR doesn't change the alert content; if a future change introduces jargon, the existing B12 ruleset blocks it and falls back to the safe template.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

- **AutoUpdater is the right writer for the proactive signal.** It KNOWS it's about to bump major.minor (it's about to install a new version). Pushing this knowledge to the lifeline via a signal file is structurally cleaner than expecting the lifeline to infer skew from forward failures.
- **Server-side 426 writer is a defensible second channel.** The server has direct evidence (the lifeline forwarded a wrong-version request). Even if AutoUpdater somehow missed the boundary, the server can repair the situation.
- **PostUpdateMigrator is the right home for the one-time bootstrap.** Updates flow through it; the bootstrap is a one-time correction, not an ongoing concern.
- **Fleet watchdog (out-of-process) for the wedged-lifeline case.** The original ServerSupervisor proposal lived inside the lifeline — wrong layer, would share the wedge. Fleet watchdog has independent process lifetime + already iterates all agents.
- **`plannedUpgrade` bucket alongside `versionSkew`.** Both are hard-incompatibility signals. Sharing the daily cap (versus separate caps) prevents bucket-hopping abuse.
- **Deferrals check in the pre-commit hook (not in CI).** Pre-commit catches it before any commit lands; CI is the second-pass authority. Structurally consistent with the other gates in the same hook (ELI16, tracked spec, artifact integrity).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] **No — this change produces signals consumed by existing smart gates.**

Detailed:
- `crossesBreaking` is a deterministic predicate (mechanic, not judgment).
- All three signal writers produce a candidate file; consumers decide.
- `TelegramLifeline.checkLifelineRestartSignal` calls `initiateRestart` — the existing authority — which goes through `rateLimitState.decide`, `RestartOrchestrator.requestRestart`, etc.
- The fleet watchdog's force-restart is a bounded recovery primitive (the principle's "Safety guards on irreversible actions" exemption — `launchctl bootout/bootstrap` is reversible by reboot but the mechanical action itself is bounded).
- The new `plannedUpgrade` bucket bypasses watchdog cooldown — but the daily cap (3-per-24h, shared with versionSkew) is the loop-safety backstop, identical to the existing versionSkew design from PR #284.
- The deferrals-check regex is a hard-invariant validator at the boundary (the principle's "Hard-invariant validation" exemption). Patterns are explicit, narrow, and the override flag exists for legitimate edge cases.

No new judgmental gates over message content or agent intent.

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:**
  - AutoUpdater writes both `restart-requested.json` (existing) and `lifeline-restart-requested.json` (new). Different consumers, different files. No shadow.
  - The lifeline's existing in-process versionSkew handler (PR #284) fires on 426 response. This PR's per-tick signal-file consumer is independent — it fires on the SIGNAL FILE. Both fire on the b2lead scenario; first-wins via `initiateRestart` rate-limit and the orchestrator's pid-based serialization.
  - Watchdog's `check_stale_lifeline_signal` runs in the healthy-PID branch before the bind-probe; on signal-hit it does an early `continue` so the bind-probe doesn't double-react.

- **Double-fire:**
  - All three writers can fire on the same boundary crossing. The `skipped-fresh` outcome in `writeLifelineRestartSignal` prevents duplicate audit-log entries.
  - The lifeline's per-tick consumer + the watchdog's per-cycle consumer can both see the same signal. The lifeline acts first (30s cadence vs 5min); on success, it `clearLifelineRestartSignal`'s first. The watchdog's signal-readability check returns null after clear → no double-restart.

- **Races:**
  - File-write race: tmp + rename is atomic on POSIX; concurrent writers see one win cleanly.
  - Read-then-delete race in the lifeline: a process exits between read and delete → respawned lifeline sees the signal on next tick → checks `targetVersion === lifelineVersion` → clears and no-ops. Documented in test.
  - Fleet watchdog vs lifeline-tick race: watchdog only acts when signal is >60s old. The lifeline's 30s tick has two cracks before the watchdog touches anything.

- **Feedback loops:**
  - The "Heads up" Telegram alert (PR #284 wiring) fires once per skew episode; the lifeline restart that follows doesn't reset the alert dedupe (per-PR-#284 semantics). On recovery, no extra alert.
  - PostUpdateMigrator runs on every update. Its bootstrap is idempotent (skip-fresh) and only writes when major.minor mismatches the just-installed version. No loop.

## 6. External surfaces

- **Other agents on the same machine:** YES — the fleet watchdog now reads each agent's signal file. Read-only, no cross-agent state. The same fleet watchdog landed in PR #245 / #272 and is already cross-agent-aware.
- **Other users of the install base:** YES — ships to every macOS agent via PostUpdateMigrator on next update. Linux/Windows users: AutoUpdater and lifeline-tick channels work the same (file-based, OS-agnostic); fleet watchdog channel is macOS launchctl-specific, so Linux users rely on the in-process consumers + the v3 Remediator absorption.
- **External systems:**
  - Telegram: one extra topic per affected agent during the rollout (the existing "Heads up" alert from PR #284). After this PR, that alert fires LESS often because the AutoUpdater coordination prevents many episodes from happening in the first place.
  - launchctl: fleet watchdog now occasionally calls `bootout/bootstrap` on lifeline plists. Already-shipped behavior; this PR adds one more trigger condition.
- **Persistent state:**
  - New `state/lifeline-restart-requested.json` per agent — single-line JSON, max ~500 bytes, expires after 1h, cleared by readers on action. Harmless if left behind.
  - `lifeline-started-at.json` is now READ by the migrator (in addition to its existing write by the lifeline). Format unchanged.
- **Timing:**
  - AutoUpdater apply gains one `writeLifelineRestartSignal` call (~5ms file write).
  - Lifeline gains a 30s-interval `fs.statSync` + occasional JSON parse (~1ms).
  - Server 426 path gains one signal write (~5ms) — only fires on actual version mismatches.

## 7. Rollback cost

- **Hot-fix:** revert each of the seven source files + the watchdog template. Independently revertable. Ship as a patch.
- **Data migration:** none. Signal files left behind: harmless (expire in 1h, cleared by readers).
- **Agent state repair:** none required. Reverting just disables the new behavior; existing agents continue to work via PR #284's in-process handler (which now requires post-PR-#284 lifeline code — i.e., the very thing this PR was meant to deliver).
- **User visibility:** none. The "Heads up" alert is unchanged in tone and frequency.
- **Estimated total:** ~30 min revert + release cycle.

---

## Addendum 2026-05-22 — Reviewer findings + fixes

Second-pass reviewer found one structural defect plus two minor items. All three addressed before merge:

**Structural — frontmatter wave-through was a loophole** (`scripts/instar-dev-precommit.js`). The original implementation honored a `deferrals-tracked:` frontmatter field as a whole-spec wave-through. A future author could write `deferrals-tracked: see below` and ship orphan deferrals undetected. **Closed:** the frontmatter wave-through is REMOVED entirely. Every body deferral mention must have its own `<!-- tracked: <id> -->` marker within 200 chars, with no spec-level escape hatch. Test added that asserts the loophole no longer exists (`tests/unit/instar-dev-precommit-deferrals.test.ts:"frontmatter deferrals-tracked is NO LONGER a wave-through"`).

The bootstrap-commit-that-introduces-the-rule itself (this very PR) uses the `INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS=1` env override because the spec describes the rule's vocabulary extensively for documentation purposes — and the audit log entry is the structural visibility. This pattern is documented in `skills/instar-dev/SKILL.md` Phase 4.5 as "the bootstrap-commit exception."

**Minor 1 — narrow `follow-ups` negation regex.** The prior pattern excluded only "follow-ups (are) tracked" and false-alarmed on natural variants. **Broadened:** the regex now matches all "follow-up" / "follow-ups" / "followups" mentions and lets the 200-char tracker-marker check do the work uniformly. Plural "deferrals" added to coverage too — reviewer noted the singular-only pattern would miss it.

**Minor 2 — Server downgrade doc nit.** The §"Under-block" paragraph cited a mitigation pathway that doesn't actually handle the downgrade case. Reasoning corrected above with the file:line reference.

**Confirmed sound (no change needed):** signal-vs-authority compliance; shared `versionSkew`+`plannedUpgrade` daily cap; PR #284 + this PR's signal-consumer coexistence under the orchestrator + rate-limit; watchdog signal-deletion ordering race-safety; `crossesBreaking` fail-safe choice; the one tracked deferral (v3 Remediator at topic 3079) is genuinely separable.

## Conclusion

Closes the deferral that produced today's regression. Adds three writers, three readers, one structural meta-fix, and CLAUDE.md awareness — all in this PR per Justin's 2026-05-22 directive. 43 new tests cover the full pipeline. The structural deferrals-check makes the rule durable across future PRs.

Clear to ship pending second-pass review.

---

## Second-pass review (if required)

**Reviewer:** echo (second-pass subagent)
**Independent read of the artifact: concern (minor — 2 items, 1 nit). Design is sound; ship after addressing item 1.**

- **Frontmatter wave-through is whole-spec, not per-hit.** The artifact and spec both phrase the rule as "each instance is linked OR the frontmatter waves it through." But `scripts/instar-dev-precommit.js:372` short-circuits the entire body scan when `deferrals-tracked:` is present (`if (hasFrontmatterDeferralsTracked(fmText)) return [];`). A future author can put `deferrals-tracked: see below` in frontmatter and ship a spec full of orphan deferrals with zero per-hit verification. This spec relies on exactly that path — without it, the body's 8+ uses of "deferred" couldn't commit. **Resolution:** when frontmatter wave is present, still require the affirmation to either (a) enumerate each deferral hit's tracker ID explicitly, or (b) reference a `## Deferrals tracked` section that the gate verifies contains a `<!-- tracked: ... -->` marker for each unique deferral phrase the body emits. This spec already has §"Deferrals tracked" structured correctly; the gate just doesn't validate it.

- **`follow-ups` negation is narrow.** `scripts/instar-dev-precommit.js:359` only excludes "follow-ups (are )?tracked". Natural variants — "follow-up is tracked", "follow-up has an owner", "follow-up at topic-XYZ" — false-alarm. Low harm (override flag exists), but adds friction. **Resolution:** broaden the lookahead to also accept "is tracked", "owned by", or any `<!-- tracked: ... -->` within the same line, OR drop the negation and rely solely on the within-200-char tracker-marker check that's already running for every other pattern.

- **Nit — §"Under-block: Server downgrade" reasoning is wrong.** The artifact says targetVersion===currentVersion skip handles downgrades. It doesn't — for a 1.2.28 lifeline against a 1.1.0 install, those differ, and the signal fires. The actual behavior is fine (it re-aligns toward the new install), but the stated mitigation isn't the one that runs. `TelegramLifeline.ts:1338` only skips on identity.

**Concur on the rest:**
- Signal-vs-authority compliance: all three writers + `crossesBreaking` are pure mechanics; `initiateRestart` and the shared `rateLimitState.decide` are the single authority (`src/lifeline/rateLimitState.ts:121-135` correctly shares the daily cap across `versionSkew` and `plannedUpgrade` — no bucket-hopping bypass).
- PR #284 absorption: `handleVersionSkew` (TelegramLifeline.ts:1275) and `checkLifelineRestartSignal` (TelegramLifeline.ts:1327) can both fire on the same skew episode, but the orchestrator serializes via PID and the shared 3-per-24h cap is the loop backstop. No harmful double-fire.
- Watchdog ordering: signal deletion after `bootstrap` (instar-watchdog.sh:589) is race-safe — respawned lifeline's same-version no-op (TelegramLifeline.ts:1338) handles any read-then-delete window.
- `crossesBreaking` fail-safe to `true` for malformed inputs is the correct choice given the false-positive cost (one harmless restart) vs false-negative cost (the exact incident class).
- Non-goals list is genuinely separable; the one tracked deferral (v3 Remediator absorption) has a real marker (`<!-- tracked: topic-3079-v3-remediator -->`) and the absorption point is mechanical.
- Linux/Windows coverage via in-process consumers (lifeline tick) is honest — the macOS-only fleet watchdog is the third channel, not the only one. Acceptable.

Items 2 and 3 are non-blocking. Item 1 is a structural loophole in the very gate being introduced — recommend tightening before merge so the rule the artifact promises is the rule the code enforces.

---

## Evidence pointers

- Spec: `docs/specs/auto-updater-lifeline-coordination.md` (with ELI16 companion).
- Tests: 5 new test files, 43 new tests.
- Incident reference: b2lead-insights regression 2026-05-22, ~46h silent Telegram ingress drop. Lifeline pinned at v1.1.0 while server auto-updated through 27 minor releases to v1.2.28.
- PR #284's spec explicitly deferred "lifeline auto-restart on server upgrade" as Forward note (NOT in this PR) — this PR closes that forward note.
