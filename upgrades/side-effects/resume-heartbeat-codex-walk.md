# Side-Effects Review — resume heartbeat checks a session in its own framework layout; bounded Codex rollout lookup

**Version / slug:** `resume-heartbeat-codex-walk`
**Date:** `2026-10-13`
**Author:** Echo (instar 1.x maintainer session)
**Second-pass reviewer:** reviewer subagent (session lifecycle / recovery path — see below)

## Summary of the change

The 60-second topic resume heartbeat (`commands/server.ts` → `TopicResumeMap.refreshResumeMappings` → `jsonlExists`) checked every live session's recorded transcript id in every framework layout: Claude, then the Codex rollout archive, then Gemini. The Codex branch (`providers/adapters/openai-codex/observability/sessionPaths.ts: findRolloutFileSync → walkForUuidSync`) synchronously `statSync`ed every entry under `~/.codex/sessions` before testing its name — 286,984 files on the Mac Studio — so a MISSING Claude id cost ~25 s of blocked event loop, once a minute, for each of two live Claude sessions with stale ids. The supervisor restarted the healthy server three times on 2026-10-13 (forensic report: `.instar/lanes/server-loop-freeze-1013-PROGRESS.md`, mitigation 1).

Files touched:

- `src/providers/adapters/openai-codex/observability/sessionPaths.ts` — `findRolloutFileSync` / `findRolloutFile` rebuilt: positive cache validated with one stat; miss cache (60 s TTL + newest-partition mtime generation, explicit `invalidateRolloutLookup`); UUIDv7 partition hint (`rolloutPartitionHint`, local date ±1 day, names only); sync-only bounded readdir-only scan (`SYNC_SCAN_NAME_BUDGET` = 20,000 names); async enumeration with Dirent names tested before any stat, yielding per directory and every 5,000 names, bounded by `ASYNC_SCAN_NAME_BUDGET`, single-flight per uuid. `rolloutLookupStats()` / `resetRolloutLookupState()` / `pendingRolloutLookup()` for tests and observability. `walkForUuidSync` / `walkForUuid` removed. `listAllRollouts` / `findNewestRolloutSync` unchanged.
- `src/core/TopicResumeMap.ts` — `jsonlExists(uuid, framework?)`: `claude-code` → Claude layouts only (project dir + pooled `~/.claude-*` homes); `codex-cli` → Codex only; `gemini-cli` → Gemini only; unknown → legacy order. `refreshResumeMappings` input carries `framework`; `get()` passes the entry's framework tag (untagged → `claude-code`); `findUuidForSession` / `jsonlExistsPublic` take the framework.
- `src/threadline/ThreadResumeMap.ts` — same framework-scoped `jsonlExists`; optional `frameworkResolver` (session name → framework) via constructor option / `setFrameworkResolver`.
- `src/core/ResumeHeartbeat.ts` (new) — `buildResumeHeartbeatInput` + `runResumeHeartbeatTick`, the tick extracted from `server.ts` so tests run production's tick.
- `src/commands/server.ts` — the interval calls `runResumeHeartbeatTick` with each session's `framework`; all six save-before-kill `findUuidForSession` sites pass `session.framework`; `ThreadResumeMap` gets a resolver over `state.listSessions()`.
- `src/core/CodexResumeMap.ts` — `save()` invalidates a remembered miss for the saved rollout id.
- Tests: unit (`codexRolloutLookup-bounded`, `TopicResumeMap-framework-layout`, `threadline/ThreadResumeMap-framework`, `ResumeHeartbeat` incl. server.ts source pins), integration (`resume-heartbeat-health-concurrency` — real `AgentServer` + `/health` under ticks over a 25,000-file synthetic archive, event-loop lag probe), e2e (`resume-heartbeat-framework-lifecycle` — production construction of the three maps + tick, stale/appearing transcripts, codex topic + thread, restart). Helper `tests/helpers/codexArchiveFixture.ts`.

## Decision-point inventory

