# Context Budget: Layered Summaries — Phase 0 verification results

**Spec:** `docs/specs/context-budget-layered-summaries.md`, §16 item 1 (Phase 0, "ends when every check has a recorded result") and the Maturation plan's `test-agent-live` line.
**Recorded:** 2026-11-10, by Echo's builder.
**Machine:** every number below was measured on the **Mama PC** (`m_e8c9b243c449b1337713bc29d47a6f3a`, hostname `MamaPC`, WSL2) unless a row says otherwise. Nothing here is a fleet-wide number.
**Other machines:** the pool lists the Mac Mini, Dabombs Mac Studio and Mac M5 Pro as online (`GET /pool`, 2026-11-10 20:0x UTC). None of the routes these checks need (`/context-budget/sentinel`, `/tokens/*`, `/topic-intent/*`) has a pool scope, and the transcript checks need file access, so **no peer was measured**. The Mac Studio carries most of Echo's long-topic load (spec §2: 4.4B tokens in 24 h there); its numbers are the ones that matter most and are still to be taken.
**Claude Code:** 2.1.322 on this machine (the earlier L7 runs were on 2.1.321).

## Summary

| # | Check | Recorded? | Result in one line | Evidence |
|---|---|---|---|---|
| 1 | 9.1 fix, L7 before/after + live | **Recorded** | L7: 0 → 1 recovery block. Live: 3 of 3 compactions in agent sessions since the fix carried the block (47 of 47 before it did not). **But on all 3 the block reached the model as a 2 KB preview, not whole** (see check 4) | §1 |
| 2 | Canary `healthy`, ≥ 3 synthetic positives | **Not recorded** | `GET /context-budget/sentinel` → 503 (sentinel dark); `recordSyntheticPress` has no caller. Pending Phase 1 S11 | §2 |
| 3 | Adapter suite, Claude Code | **Recorded** | 2.1.322: 12 supported, 0 partial, 4 absent (all 4 are "unmeasured by this suite") | §3 |
| 4 | Delivery capacity 50K / 100K / 150K tokens | **Recorded (answer: no)** | A SessionStart hook's output over **10,000 characters** is replaced by a pointer to a saved file plus a **2 KB preview**, for plain stdout and for `additionalContext` alike. 50K, 100K and 150K tokens cannot arrive intact through this carrier | §4 |
| 5 | Hook ordering | **Recorded (partial)** | PreCompact → summary → SessionStart(compact) → PostCompact (server receipt) → `compact_boundary` flushed. SessionStart vs PostCompact *start* order not proven | §5 |
| 6 | Both post-compaction paths, counted | **Recorded (this machine)** | 60 boundaries in 769 transcripts: hook block on 3, server inject on 0, both 0, neither 57 | §6 |
| 7 | Topic-intent layer inventory | **Recorded (this machine)** | 100 topics: 57 with a store file, 41 with refs, **0 with a non-empty briefing** (every ref is still at `observation` tier, no awareness anywhere) | §7 |
| 8 | Asymmetry by sender | **Recorded** | 3 largest transcripts: operator-typed text ≤ 0.1%; tool calls + results 38–80%; hook/server-injected 18–64%; assistant prose 1–5% | §8 |
| 9 | Per-turn token baseline | **Recorded** | Long sessions (> 100 requests), Mama PC: **53,891 input-weighted tokens per request** (cache read 442,898/request = 82% of the weight); last 7 days 41,892 | §9 |
| 10 | Window-setting precedence | **Not measured** | Procedure below | §10 |
| 11 | Fold cost per rung, handoff orderings, rollback restore per rung, p99 fold duration | **Deferred** | Deferred to Phase 2 entry by construction: needs the fold step runner | §11 |
| 12 | `/clear` rotation; PreCompact output format | **Recorded** | `/clear` rotates the Claude session id and transcript file; PreCompact stdout → `newCustomInstructions`, cut at 10,000 chars, exit 2 blocks | §12 |

