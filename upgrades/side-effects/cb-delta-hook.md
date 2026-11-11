# Side-effects review — the per-prompt delta hook in shadow

**Version / slug:** `cb-delta-hook`
**Date:** 2026-11-10
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (Fable 5.2; see end)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §7.7 ("the hook emits only the delta since the last prompt for this `(topic, session_id)` … one request instead of two … the hook sends the full briefing only for an epoch with no matching seed marker, otherwise the delta from the seed … While a fold lock is held for the topic the hook is suppressed entirely … Delta mode is keyed on the seeded marker, so Codex sessions and any Claude session never seeded keep today's behaviour. The delta hook is gated per machine on 9.1 being verified there and is measured in shadow first (both outputs computed, the delta size logged, rework compared) before it reduces anything a session loads"), §9.5's last paragraph, the §17 "Seeded marker / context epoch" row, decision 10 (`contextBudget.deltaHook.enabled`, per machine, after the shadow comparison), and §16's Phase 1 item "delta hook in shadow comparison". Phase 1 slice S15, stacked on S4 (`cb-topic-intent-layer`, which includes S1).
**Tier:** 2 (it changes a hook that runs on every user prompt of every session, Claude Code and Codex). Size: 2 new source files (~560 LOC), 5 touched; 3 new test files (~560 LOC).

## Summary of the change

