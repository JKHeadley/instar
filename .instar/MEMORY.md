# Echo Memory Index

This is my persistent, cross-session memory. Each entry is a discrete file under `.instar/memory/`.

## Learnings

- [Phase 1b autonomous burst (2026-05-12)](memory/learning_phase_1b_autonomous_burst.md) — 7 PRs shipped end-to-end via /autonomous skill. Defer-to-Future-Self trap caught twice. /autonomous's stop hook is structural enforcement against premature exit. Pattern for primitive-without-consumer shipping.

## Capabilities & Implementation

- [Parity Renderings Backfill (v1.0.11)](memory/capability_parity_renderings_backfill.md) — `instar update` now runs `PostUpdateMigrator.migrateAsync()` which iterates the parity rule registry and re-renders every canonical skill/hook/memory into framework-native shape. Idempotent via `_instar_migrations` marker. Hooks overwrite; skills/memory refuse-on-conflict.
- [Hook Parity Rule (v1.0.3+)](memory/capability_hook_parity_rule.md) — Hooks now have canonical-source + per-framework rendering, same pattern as Skills. Currently covers session-start; other events are documented and land mechanically. Access via `getParityRule('hook')`.
- [Fleet Watchdog Peer Escalation (vNEXT)](memory/capability_fleet_watchdog_peer_escalation.md) — Multi-agent peer escalation on persistent failure. If an agent won't auto-heal after 15 min, a healthy peer escalates to Telegram. Single-agent machines are a known gap. REQUIRES: `npm rebuild better-sqlite3` to restore durable message queue.
- [Lifeline Shadow-Install Self-Heal (vNEXT)](memory/capability_lifeline_shadow_install_self_heal.md) — Boot wrapper auto-reinstalls missing shadow-install using absolute-path node/npm resolution. Prevents multi-day outages from vanished directories. Automatic, zero config.
- [Token-Burn-Detection Phase 2 (vNEXT)](memory/capability_token_burn_detection_phase_2.md) — Attribution resolver identifies which component made each LLM call. Pure function + static manifest of 9 known components. 22 unit tests all pass. No behavior change yet — Phase 3 will wire it up to detect burns.
- [Token-Burn-Detection Phase 1 (vNEXT)](memory/capability_token_burn_detection_phase_1.md) — Foundation layer for self-watching token consumption. Attribution column on ledger, rate-gate primitive, component identifier helper, and direct-LLM-HTTP lint rule. No behavior change yet — Phase 3 will add the burn detector, Phase 4 will add auto-throttle, Phase 5 will add alerts.
- [PromiseBeacon Auto-Pause Tuning (v0.28.83+)](memory/capability_promisebeacon_auto_pause.md) — When an agent says "I'll watch for X," the watcher now gives up after ~40 minutes of no progress (4 cycles) instead of 2–3 hours (12 cycles). Sends one final "auto-paused — reply 'keep watching' to resume" message. Same resume flow as before, no setup needed.
- [Native Module Self-Heal (vNEXT)](memory/capability_native_module_self_heal.md) — better-sqlite3 ABI mismatch on Node drift now auto-rebuilds in-line at SemanticMemory/TopicMemory/MemoryIndex open(). Heal log at native-module-heals.jsonl. Supervisor preflight is a separate older path NOT covered — backport needed.
- [Input Lockup Secondary Bug — OPEN](memory/project_input_lockup_secondary_bug.md) — PR #160 StuckInputSentinel ships, lands as designed, but live-evidence shows a SECOND stuck-input mode where Enter/C-m/paste-end-escape all fail. Visible text behaves like stale render of an uncommitted queued paste. Needs separate investigation: bracketed-paste-stuck vs modal-overlay vs TUI state-machine wedge vs pane-focus.
- [Attention Queue Tone Gating (v0.28.82+)](memory/capability_attention_queue_tone_gate.md) — Every alert to your attention queue now runs through an automatic quality gate. Blocks low-signal items (auto-resolved events, FYI updates, jargon-soup) before they reach you. Recurring degradations route to the same topic instead of spawning duplicates.
- [Topic-Bound Session Persistence (v0.28.80+)](memory/capability_topic_bound_session_persistence.md) — Telegram/Slack/iMessage agents stay resident for 4 hours while conversation-bound (was 15 min). No respawn delays when resuming after stepping away.
- [Failed Resume Fallback (v0.28.80+)](memory/capability_failed_resume_fallback.md) — Stale resume UUIDs that crash during startup now trigger automatic fresh-spawn fallback with original message preserved. No silent message drops.
- [Node.js In-Place Upgrade Resilience](memory/capability_node_upgrade_resilience.md) — Auto-update migration handles stale process.execPath gracefully when Homebrew upgrades in-place
- [Bounded Token Ledger Scan (v0.28.78+)](memory/capability_bounded_token_ledger_scan.md) — Token ledger startup processes batches of 500 files with event-loop yielding, focusing on recent 30-day window first to prevent multi-minute blocks

## Execution & Autonomy

- [Phase completion = real-API verified, never auth-blocked-as-pass](memory/feedback_phase_completion_real_api_verified.md) — A phase isn't done until the real-API gates pass. Auth-blocked / skipped / gated-off are ALL non-pass states. Verified 2026-05-15 after I labeled Phase 4 (Codex adapter) "complete" with only structural parity. Mechanism: machine-checkable phase-acceptance manifest enforced in the autonomous loop.
- ["Finish it out" means MERGED + verified, no check-ins](memory/feedback_finish_means_merged.md) — "Finish it out / keep going / complete this" = drive to merged on main with CI green, autonomously. Report once at end.
- [Verify commit actually landed](memory/feedback_verify_commit_landed.md) — Use `git branch --contains <sha>` before claiming shipped; rebase/reset can silently orphan direct-to-main commits
- [Worktree-default for shared repos](memory/feedback_worktree_default_shared_repos.md) — When resuming work in the instar repo, first action is `git worktree add` — never operate on the shared checkout
- [Topic-arc grounding on multi-turn topics](memory/feedback_topic_arc_grounding.md) — Follow-ups must be answered against the topic's stated goal + open threads, not just the literal last message. Last-N-messages bootstrap is a transcript, not a brief. Discipline rule until topic-intent infra ships.

## Infrastructure & Pending Work

- [TelegramLifeline /internal auth](memory/project_telegram_lifeline_internal_auth.md) — Shipped fix: TelegramLifeline sends Bearer auth on /internal/telegram-forward and /internal/telegram-callback. If a user is stuck on 0.28.53 and inbound Telegram 401s, upgrade.
- [Critical: Continuity Escalation Failure (2026-05-09)](memory/project_continuity_escalation_failure.md) — Identified at session-continuity-check: findings emit in quiet mode but user cannot act. MEMORY.md stale 4+ days. Fixed reflection-trigger to always write handoff notes. Status tracked in .instar/state/job-handoff-* files.
- [Scheduled jobs starved by user-session pool](memory/feedback_scheduled_jobs_starved_by_user_sessions.md) — 10-slot cap held by long-lived user topics; commitment-detection / dashboard-link-refresh / git-sync etc. hard-fail with consecutiveFailures 25+. Needs reserved quota, idle-reaper, or spawn queue.

## Session Continuity

These memory files persist across session boundaries and are synced by instar. Read them at session start if resuming work on a topic.

**Last Updated**: 2026-05-17