Not covered by this report (also on §16 item 1's list, not in this check set): Codex hook delivery and the framework discriminator on Codex, the fold hold refusing sends on Slack/app/single-machine topics, and the boot sweep at every fold step.

### The finding that changes the design

Claude Code 2.1.322 persists any hook output longer than 10,000 characters to a file and gives the model only `<persisted-output>`, the file path and the first 2 KB (binary: `aCe(…, {threshold: HFe = 1e4})`, preview `eM = 2000`). This holds for SessionStart plain stdout and for `hookSpecificOutput.additionalContext`. Consequences:

- **The live recovery block is not delivered whole today.** Echo's recovery block is about 45.5 KB. On all three post-fix compactions in topic 141133's session the model received the machine-load note, the `=== IDENTITY RECOVERY (post-compaction) ===` line and the start of the recent messages, then a file path. Identity, soul, briefing and the rest arrive only if the model reads that file.
- **The canary would count these as recovered.** `compactionCanary.ts` tests the hook's *stdout* for the marker line, and the stored attachment holds the full stdout. A recovery that printed but did not land reads as healthy. The detection should test what the model was sent (the request carries `<persisted-output>`), or the block must fit under 10,000 characters.
- **Rung 1 (clear-and-seed) cannot carry a large packet through the hook.** The writer allows packets up to 8 MiB; anything over 10,000 characters lands as a pointer. The cb-clear-seed L7 proof used a one-line packet, so it did not exercise this. The spec's 50K–150K-token seed sizes are out of reach through this carrier on 2.1.322: a seed must fit in about 10,000 characters (≈ 3.3K tokens measured), or be a short pointer the model is told to read, which costs a tool call and makes delivery depend on the model acting.

---

## 1. The 9.1 fix: L7 before/after and live evidence

**L7 (recorded earlier, throwaway project, real `/compact`, Claude Code 2.1.321):**
- `upgrades/side-effects/cb-compaction-recovery-source.md`: with the installed (old) hook the transcript had a `compact_boundary` entry and **0** recovery blocks; with the fixed hook, a `compact_boundary` and **1** recovery block.
- `upgrades/side-effects/cb-one-recovery-carrier.md`: a real `/compact` wrote the seeded marker (`0600`, dir `0700`) with the real session id; replaying that transcript and marker through the sentinel gave `seeded by its compaction hook (epoch 49f9a483-…)` and **0** server injects.

**Live (this machine, measured 2026-11-10 20:01 UTC).** The fix merged as #3014 on 2026-11-09 21:57 PST (2026-11-10 05:57:38 UTC). Script: `scripts/context-budget/scan-compaction-paths.mjs` (read-only; entries de-duplicated by uuid, because a follow-me login switch copies a transcript into another config home).

| Window | Where | `compact_boundary` | Followed by a recovery block | Not followed |
|---|---|---|---|---|
| Before the fix | agent home (`-home-echo--instar-agents-echo`) | 47 | 0 | 47 |
| Since the fix | agent home | 3 | **3** | 0 |
| Since the fix | throwaway test projects (L7, adapter suite, probes; no Instar hook installed) | 6 | 0 | 6 (expected) |

- The 3 post-fix boundaries are all in one session (topic 141133, Claude session `0f706e54-…`), at 10:59:38 (auto, 968,913 tokens before), 13:35:32 (auto, 977,976) and 18:16:38 (manual, 468,176) UTC. The first recovery block on this machine is the 10:59:38 one.
- Before the fix the hook *did* run on compaction (51 `SessionStart:compact` attachments with exit 0 across all transcripts) but printed the startup orientation, never the marker: the bug the fix addresses.
- **Caveat (check 4):** on all 3 the block was 45.5–45.7 KB, so the model was sent a 2 KB preview and a file path. The marker line is inside the preview. "The hook ran and printed the block" is proven; "the model received the block" is not.
- Sample size: 3 compactions, one session, one machine. This is evidence the fix runs, not a rate.

## 2. Canary `healthy` with ≥ 3 synthetic positives

**Not recorded.** `GET /context-budget/sentinel` on this machine at 2026-11-10 ~19:55 UTC returned **HTTP 503** `{"error":"context-budget sentinel not enabled on this agent","enableWith":"contextBudget.sentinel.enabled"}`. `CompactionCanary.recordSyntheticPress` exists but nothing calls it, so no synthetic positive can be recorded even with the sentinel on. Pending Phase 1 S11. When it lands, the detection should also account for check 4 (a printed block is not a delivered block).

## 3. Adapter verification suite, Claude Code

**Recorded:** `.instar/state/context-budget/adapter-suite/claude-code-2.1.322.json` (agent home, Mama PC), run 2026-11-10 13:14:15 UTC, 27.9 s, `inconclusive: false`, no errors; `last-run.json` says `ok: true`.

| State | Count | Capabilities |
|---|---|---|
| supported | 12 | transcriptRead, controlCompact, controlClear, compactionDetection, preCompactionSteering, postCompactSummary (1,563-char summary), seedAfterCompaction, seedAfterClear, materialiseResume, perPromptDelta, toolPolicy, frameworkDiscriminator |
| partial | 0 | — |
| absent | 4 | spawnWithInitialContext, compactionWindowSetting, cleanStopSignals, costModel |

All four `absent` rows say "unmeasured by this suite" in their evidence; none is a measured absence. `spawnWithInitialContext` is covered by Instar's own spawn-path tests, `compactionWindowSetting` needs a full context fill (check 10), and `cleanStopSignals` and `costModel` are Instar-side, not engine probes. The suite's seeds are one-line tokens, so `seedAfterCompaction` and `seedAfterClear` being supported says nothing about size (check 4).

## 4. Delivery capacity

**Question:** can a SessionStart hook's output of 50K, 100K or 150K tokens arrive intact?
**Answer on Claude Code 2.1.322: no.** Measured 2026-11-10 20:09–20:15 UTC, Mama PC, 3 headless sessions (`claude -p`, `--model haiku`, tools off, project settings only, throwaway project under `$TMPDIR`, deleted afterwards). Script: `scripts/context-budget/hook-delivery-capacity.mjs`. The payload is a FIRST codeword line, distinct filler lines, a MIDDLE codeword at the halfway point and a LAST codeword; the model is asked for all three.

| Run | Carrier | Payload chars | Stored in transcript | Input tokens of the turn | FIRST | MIDDLE | LAST |
|---|---|---|---|---|---|---|---|
| 1 | plain stdout | 150,002 | 150,002 (`hook_success`) | 15,680 | yes | **no** | **no** |
| 2 | `additionalContext` JSON | 154,687 | 154,687 (`hook_additional_context`) | 15,691 | yes | **no** | **no** |
| 3 (control) | plain stdout | 9,490 | 9,490 | 19,015 | yes | yes | yes |

- The request for runs 1 and 2 carried `SessionStart:startup hook success: <persisted-output> Output too large (146.5KB). Full output saved to: …/tool-results/hook-…-stdout.txt  Preview (first 2KB): …`. The input token count (15.7K, about the same as an empty session) shows the rest was never sent.
- The binary agrees: `aCe(output, …, { threshold: HFe = 1e4 })` persists anything over 10,000 characters and returns the `<persisted-output>` stub with a 2,000-character preview (`eM = 2000`).
- The control run delivered 9,490 characters intact, ≈ 3,335 tokens (19,015 − 15,680).
- The 50K/100K/150K-token runs were not each repeated: a 150,000-character payload (≈ 50K tokens at the measured ≈ 2.85 chars/token for this filler) is already cut to 2 KB, and a larger one goes through the same branch.
- The same cut applies to the live recovery block today (check 1). PreCompact output has its own 10,000-character cut (check 12), which the keep-instructions writer already respects (≤ 9,000).
- Not measured: whether the model, given the file path, reliably reads the saved file unprompted. That is the only way a large seed lands through this carrier.

## 5. Hook ordering: PreCompact, PostCompact, SessionStart(compact)

What is known, with sources:

1. **PreCompact runs before the summary is generated.** Its stdout is passed to the compaction as `newCustomInstructions`; the adapter suite's steering token appeared in the summary (§3), and the cb-precompact-steer L7 summary began with the staged codeword.
2. **PostCompact runs after the summary exists** (it receives `compact_summary`; adapter suite: 1,563 chars). Claude Code's `/compact` output lists `PreCompact … completed` then `PostCompact … completed` (suite transcript `7d2004f1-…`, Mama PC).
3. **SessionStart(compact) runs before the `compact_boundary` entry is flushed** (measured on 2.1.321, `cb-one-recovery-carrier.md`; the canary allows 15 s for it).
4. **Live timings, topic 141133 session, Mama PC:**

| Compaction | SessionStart(compact) attachment | Seeded marker `seededAt` | PostCompact record `receivedAt` (server) | `compact_boundary` timestamp |
|---|---|---|---|---|
| 13:35 UTC | 13:35:31.910 | (overwritten) | 13:35:32.120 | 13:35:32.976 |
| 18:16 UTC | 18:16:38.010 | 18:16:38.005 | 18:16:38.060 | 18:16:38.094 |

(The 10:59 compaction has no PostCompact record on this machine.) So the observed order is SessionStart(compact) hook output → PostCompact received → boundary written. The PostCompact time is the server's receipt of the hook's HTTP call, not the hook's start, so this does **not** prove PostCompact *starts* after SessionStart(compact). The PostCompact slice records that its correctness does not depend on that order (`cb-post-compact.md`).

## 6. Both post-compaction paths, counted

Script: `scripts/context-budget/scan-compaction-paths.mjs`, run 2026-11-10 20:01 UTC, Mama PC. Scope: all 769 `*.jsonl` transcripts under the 10 `~/.claude*/projects` directories here (the `.lock` copies hold none). Markers:
- **hook path:** a `hook_success` attachment named `SessionStart:compact`, from `session-start.sh`, whose output has the line `=== IDENTITY RECOVERY (post-compaction) ===` (the same test as `compactionCanary.ts`);
- **server path:** a user entry (never a tool result) containing `Your session just went through context compaction`, the preamble of `buildCompactionResumePayload` / `prepareInjectionText` (`src/messaging/shared/compactionResumePayload.ts`), which `recoverCompactedSession` injects.

| Machine | Transcripts | With a boundary | `compact_boundary` | auto / manual | `SessionStart:compact` attachments | …with recovery block | Server injections | Boundary: hook only / server only / both / neither |
|---|---|---|---|---|---|---|---|---|
| Mama PC | 769 | 31 | 60 | 45 / 15 | 51 | 3 | **0** | 3 / 0 / 0 / 57 |

- Positive control for the server marker: the phrase occurs in exactly one transcript on this machine, a subagent of this build session, inside tool output (source reads); the scanner correctly did not count it. No `/tmp/instar-compaction-resume/` files exist here either. So on the Mama PC the server path has not injected into any surviving transcript; it declines unless the topic's last real message is an unanswered user message.
- Per-transcript rows: `node scripts/context-budget/scan-compaction-paths.mjs` prints one line each.
- Other machines not measured (see the header).

## 7. Topic-intent layer inventory

Script: `scripts/context-budget/topic-intent-inventory.mjs`, run 2026-11-10 20:02 UTC against the Mama PC server. Topics: every topic in `GET /telegram/topics` (82) plus every topic with a store file in `.instar/topic-intent/` (57), 100 in all. It reads `GET /topic-intent/:id/diagnostics` and `GET /telegram/topics/:id/messages?limit=100`.

It does **not** call `GET /topic-intent/:id/briefing`: that route increments the topic's `briefing_served` capture counters, so probing it would distort the funnel it reports. (One manual call was made to topic 141133 during this work before that was noticed; it returned an empty briefing and bumped that topic's counter by one.) "Briefing non-empty" uses `renderTopicIntentBriefing`'s own emptiness rule: no awareness, no tentative-or-better ref (frame or proposition) and no outstanding pending confirm ⇒ empty.