1. **`src/monitoring/contextLayers/promptContext.ts`** (new): the server side.
   - The context epoch, resolved from the seeded marker (`state/context-layers/_seeded/<sid>.json`, compact or clear seed). No marker, a torn marker or a foreign marker reads `unseeded`.
   - The delta:
     - unseeded: the delta is the full output;
     - first prompt of a seeded epoch: messages at or before `seededAt` count as delivered only when the seed's own `/topic/context` read (a 200) was seen within 30 s before the marker; the briefing only when the seed's own `/topic-intent` fetch was seen in that window with an unchanged stable hash. The prompt route itself never records a fetch. A PostCompact record for the session more than 60 s after the marker makes the marker stale, so the epoch reads unseeded;
     - later prompts: messages not yet in this epoch's cursor, and the briefing when its stable hash changed. The hash ignores the freshness count, the lag warning and confidence numbers.
   - A per-(topic, session) cursor file, 0600, atomic, holding ids only.
   - The shadow log: `state/context-layers/_delta-shadow/prompts.jsonl`, append-only, 2 MB plus one rotated segment, ids and hashes only. The tree is git-ignored (`state/`), and backups already exclude `state/context-layers/`.
   - The summary.
   - The reduction verdict: switch on AND the sentinel present AND a claude-code canary group `healthy` with none `diverged`.
   - Fold suppression, Claude Code only: this session's fold marker, or a non-terminal fold record younger than the fold lock's TTL ceiling. A stale or torn record does NOT suppress (it logs `fold-not-suppressed` and a featureEvidence error); an unreadable fold state fails open to the full output.
   - Delivery (reduction mode only): a delta over 7,500 characters is never trimmed; that prompt receives the full output (reason `delta-over-budget`, counted in the summary's refusals).
   - A size-only renderer that mirrors the hook's Python formatter.
2. **`src/server/promptContextRoutes.ts`** (new):
   - `GET /topic/:id/prompt-context` is Bearer only (a device principal gets 403). It returns the FULL output (the briefing, and the same 15 messages slimmed to the formatter's fields with text capped at 1,000 characters). It returns the delta only when reduction is allowed for a seeded epoch, and `suppressed` under a fold.
   - `GET /context-budget/delta-shadow` returns 503 while `contextBudget.enabled` is off.
   - An observer middleware, mounted BEFORE the main routes, appends a `history-read` row when a topic history route (`/topic/context/:id`, `/telegram/topics/:id/messages`, `/topic/:id/messages`, `/topic/search?topic=`) is read within 30 minutes of an omission in that topic. It never blocks or changes the request.
3. **`src/server/topicIntentRoutes.ts`**: the briefing route's render and metering moved into `serveTopicIntentBriefing` with no behaviour change. The prompt route uses it, so both meter `briefing_served` identically. `onBriefingServed` tells the delta which briefing the seed fetched.
4. **`src/server/AgentServer.ts`** mounts the routes before `routes` and shares one `BriefingServeLog` with the briefing route. The delta switch is live-read from `contextBudget.deltaHook.enabled` (default false, no `migrateConfig` entry, the same pattern as `contextBudget.sentinel.enabled`). The shadow runs only when the layer store exists (`contextBudget.enabled`, dev-gated by S1).
5. **`src/core/PostUpdateMigrator.ts`** — `getTelegramTopicContextHook()`, which is always overwritten by `migrateHooks`. This is the same hook for Claude Code and Codex.
   - The hook reads stdin once.
   - Exit with no output when `INSTAR_SESSION_ID`'s fold marker exists under the agent home.
   - One request to the route (`--max-time 4`). Its body is parsed by Python into shlex-quoted assignments and then `eval`'d.
   - Any answer other than a valid 200 body runs the two older calls, unchanged.
   - `suppressed` exits 3, so the wrapper prints nothing at all.
   - The formatter gains the delta header and takes the unanswered list from the full history when in delta mode.
   - The whole output is buffered. On Claude Code, output over 9,000 characters (UTF-16 units) goes through a fitter: oldest history lines first, then the end of the briefing, then a hard cut, each with an in-band note. Codex output is not fitted.
   - The CLAUDE.md Registry-First row is migrated in `migrateClaudeMd`, sniffed on the route.
6. **`src/core/BackupManager.ts`**: `_prompt-cursors` and `_delta-shadow` are never-backup segments (a restored cursor would describe a context the restored session does not hold). Cursors untouched for 7 days are pruned.
7. **`src/data/feature-ladders.json`**: the `contextBudget.deltaHook` entry. Rungs are `dev-agent-live` and `fleet`, metrics are featureEvidence fired/error rows, drivers are 80 characters or fewer, and the owner is Echo, CMT-1536.
8. **`src/scaffold/templates.ts`, `src/server/CapabilityIndex.ts`**: the agent-awareness row and the endpoints.

## Decision-point inventory

- **Added:** a reduction gate (switch AND canary healthy). It has authority only over whether THIS route returns less, and it defaults to returning everything.
- **Added:** hook suppression under a fold marker or an open fold (the spec's §7.7 rule). It can only remove injected context, and only while a fold is open. No fold can begin in Phase 1, because the sentinel heartbeat precondition is false.
- **Changed:** the hook's request path (one request, then the old calls as fallback) and a new output bound on Claude Code.

## 1. Over-block

- **The fitter can drop context that was delivered before.** Before this change, output above 10,000 characters already reached the model only as a 2 KB preview plus a file path (PR #3048), so the fitter delivers strictly more than it did. Under 9,000 characters the output is unchanged; the integration test checks this byte for byte against the fallback path.
- **Suppression is bounded.** Only a fold marker or a fresh non-terminal record suppresses, and only for Claude Code sessions. Stale, torn or unreadable fold state sends the full output with evidence, so a stuck record cannot mute a topic.
- **A slow server.** The route call is bounded at 4 s, and a timeout falls back to the older calls, bounded at 2 s plus an unbounded messages call (as today). The worst case is about 4 s more than today on a server that hangs.

## 2. Under-block

- **Re-fetch detection is topic-level.** A history read carries no session id, and a direct file read is not observable. The summary therefore reports `unknown` with its reason, plus an upper bound on HTTP reads, whenever anything was omitted, and never reports zero. Tying a re-fetch to an omitted item needs per-session read attribution. <!-- tracked: CMT-1536 (Phase 1: attribute topic history reads to a session so delta re-fetches are exact) -->
- **The epoch comes from the seeded marker alone.** S11 writes a context epoch on every SessionStart source and is not built yet. Until it is, a resumed session that kept its id and its old marker is treated as still holding that seed. The resumed transcript does still contain it, but a `/clear` that keeps the id would not reset the epoch. That only matters once reduction is on, and reduction is refused until the canary is healthy. <!-- tracked: CMT-1536 (Phase 1 S11: per-source context epoch; switch the delta's epoch from the marker to it) -->
- **Dropped protected items are not carried yet (§9.5).** The delta hook is meant to carry a reduced packet's dropped protected items, but no reduced packet exists before S10, so nothing is dropped. In shadow nothing is reduced either. <!-- tracked: CMT-1536 (Phase 1 S10: the delta hook carries the reduced packet's dropped protected items) -->
- **Rework baseline.** It is reported `unknown` until S13's measurement backend exists. <!-- tracked: CMT-1536 (Phase 1 S13: rework baseline into GET /context-budget/delta-shadow) -->

- **Residual proxies (they matter only once reduction is on):**
  - Right after a Claude Code upgrade, before the new version's first compaction is seen, the gate reads the newest detection's (old) version.
  - Stale-marker detection depends on the PostCompact record landing.
  - A `/topic/context` read by anything in the 30 s before the marker counts as the seed's.
  - An over-budget prompt records everything as delivered while the hook's 9,000 fitter may still shorten it. This is disclosed in-band, and it is today's full-mode behaviour.

  These are reasons the shadow comparison and a per-version canary review come before the switch. <!-- tracked: CMT-1536 (before deltaHook.enabled: the gate reads the running engine version directly, and the seed records its own fetch evidence in the marker) -->

## 3. Level-of-abstraction fit

- The decision logic is pure functions over the existing seed-marker, fold-marker and fold-record files.
- The route follows the topic-intent and context-budget route modules.
- The hook stays the single per-prompt carrier.
- The canary is read through the sentinel's existing `status()`.

## 4. Signal vs authority compliance

The shadow is signal only. The two pieces of authority are both narrow and in the safe direction:
- the reduction gate defaults to full and needs two independent conditions;
- fold suppression follows the spec's §7.7 rule.

## 5. Interactions

- **Codex** runs the same hook. Its sessions are never seeded and the route treats any non-claude framework as unseeded, so its output is the full output with no fitting.
- **Older servers:** the fallback is the unchanged two calls.
- **The briefing route's metering** is unchanged: `briefing_served` is bumped once per prompt, as before.
- **The compaction-recovery seed** keeps its own `/topic-intent` and `/topic/context` calls. Its briefing fetch now also notes the briefing's hash.
- **Mounting** the router before the main routes: its two paths are new, so it shadows nothing. The observer only appends a row.

## 6. External surfaces

- Two new Bearer-only GET routes.
- A hook that now calls `/topic/:id/prompt-context`.
- A new CLAUDE.md row.
- Nothing leaves the machine.

## 7. Multi-machine posture

Machine-local by design. The cursor and the shadow log sit under `state/context-layers/` (git-ignored, never replicated). The reduction switch is per machine and reads that machine's canary. Each session's hook talks only to its own machine's server.

## 8. Rollback cost

- Revert the change. The next update rewrites the hook to the old two-call version.
- The cursor and shadow files are inert and can be deleted.
- Turning reduction off is `contextBudget.deltaHook.enabled: false`, which is already the default.

## Class-Closure Declaration

- `unbounded-self-action` — closure `n/a`: no self-triggered action. The route acts only on a prompt; its writes are one bounded cursor file per session and one bounded log.

## Evidence

- `tests/unit/context-budget-delta-hook.test.ts` (21; also covers the stale marker, the seed-fetch window by kind, delivery never trimming, the per-version gate, bounded suppression and the surrogate-safe bound):
  - the epoch (unseeded, compact and clear seeds, torn, foreign);
  - the delta against the epoch (an unseeded epoch is full; the seed basis omits messages up to the seed and the briefing only when the seed's fetch was seen; the cursor; a changed briefing; the freshness count alone is not a change; a new epoch resets);
  - cursor bounds and mode;
  - message keys are ids;
  - the seed-fetch window;
  - the renderer;
  - the fold marker and open fold suppress, a terminal fold does not;
  - every reduction refusal reason, and the healthy allow;
  - shadow log rotation, bounds and modes;
  - the log never holds message or briefing text;
  - median and p95;
  - re-fetch `unknown`, never zero.
- `tests/integration/context-budget-delta-hook.test.ts` (9): the REAL generated hook script against a real HTTP server. It also covers:
  - multi-line messages are dropped whole, and the newest five are kept;
  - the REDUCED path through the real hook: the delta header, no old messages, the unanswered block from the full history, a changed briefing resent, an over-budget briefing sent as the full output, and an unseeded session still full;
  - an open fold record prints nothing, and Codex is unaffected.

  The original six checks:
  - ONE context request;
  - full output in shadow;
  - output identical to the 404 fallback path's;
  - sizes logged with no text;
  - a seeded session still receives the full output while the logged delta is smaller;
  - a fold marker suppresses everything, with no request;
  - under 9,000 characters on Claude Code with the newest message kept;
  - Codex is not fitted.
- `tests/e2e/context-budget-delta-hook-alive.test.ts` (3):
  - the real AgentServer with the layer store built as server.ts builds it;
  - both routes return 200, and the route returns 401 without a token;
  - the hook installed by `PostUpdateMigrator.migrate()` reaches the route on the listening server;
  - after a seed whose briefing fetch went through the same server, the first prompt's delta omits the briefing while the session still receives it (the shadow half of "the first prompt after a compaction does not receive the packet and the briefing both");
  - a fleet agent: full output, summary 503, no files;
  - WIRED source checks.
- Ratchets and the existing per-prompt hook tests, each run alone, all green:
  - unit: topic-ref-ratchet 2, no-silent-fallbacks 5, feature-ladders-coverage 7, migration-parity 13, migration-parity-hooks 5, telegram-unanswered-detection 10, PostUpdateMigrator-time-injection 13, telegram-topic-context-session-clock 2, secret-externalization-hook-injection 2, secret-externalization-hook-resolver-lint 3, secret-externalization-survivability-migrator 7, installCodexHooks 14, hook-command-project-dir-anchor 11, redelivery-marker 12, BackupManager-never-backup 7, backup-manager 46, CapabilityIndex 10, capabilities-discoverability 196, claude-md-reference-layout 35;
  - e2e: compaction-telegram-context 24, redelivery-marker-e2e 9, secret-externalization-hook-lifecycle 3, context-layer-topic-intent-alive 3;
  - integration: topic-intent-routes 13, context-layer-topic-intent 3.
- `tsc --noEmit` clean.

## Second-pass review

**Reviewer (independent subagent on Fable 5.2, 2026-11-10 ~14:58 PST): "Concern raised".** Nothing blocks shadow: the `eval` round-tripped hostile `$(…)`, backticks, quotes and newlines inert; the route sits behind auth; 404, 503 and non-conforming bodies fall back.

SHOULD-FIX:
1. A stale seed marker (a later compaction whose seed failed) keeps the old epoch.
2. The seed basis assumed delivery without evidence. Any briefing fetch in the prior 2 minutes counted as the seed's, including the session's own pre-compaction prompt.
3. The cursor advanced on compute, not on delivery.
4. The reduction gate ignored the engine version.
5. The reduced path had no test at any tier.
6. Fold suppression was unbounded and applied to Codex, and a torn or unreadable record muted the whole topic.
7. The fitter orphaned multi-line message continuations, and dropped all history before shortening a large briefing.

MINOR: extra latency; double metering when the parse fails; a surrogate split in `boundBriefing`; `PC_OK` emitted first; `${#}` does not count UTF-16; history-read rows crowding the log; backups and cursor pruning; no `migrateConfig` entry; the stale template file; the test used `codex` instead of `codex-cli`.

**Resolution:**
1. `laterCompactionThan`: a PostCompact record for the session more than 60 s after the marker makes the epoch unseeded.
2. `SeedFetchLog`: only the briefing route and successful `/topic/context` reads record, within 30 s before the marker. The prompt route never records. Without the seed's history fetch, no message counts as delivered.
3. The delivery fit (finalised after re-check 1).
4. The running version (the newest claude-code detection) must be healthy.
5. Integration tests drive the reduced path, and the open-fold `exit 3`, through the real hook.
6. Claude Code only. Stale and torn records do not suppress and are logged; an unreadable fold state fails open with evidence.
7. The fitter groups multi-line entries, shortens the briefing to 3,000 first and keeps the newest five messages.

Minors fixed: `PC_OK` last, the surrogate guard, a 4,500 pre-check with exact UTF-16 measurement in the fitter, one history-read row per topic per minute, the never-backup segments, 7-day cursor pruning, `codex-cli`.

Kept by choice:
- no `migrateConfig` entry, following the `contextBudget.sentinel.enabled` inline-default pattern (default false is the safe value);
- the 4 s route timeout;
- the unused `src/templates/hooks/telegram-topic-context.sh`, which nothing installs.

**Re-check 1 (same reviewer, ~15:07 PST): "Concern raised".** Items 1–7 and the minors were confirmed against the code. One new defect: in reduction mode, delivery trimming could starve a large changed briefing forever, dropped messages before the briefing, and gave the session no disclosure. Minors: the residual proxies; `noteHistory` firing on arrival rather than on success; a regex in the fitter that raised a `FutureWarning`.

**Resolution:**
- Delivery never trims. A delta over 7,500 characters sends the full output for that prompt.
- `noteHistory` fires only on a 200 `finish`.
- The regex is now `r'^  \[[^\]]*\] (User|Agent): '`.
- The residual proxies are written into Under-block and tracked.

**Re-check 2 (same reviewer, ~15:12 PST): "Concur."** All three items were verified in the code, the fitter is clean under `python3 -W error`, and unit 21/21 and integration 9/9 were re-run. Two residuals were noted:
- an over-budget prompt records everything as delivered. This is now written into Under-block.
- over-budget prompts were invisible in the refusal counts. Fixed: `summarizeShadow` now counts `delta-over-budget`.

## Amendment (CI)

feature-delivery-completeness requires every migrateClaudeMd section to be tracked. The /context-budget/delta-shadow Registry-First row is now listed beside the sentinel row. The test passes: 269 tests.