- `TopicResumeMap.jsonlExists` — **modify** — "does this session's transcript exist?" now scoped to the session's framework layout. Outcome space unchanged (true/false); a miss keeps the mapping, never deletes or substitutes.
- `TopicResumeMap.refreshResumeMappings` (the heartbeat writer) — **modify** — same gate order (live pane probe → §8 profile write-gate → authoritative id + transcript-exists); the transcript check now takes the framework. No new write path.
- `ThreadResumeMap.get` transcript guard — **modify** — same scoping, resolver-supplied framework; unknown ⇒ today's behavior.
- `findRolloutFileSync` / `findRolloutFile` — **modify** — a lookup, not a gate; result space unchanged (path | null). New: a sync caller for an UNDATED id on an archive beyond the sync budget can receive null on the FIRST call while the background enumeration runs (see §2).
- `CodexResumeMap.save` — **pass-through** (+ cache invalidation).
- `server.ts` heartbeat interval — **pass-through** (same cadence, same inputs + framework).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- A session tagged `claude-code` whose transcript genuinely lives only as a Codex rollout: impossible by construction (Claude writes JSONL under `~/.claude*`; the tag comes from the spawn-time resolved framework). Not a real input.
- A `codex-cli` session whose id is NOT UUIDv7 on an archive larger than 20,000 names: the sync lookup answers an honest null on the first call and the async enumeration settles it for the next call. Every id in the real archive is v7 (sampled 2026-10-13: all 6 sampled partitions, 100% version-7), and the Codex CLI mints v7 ids, so this is a theoretical edge. On a small archive (≤ 20,000 names) an undated id still resolves synchronously on the first call (tested).
- A rollout written to a partition more than one day away from its UUIDv7 instant (clock skew): hinted partitions miss; the sync call answers null and the background enumeration finds it for the next call. Verified by the codex archive sample: partition == local date of the uuid instant.

No issue identified beyond the bounded first-call miss above, which is deliberate (the alternative is the walk this change removes).

---

## 2. Under-block

**What failure modes does this still miss?**

- A session with NO framework tag (a legacy running record, or a thread bound to a pruned session) still takes the framework-blind order. That path is now bounded instead of a 287k-stat walk: ≤ 20,000 names on the main thread, then ONE bounded background enumeration of the whole archive (readdir-only, yielding) whose miss is remembered for 5 minutes (`ROLLOUT_ENUMERATED_MISS_TTL_MS`; the cheap-path miss TTL is 60 s). The residual cost per such stale id is therefore one background enumeration every ~5 minutes — never a freeze, but not free (second-pass review). Running sessions carry the tag at spawn; legacy `undefined` records are pre-tag installs.
- The Gemini walker (`findGeminiSessionFileSync`) still stats each `session-*` file in `~/.gemini/tmp/*/chats`. Gemini session counts are small (hundreds, not hundreds of thousands) and a Claude session no longer reaches it. Not changed here; noted, not a regression.
- The `ProjectMapper` synchronous boot scan (mitigation 3 in the report) is a separate boot-time stall and is deliberately NOT in this change — tracked as ACT-109. <!-- tracked: ACT-109 -->
- A cached miss (60 s after a cheap-path miss, 5 min after a full enumeration) can hide a rollout written in that window into an OLDER partition (the generation stamp watches only the newest partition). `CodexResumeMap.save` invalidates explicitly for the one caller that knows a rollout was just written; any other reader sees it within the TTL. An async caller that arrives while the sync path's enumeration is still running JOINS it rather than reading the cheap-path miss (fixed on the second-pass reviewer's finding).

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes, at two layers on purpose. The caller fix (framework-scoped check) is at the resume maps, where the session's framework is known — the layer that mis-routed the lookup. The lookup fix is in the Codex adapter's `sessionPaths`, the single helper every Codex consumer (CodexResumeMap, conversationLogReader/Tailer, sessionResumeIndex, the layout canary) already routes through — so the bound protects future framework-blind callers too, not just this heartbeat. No higher-level gate exists that this should feed; it is a filesystem lookup, not a judgment. The tick extraction (`ResumeHeartbeat.ts`) is a pure refactor so the production tick is testable; the interval and its inputs are unchanged.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