| Scope | Topics | Store file | ≥ 1 ref | Briefing non-empty | Awareness | Newest evidence < 24 h | Messages behind: 0 / 1–10 / > 10 (of topics with refs) |
|---|---|---|---|---|---|---|---|
| All | 100 | 57 | 41 | **0** | 0 | 2 | 31 / 8 / 2 |
| Active in the last 7 days | 13 | 13 | 11 | **0** | 0 | 2 | 5 / 4 / 2 |

- Every ref on this machine is at `observation` tier, so the briefing renders empty for every topic; no topic has an awareness projection. The layer captures (e.g. topic 141133: 61 refs, newest evidence 0.1 h old, 0 messages behind; topic 18330: 164 refs) but surfaces nothing.
- "Messages behind" counts messages (either direction) above the newest evidence's `sourceMessageId`, within the newest 100. Topics 139880 (25 behind) and 48153 (14 behind) are the stale ones among recent topics.
- Echo's notes place the Telegram lease on the Mac Studio (not re-verified here); this machine's topic histories may be partial for topics it does not own. A Studio run of the same script is still needed.

## 8. Asymmetry by sender

Script: `scripts/context-budget/sender-asymmetry.mjs`, run 2026-11-10 20:08 UTC, Mama PC, the 3 largest transcripts (one copy per session id). Shares of content characters; `harnessOther` (prompt snapshots, environment, skill listings, deferred-tool records — harness records, mostly not what the model reads) is excluded from the percentages and shown separately.

| Transcript (size, API requests) | Operator-typed | Hook/server-injected | Assistant prose | Thinking | Tool calls | Tool results | harnessOther (excluded) |
|---|---|---|---|---|---|---|---|
| `27ca98a8-…` (41.3 MB, 2,036) | 0.1% | 64.0% | 4.6% | 0.0% | 19.6% | 11.7% | 0.55M chars |
| `48b0023a-…` (40.5 MB, 949) | 0.0% | 18.0% | 1.1% | 0.5% | 13.6% | 66.8% | 3.09M chars |
| `0f706e54-…` (36.4 MB, 1,123) | 0.0% | 34.7% | 1.7% | 0.8% | 36.4% | 26.4% | 2.05M chars |

- The operator's words barely appear as typed user text: a Telegram message reaches a topic session as a bootstrap-file pointer whose content arrives through a `Read` (a tool result), and the third session ran autonomously with 0 operator messages in its window (topic 141133 history). So "operator-typed" is a lower bound on the human's share, and tool results include some human text. In every case the human's share is a small fraction and the agent's tools and injected context dominate, as spec §2 found on one transcript.
- In the largest transcript, the injected share is mostly Stop-hook output: 124 Stop blocking errors (3.76M chars) and 125 meta user entries (3.65M chars). Autonomous-mode stop gates are the largest single injected class there.