`jsonlExists` answers "does a file exist" and the resume maps use it exactly as before (keep / don't write; resume id / null). No message, action, or session is blocked or allowed by new logic; the only behavioral delta is WHICH directories a deterministic existence check reads. The §8 profile write-gate remains the only authority on the heartbeat's writes and is untouched.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The framework scoping is an invariant (a Claude transcript lives in a Claude home; a Codex rollout in the Codex archive), enumerable by construction. The lookup budgets (20,000 names sync; 2,000,000 async; 60 s miss TTL) are capacity floors on a filesystem read, not a judgment between live signals.

---

## 5. Interactions

- **Shadowing:** the framework check runs BEFORE the Codex/Gemini branches for a tagged session; those branches are shadowed on purpose for that session. For an untagged caller nothing is shadowed (legacy order kept). The §8 write gate still runs before any transcript check in the heartbeat.
- **Double-fire:** none. One tick per 60 s as before; the async enumeration is single-flight per (root, uuid) and shared by concurrent sync/async callers (tested).
- **Races:** the module-level caches are per-process; the sync path reads them, the async enumeration settles them. A positive entry is re-validated with one stat per read; a negative entry carries a TTL and a generation stamp. `CodexResumeMap.save` → `invalidateRolloutLookup` prevents the save/get race (get right after save on a fresh rollout). The heartbeat's tmux `display-message` probe (`withSyncOp`) is unchanged.
- **Feedback loops:** none. A miss does not trigger a write, a kill, or a respawn; it leaves state as it was.
- **Reaper / swap / compaction:** unchanged — they consume `findUuidForSession`, which now resolves in the session's own layout (strictly fewer directories read, same results for real transcripts).

---

## 6. External surfaces

- Other agents on the same machine: none (per-process caches, same files read). The Threadline MCP stdio entry (`src/threadline/mcp-stdio-entry.ts`) builds its own `ThreadResumeMap` in a separate process without a framework resolver: it keeps the legacy every-layout order over the bounded lookup — correct, just not framework-scoped.
- Install base: every agent gets the bounded lookup and the framework-scoped checks at the next update + restart; no config, no migration, no stored-format change (the `framework` tag on topic-resume-map entries already existed).
- External systems: none.
- Persistent state: `topic-resume-map.json`, `codex-resume-map.json`, the conversation store — read/written with the same shapes. A stale mapping that used to be kept is still kept.
- Timing/runtime conditions: the UUIDv7 partition hint depends on Codex partitioning by LOCAL date and minting v7 ids — both verified against the live archive on 2026-10-13; a layout change degrades to the bounded scan + async enumeration (slower, still correct) and is caught by the existing `codexSessionLayoutCanary`.
- **Operator surface:** no operator-facing actions added or touched. The change is invisible except that the server stops freezing.
- Agent Awareness / CLAUDE.md template: no new capability or endpoint; nothing for an agent to surface. Not applicable.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** Transcript existence is a per-machine fact (a Claude JSONL or a Codex rollout lives on the disk of the machine that produced it — Resume Follows the Account §3.3, CodexResumeMap §5.3 transcript locality), and the lookup caches are per-process. The resume maps' replication posture is unchanged by this PR. No user-facing notices are emitted (nothing to one-voice gate); no durable state is introduced (nothing to strand on topic transfer); no URLs are generated.

---

## 8. Rollback cost

- **Hot-fix release:** pure code change — revert the PR, ship the next patch.
- **Data migration:** none; no stored format changed.
- **Agent state repair:** none. Mappings are kept on a miss exactly as before.
- **User visibility:** none during rollback; the regression a rollback restores is the freeze itself.

---

## Conclusion

The review produced one design change: the Codex lookup was rebuilt as a layered bounded lookup (cache → miss cache → v7 partition hint → bounded sync scan → yielding async enumeration) instead of only making the heartbeat framework-aware, so a future framework-blind caller cannot re-create the walk. The one deliberate behavioral edge — a sync lookup for an UNDATED id on an archive beyond 20,000 names answers null on the first call and resolves on the next — is bounded, tested on both sides, and does not occur for real Codex ids (all v7). ProjectMapper's boot scan is explicitly out of scope and tracked (ACT-109). Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** reviewer subagent (independent read, 2026-10-13 13:41 PDT)
**Independent read of the artifact: concur, with two concerns — both resolved before commit**

The reviewer traced `findRolloutFileSync` end to end (no path stats the archive; the flat-layout fallback is a budgeted Dirent walk), re-verified the live archive (287,040 rollouts, zero non-v7 names, each sampled id's v7 instant in its own local-date partition), confirmed the §8 write gate is installed in `server.ts` so a codex id never lands in `TopicResumeMap`, confirmed `state.listSessions()` is memoized (1 s) so the per-`get()` resolver is cheap, the interval still `unref()`s, all six save-before-kill sites pass the framework, and the single-flight/cache invariants hold.

- Concern raised: `findRolloutFile` (async) returned null on a fresh cheap-path miss without joining an enumeration the sync path had started, so an async caller could be told "absent" for up to 60 s. **Resolved:** the async lookup now joins the in-flight enumeration before consulting the miss cache (`sessionPaths.ts`, `findRolloutFile`); test `an async lookup joins an enumeration the sync path started`.
- Concern raised: §2 understated the residual cost of an untagged stale id on a > 20k archive (a 60 s miss TTL equal to the tick meant a full enumeration roughly every other minute). **Resolved:** a fully enumerated miss is remembered for 5 minutes (`ROLLOUT_ENUMERATED_MISS_TTL_MS`), still dropped by the generation stamp and explicit invalidation; §2 reworded to "one bounded background enumeration every ~5 minutes"; the TTL test covers both windows.

---

## Evidence pointers

- Forensic report: `.instar/lanes/server-loop-freeze-1013-PROGRESS.md` (agent home; samples `server-loop-freeze-1013-sample-125807.txt`, `…-fsusage-freeze2.txt`).
- Unit: `tests/unit/codexRolloutLookup-bounded.test.ts` (20), `tests/unit/TopicResumeMap-framework-layout.test.ts` (12), `tests/unit/threadline/ThreadResumeMap-framework.test.ts` (5), `tests/unit/ResumeHeartbeat.test.ts` (8). Existing: `codexRolloutFileSync`, `TopicResumeMap`, `topic-resume-map*`, `threadline/ThreadResumeMap`, `CodexResumeMap`, `codexSessionLayoutCanary`, `TopicProfileOrchestrator` — all green.
- Integration: `tests/integration/resume-heartbeat-health-concurrency.test.ts` (2).
- E2E: `tests/e2e/resume-heartbeat-framework-lifecycle.test.ts` (5); existing `session-resume-e2e` (42), `resume-follows-account-dead-pane-e2e` (3) — green.
- `npm run lint` green.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (the defect is in runtime TypeScript, not an LLM prompt, hook, config, skill or standards text). This change adds no self-triggered controller: the heartbeat interval already existed and is unchanged; the background enumeration is a bounded, single-flight, non-actuating filesystem read that restarts, swaps, spawns, notifies or kills nothing.

## Addendum (2026-10-24) — a transcript check that errors is reported, not swallowed

The no-silent-fallbacks ratchet (`tests/unit/no-silent-fallbacks.test.ts`) flagged the two bare `catch` blocks this change introduced in `TopicResumeMap.claudeTranscriptExists` (the `fs.existsSync` on this project's `~/.claude` transcript dir, and the `claudeConfigHomes()` enumeration of pooled `~/.claude-*` homes). Both turned an ERROR into "transcript not found" silently. That matters: `TopicResumeMap.get()` reads a miss as "transcript gone" and may expire a live session's resume entry, so the next spawn would start fresh instead of resuming.

- **Decision point:** `TopicResumeMap.claudeTranscriptExists` — **modify (observability only)**. The verdict is unchanged (an error is still a miss; nothing is deleted or substituted). Each catch now reports through `DegradationReporter` (feature `TopicResumeMap.claudeTranscriptExists`, with the layout that failed and the error message). The reporter's per-feature alert cooldown (1 h) means a heartbeat-rate failure surfaces once an hour, never as a flood.
- **No new write path, config key, route, or stored-format change.** No self-action. No framework-launch or messaging surface touched.
- **Evidence:** `tests/unit/no-silent-fallbacks.test.ts` green at the existing baseline (494); `npx tsc --noEmit` and `npm run lint` clean; the 30 unit files, 15 integration files and 10 e2e files that reference the resume maps, heartbeat or Codex rollout lookup all pass (582 / 174 / 177 tests).