## 9. Per-turn token baseline

**TokenLedger cannot supply it on this machine.** `GET /tokens/summary` (2026-11-10 ~20:04 UTC) reports 8 events in the last 24 h and the ledger DB (`.instar/server-data/token-ledger.db`) holds 293 events in all. `AgentServer.ts` points the ledger at `~/.claude/projects` only, but Echo's sessions here run under follow-me config homes (`~/.claude-followme-*/projects`), so the ledger misses nearly all of them. That is a ledger gap to fix before Phase 2's measurement relies on it.

**Baseline from the transcripts instead.** Script: `scripts/context-budget/token-baseline.mjs`, Mama PC, 2026-11-10 20:06 UTC. Scope: Claude sessions in the agent-home project (worktrees and subagents excluded), merged per session id across follow-me copies, requests de-duplicated by `requestId`. A turn = one API request. Weights relative to one uncached input token: cache read 0.1, cache write 1.25 (5 min) / 2.0 (1 h), output 5.0. "Input-weighted" = uncached + writes + reads; "all-in" adds output.

| Scope (Mama PC) | Sessions | Requests | Cache read / req | Cache write (1 h) / req | Uncached / req | Output / req | **Input-weighted / req** | All-in / req | Median session, input-weighted / req |
|---|---|---|---|---|---|---|---|---|---|
| Long (> 100 requests), all time (Oct 18 – Nov 10) | 27 | 11,923 | 442,898 | 4,799 | 4 | 931 | **53,891** | 58,545 | 37,372 |
| Long, since 2026-11-03 | 15 | 5,191 | 350,274 | 3,428 | 7 | 994 | **41,892** | 46,860 | 33,065 |
| All sessions, all time | 232 | 16,794 | 364,176 | 5,599 | 4 | 864 | 47,620 | 51,941 | 46,566 |

- Cache reads are 82% (all time) and 84% (last 7 days) of the input-weighted cost on long sessions; cache writes are the rest; uncached input is negligible. No 5-minute cache writes appear: every write is a 1-hour write.
- The spec's graduation target ("down by at least half against the Phase 0 baseline") is therefore **≤ 26,946 input-weighted tokens per request on long sessions** against the all-time Mama PC figure, or ≤ 20,946 against the last 7 days. The Mac Studio baseline, where most long-topic load runs, has not been taken.
- Per-session rows: the script prints one line per long session (requests, user turns, per-request figures, model, time span, copies).

## 10. Window-setting precedence

**Not measured.** The adapter suite marks `compactionWindowSetting` "unmeasured: needs a full context fill". Procedure: on a throwaway project, set the auto-compact window by each available lever in turn (env var, user settings, project settings, per-launch flag), alone and in pairs with different values; drive a headless session with `--resume` turns that add known-size filler until `compact_boundary` appears; read `compactMetadata.preTokens` for each run; the lever whose value matches `preTokens` wins. Needs about 2 runs per lever pair at low window values (for example 50K–100K tokens) to stay cheap. For reference, live auto-compactions on this machine fired at 968,913 and 977,976 tokens (check 1).

## 11. Fold-dependent rows

| Row | Status |
|---|---|
| Fold cost per rung (9.2) | Deferred to Phase 2 entry by construction: needs the fold step runner |
| Both handoff orderings (7.2) | Deferred to Phase 2 entry by construction: needs the fold step runner |
| Rollback restore per rung, on a test agent | Deferred to Phase 2 entry by construction: needs the fold step runner |
| p99 fold duration (lock TTL base) | Deferred to Phase 2 entry by construction: needs the fold step runner |

## 12. `/clear` rotation and the PreCompact output format

- **`/clear` rotation** (`upgrades/side-effects/cb-clear-seed.md`, real Claude Code 2.1.321): `/clear` starts a **new Claude session id and a new transcript file**; the hook's stdin carries only the new id, so the clear-seed pointer is keyed on `INSTAR_SESSION_ID`. L7: the model answered the staged token `MANGO-4417` after `/clear`; negative control answered `NONE`. Re-confirmed on 2.1.322 by the adapter suite's `controlClear` and `seedAfterClear` rows. Note check 4: that L7 packet was one line.
- **PreCompact output format** (`upgrades/side-effects/cb-precompact-steer.md`, read from the 2.1.321 binary and proven live): each successful, non-blocking PreCompact hook's trimmed stdout is joined with blank lines into `newCustomInstructions`, each output cut at 10,000 characters; exit 2 blocks the compaction; in a subagent only the block is honoured. L7: the summary began `PERIWINKLE-4417`; negative control (hash mismatch) printed nothing.

## Re-running

All four measurement scripts are read-only except `hook-delivery-capacity.mjs`, which starts one real `claude -p` session per `--chars` value inside a throwaway project under `$TMPDIR`.

```
node scripts/context-budget/scan-compaction-paths.mjs [--since ISO] [--json]
AUTH=<token> node scripts/context-budget/topic-intent-inventory.mjs [--agent-home DIR] [--port 4040] [--json]
node scripts/context-budget/sender-asymmetry.mjs [--top 3] [--file PATH ...]
node scripts/context-budget/token-baseline.mjs [--since ISO] [--min-turns 100] [--json]
node scripts/context-budget/hook-delivery-capacity.mjs --chars 9500 [--chars 150000] [--json] [--model haiku]
```

Running the first four on the Mac Studio, Mac Mini and Mac M5 Pro completes the per-machine tables.
