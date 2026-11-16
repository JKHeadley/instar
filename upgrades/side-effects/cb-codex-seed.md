# Side-Effects Review — Codex next-prompt seed and the Codex adapter verification suite (Phase 1 S17)

**Version / slug:** `cb-codex-seed`
**Date:** `2026-11-10`
**Author:** `Echo (builder session, Opus 5.5)`
**Second-pass reviewer:** `Fable reviewer subagent (see below)`

## Summary of the change

This is Phase 1 slice S17 of `docs/specs/context-budget-layered-summaries.md`:
- §9.6, the Codex column: "the real carrier is the `UserPromptSubmit` hook, which delivers the standing packet on the first prompt after a detected compaction … seed by next-prompt delivery, disclosed in the packet marker";
- §9.1, the seeded marker and context epoch, and the canary;
- §16, the Phase 1 end condition: "Ends when the Codex suite has a recorded result".

The branch carries S16 (Codex detection), cherry-picked onto S10 (the standing packet). The conflicts were additive and were unioned. That commit is `711a4c354`.

What S17 builds:

1. **The Codex next-prompt seed** (`src/monitoring/contextLayers/codexSeed.ts`).
   - **When it fires.** On a Codex prompt that names a topic, the installed per-prompt hook (`telegram-topic-context.sh`, the same hook on both engines) calls `POST /context-budget/codex-seed` with the hook payload's `session_id` and `transcript_path`. That call happens only when `INSTAR_FRAMEWORK=codex-cli`.
   - **What the server reads.** The server reads that session's rollout incrementally and only reads it. The newest engine-written `compacted` entry after the rollout's first usage reading is the compaction, so a fork's inherited copies never count. Its `window_id` is the **context epoch**.
   - **What it returns.** If the rollout shows that epoch not yet seeded, and the request comes from the topic's own live Codex session on its first topic prompt after the compaction (one retry), the server builds, verifies and stages the topic's standing packet now, through S10's `stageNow`. It returns the packet with a disclosure header saying that it is delivered with this prompt because Codex has no post-compaction seed hook. The delimited packet body keeps S10's nonce = sha256 rule.
   - **What the hook does.** The hook prints the packet in place of the topic briefing and recent history for that one prompt (§7.7: never the packet and the briefing both). It then calls `POST /context-budget/codex-seed/ack`.
   - **The marker.** The acknowledgement writes the seeded marker, `_seeded/<sessionId>.json`, with `engine: codex-cli`, `delivery: next-prompt`, and a bounded history of the epochs seeded. The ack is checked against the rollout's newest epoch. The marker is a record, for the future §7.7 delta hook. It is not what decides "already seeded".
   - **"Already seeded" is read from the rollout.** Codex records the hook's output as a developer message, which is model input. An epoch is seeded once a developer message carrying the seed header follows its `compacted` entry.
   - **Guarantees.** A seed the model received is never repeated. A delivery Codex dropped (the hook killed, the output discarded) is retried on the next topic prompt, once. A compaction more than one earlier topic prompt old is never seeded. The current prompt is excluded by its sha256, because it may or may not be written before the hook runs. An unverified packet is never returned, writes no marker, and the topic backs off for 5 minutes. `GET /context-budget/codex-seed` returns counts.
2. **The canary verifies Codex recovery** (`compactionCanary.ts`).
   - **The profile.** The `codex-cli` profile is now `recoveryVerifiable: true`, with `recoveryArtifacts: 'next-prompt-seed'` and `positiveControl: false`.
   - **The recovery artifact is transcript evidence.** It is the seed as the model received it: a developer message whose line is the seed header, after the `compacted` entry. New parser kinds are `seed` and `prompt`; `prompt` excludes Codex's own `<…>` context blocks and flags whether the prompt names a topic. The marker never counts, so a marker with no seed in the rollout still settles `diverged` (tested).
   - **Waiting and settling.** A Codex detection waits for the next TOPIC prompt, the only kind the hook seeds, however long that takes. It settles `CODEX_SEED_GRACE_MS` (2 minutes) after that prompt: seed seen means complete, none means diverged. A compaction followed by another before any topic prompt is marked `superseded`: no carrier ever came, so it is judged neither way.
   - **No PostCompact requirement for Codex.** The engine exposes no summary to record.
   - **Never healthy.** A Codex group stops at `accruing`, because §9.1 `healthy` needs a synthetic positive control and Codex has no control-command inject.
   - **What stays synthesized.** The 85% signal and the post-compaction event stay `synthesized`, and the group's `marking` still says `synthesized`.
   - **Claude Code is unchanged.** An engine with no profile still reads `counted`.
3. **`runCodexAdapterSuite`** (`src/monitoring/codexAdapterSuite.ts`). This is the §9.6 suite for Codex. It reuses the Claude Code suite's machinery: the capability rows, `AdapterSuiteResult` (engine widened to include `codex-cli`), `writeSuiteResult` and `readSuiteResults`, the inconclusive-never-recorded rule, and `adapterSuiteCli` (new `--engine=codex-cli` mode, with a separate `last-run-codex-cli.json`).
   - **The throwaway.** One throwaway headless thread in a fresh git project under the OS temp directory.
   - **Refusals.** The suite refuses when the environment carries a channel-topic binding, when the work directory is inside an agent project (`.instar/config.json`), or when the account home has user-level hooks (`hooks.json`, or inline `[hooks.*]` tables in `config.toml` other than the `[hooks.state]` trust table).
   - **Inconclusive, never recorded.** An environment failure on any step, including the restore resume, makes the run inconclusive. Per-call timeout is 90 s, so six calls fit the CLI's 10-minute kill.
   - **Delivery is judged from the rollout.** Rows that say "in the model's input" are judged there. The model's own reply is collected as corroboration only: asked to list the tokens in its context, it did not echo the hook notes. The per-prompt row checks the full 7,000-character probe text byte for byte.
   - **The probe hooks.** They are authored by the suite and run under `--dangerously-bypass-hook-trust`. Codex has no non-interactive trust step, and the refusal above prevents user hooks from riding along.
   - **What it presses.** A real compaction, pressed with `-c model_auto_compact_token_limit` on one resume. A copied-rollout restore. A PreToolUse deny.
   - **Judging.** What the model received is judged from the rollout.
   - **Trigger.** The sentinel gains a `codexAdapterSuite` trigger with the same rule as Claude Code's: one run per unrecorded engine version, keyed per engine (`codex-cli@<v>`), one run at a time across engines. It is wired in `server.ts` under the existing `contextBudget.adapterSuite.enabled` switch, the `contextBudget.enabled` dev gate, and a detected codex binary.
   - **Cleanup.** The CLI removes the one throwaway trust table Codex writes into `config.toml`.
4. **The suite was run for real once** on this machine: Codex CLI 0.167.1, recorded, not inconclusive. The result is in `docs/specs/reports/context-budget-codex-adapter-suite.md` and `.result.json`: 8 supported, 3 partial, 0 synthesized, 5 absent (4 of them unmeasured).
5. **Agent awareness.**
   - A CLAUDE.md template Registry-First row, plus an idempotent `migrateClaudeMd` insert.
   - The sentinel row's `counted` example no longer names Codex: the template text and S16's insert and refresh strings are updated, and a new idempotent refresh handles agents that already hold S16's wording.
   - The CapabilityIndex description.
   - The routes are documented in `site/src/content/docs/features/memory.md`.
   - The `feature-delivery-completeness` allowlist entry.

Files:
- `src/monitoring/contextLayers/codexSeed.ts` (new)
- `src/monitoring/codexAdapterSuite.ts` (new)
- `src/monitoring/CodexRolloutParser.ts`
- `src/monitoring/compactionCanary.ts`
- `src/monitoring/ContextBudgetSentinel.ts`
- `src/monitoring/contextBudgetSentinelBoot.ts`
- `src/monitoring/adapterSuiteCli.ts`
- `src/monitoring/adapterVerificationSuite.ts`
- `src/server/routes.ts`
- `src/server/CapabilityIndex.ts`
- `src/core/PostUpdateMigrator.ts`
- `src/scaffold/templates.ts`
- `src/commands/server.ts`
- tests
- the docs page and the report

## Decision-point inventory

- **Whether a Codex prompt carries the seed** (`CodexSeedService.offer`) — add. Deterministic. Codex framework, newest post-usage `compacted` epoch, not yet seeded, packet verified.
- **What the per-prompt hook prints** (`telegram-topic-context.sh`) — modify. The seed in place of the briefing and history, only when the server returns `deliver: true`. Otherwise exactly today's output.
- **When the seeded marker is written** (`CodexSeedService.ack`) — add. Only after the hook printed, and only for the rollout's current epoch.
- **The canary's Codex state** (`report`) — modify. `counted` becomes uninitialized, accruing or diverged, never healthy.
- **Whether the Codex suite runs** (`ContextBudgetSentinel.maybeRunAdapterSuite('codex-cli')`, `throwawayTargetProblem`) — add.

---

## 1. Over-block

No block/allow surface on messages, sessions or tools. The only "refusals" are listed below. Each falls back to today's behaviour, or to no run:
- **Seed not delivered.** A packet that fails verification is not delivered, for example when an operator row was edited after U recorded it, or deleted under privacy. That prompt gets today's briefing, and the canary reads that compaction `diverged` until a later epoch is seeded. This is the right direction, and it is the same rule S10 applies to Claude Code.
- **Suite refused.** The suite refuses to run when launched from a process bound to a topic. That was observed for real: this builder's own shell, on topic 141133, was refused. It also refuses when the account home has a `hooks.json`. The server's sentinel has no topic variables, so it is not refused. An operator who keeps user-level Codex hooks gets no Codex suite result. That is recorded as inconclusive with the reason, never as a pass.

---

## 2. Under-block

- **A mid-turn compaction is seeded only on the NEXT user prompt.** Between the compaction and that prompt, the model continues on Codex's own replacement history. This is the spec's design (next-prompt delivery). The suite measured that `SessionStart(source=compact)` fires on 0.167.1, which is a closer carrier (see Gaps).
- **A non-topic Codex prompt** (no `[telegram:N]`) exits before the seed block, as today. The seed waits for a topic prompt.
- **A prompt that names a different topic than the session's** would be seeded with that topic's packet. The same is true of today's briefing, which is fetched by the prompt's topic id. No new exposure: bearer-only, local.
- **A truncated delivery.** If Codex truncated the printed packet, the seed header would still be in the rollout and the canary would count the compaction recovered. The suite measured a 7,000-character delivery recorded byte-whole, which is larger than the delivered packet's 6,000 budget, and the suite re-measures this on each new Codex version.
- **A non-topic prompt after a compaction is not seeded.** Examples are an injected continuation or a plain CLI prompt; the hook exits before the seed block. The canary therefore waits for a topic prompt, and the seed arrives on that one.
- **On Codex 0.167.1 the first prompt after a compaction also carries today's legacy recovery block.** `session-start.sh` execs `compaction-recovery.sh` for non-Claude engines on `source=compact`, and that already fired before this slice. So that prompt sees the legacy block and the packet. Topic context is duplicated, but nothing is lost. <!-- tracked: CMT-1536 -->

---

## 3. Level-of-abstraction fit

- **The seed decision** lives in the context-layers module next to the standing packet, and reuses S10's `stageNow`. The verifier and staging are unchanged, so there is no second packet path.
- **The rollout reading** reuses S16's `classifyCodexRolloutEntry` and the fork guard. No second rollout parser.
- **The marker** reuses `seedMarkerPath`, the same file location as the Claude Code compact seed.
- **The hook** only transports. The judgment is server-side, as the 5 s / prompt hooks should be.
- **The suite** reuses the Claude Code suite's capability list, result schema, store, inconclusive rule, CLI process isolation and sentinel trigger. Only the engine driving and the evaluator are Codex-specific.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The seed decides which existing delivery a prompt gets: the verified packet, or today's briefing. The canary only records. The suite only measures, and its refusal guard protects a channel topic from being used as a probe target (§9.6 "never a channel topic").

---

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point:
- "Newest post-usage `compacted` entry is the epoch" is an engine invariant (measured in S16, re-measured here).
- "First real prompt" excludes Codex's tagged context blocks. That is an engine invariant: those blocks are `<…>`-wrapped.
- The 2-minute seed grace bounds observation only. The hook prints and acks within seconds.
- The 5-minute packet backoff bounds rebuild cost only.
- The suite's evaluator maps measured evidence to states, as the Claude suite's does.

---

## 5. Interactions

- **Claude Code.** The hook's seed block is gated on `INSTAR_FRAMEWORK=codex-cli`; tested, the route is never called for claude-code. The Claude compact seed and `readSeedMarkerFile` are untouched. A Codex marker lives under the Codex session id, a different file. The canary's Claude branch is unchanged, and a Codex marker never stands in for a Claude artifact (tested).
- **§7.7 delta hook.** Not built yet. When it is, its "seeded marker for the epoch" key is this marker, which carries `epoch`.
- **S10 stager.** The offer calls `stageNow`, which restages the topic. That is equivalent to a layer commit: idempotent, and it rewrites keep-instructions only for Claude Code sessions.
- **The sentinel.** The seed itself does not need the sentinel: it reads the rollout on request. The canary's verification does need it, and it is dark by default, as S16 noted. Suite triggers share one `suiteRunning` flag, so at most one engine run at a time (tested). The Claude Code attempts keys are unchanged (bare version). Codex keys are prefixed.
- **Races.** Marker writes are tmp-then-rename. Two prompts racing on one epoch can both get the packet, because neither seed is in the rollout yet; the second ack is a no-op. The `config.toml` cleanup writes through a symlink to its target, and skips the rename when the file changed between its read and its write. The reader cache is per server process, bounded at 500 rollouts.

---

## 6. External surfaces

- **New routes:** `POST /context-budget/codex-seed`, `POST /context-budget/codex-seed/ack`, `GET /context-budget/codex-seed`. All bearer-only. They return 503 while the layers are off. Documented in `site/src/content/docs/features/memory.md`, the CapabilityIndex, and the CLAUDE.md row.
- **Changed status:**
  - `GET /context-budget/sentinel`: the Codex canary group reads `uninitialized`/`accruing`/`diverged` instead of `counted`, and its profile gains `recoveryArtifacts` and `positiveControl`. Detections gain `promptAfterAt` and `seededCarrier`.
  - `adapterSuite.codex` is `{ wired, engineVersion, lastRun }`.
- **Installed files:** `telegram-topic-context.sh` (always overwritten by `migrateHooks`; `init` uses the same generator) and CLAUDE.md (idempotent inserts and refreshes).
- **Persistent state:** `state/context-layers/_seeded/<codexSessionId>.json` (0600); `state/context-budget/adapter-suite/codex-cli-<v>.json` and `last-run-codex-cli.json`.
- **Engine side effects of a suite run:** one throwaway thread's rollouts (plus one restored copy) in the account home's `sessions/`; one trust table in `config.toml`, removed after the run (verified by a before/after diff on this machine); model calls on the account (6 per run).
- **Operator surface:** none.

---

## 6b. Operator-surface quality

No operator surface. Not applicable.

---

## 7. Multi-machine posture

**Machine-local by design.**
- A Codex session's rollout and its prompts live on the machine that runs it. Its hook calls that machine's server (localhost), and the marker is written in that machine's state.
- A topic that moves gets a new session on the new machine, whose rollout starts its own epochs. There is no stranded state: the old machine's marker names the old session.
- Suite results are keyed `(machine, engine, version)`, as the Claude suite's are.

**Status surfaces:** `GET /context-budget/codex-seed` and `GET /context-budget/sentinel` report this machine only. Each suite result and canary group names its machine.

---

## 8. Rollback cost

Pure code. Revert and ship a patch.
- **Live kill switch:** `contextBudget.enabled: false`. The layers turn off and the routes return 503, so the hook prints exactly today's output on the next prompt. The canary drops Codex transcripts on its next tick (S16).
- **The suite:** `contextBudget.adapterSuite.enabled: false` stops it.
- **Leftovers after a revert:** marker files and suite results are ignored by older code. The template rows would remain as harmless text.

---

## Conclusion

S17 completes the Phase 1 Codex adapter bullet of §16:
- the `trackContextUsage` caller and the post-compaction producer (S16);
- `UserPromptSubmit` seed delivery (this slice);
- the verification suite, run and recorded.

The recorded run turned up something the spec did not anticipate: Codex 0.167.1 has `PreCompact`, `PostCompact` and `SessionStart(source=compact)` hooks, a usable compaction-window setting, and a working rollout restore. The spec's "as the code stands today" column is stale on six rows. The suite records the measured states, as §9.6 directs.

**Spec amendments needed. Recorded here; not edited, because the approved spec is not changed by a build slice:**
- §9.1's state list should add `counted` (S16's request) and `accruing`, which was pre-existing.
- §9.1 should say a Codex group stops at `accruing` until a Codex positive control exists. `model_auto_compact_token_limit` on a throwaway thread is a working press, measured here.
- §9.6's Codex column should cite the recorded result for the six rows that measured better.

**Gaps:**
- (a) Moving the packet onto `SessionStart(compact)` for Codex versions where the suite records it `supported`, which would remove the legacy-block duplication on the first prompt. <!-- tracked: CMT-1536 -->
- (b) A Codex synthetic press for the canary. <!-- tracked: CMT-1536 -->
- (c) The live agent's suite store is written by the sentinel once deployed with both switches on. This builder works only in its worktree, so the recorded result is in the report and `.result.json`. <!-- tracked: CMT-1536 -->

---

**Neighbour-suite fixes (after review).** The neighbour unit set (every `tests/unit` file naming a touched module) turned up four ratchets. Each is fixed here:
- `write-domain-conformance`: the two new POST routes are classified `machine-local` in `WriteDomainRegistry` (`per-machine-path`, git-ignored state, as `/hooks/post-compact` is).
- `no-silent-fallbacks`: 497 against a baseline of 494. That was the three new catches in this branch's earlier slices: S10's route catch and RF's prune and save catches in the fit script. They are annotated `@silent-fallback-ok` with reasons. This slice's own catches are annotated too.
- `keyword-intent-decision`: two earlier-slice files are allowlisted with justifications. `standingPacket.ts` checks its own rendered stamps, and `chunkBuilder.ts`'s list is an internal trigger enum. Neither reads user text.
- `claude-md-reference-layout`: the CLAUDE.md core budget was 80,731 against 80,000. The Codex seed row is cut to one line. The sentinel row's `counted` wording is shortened to "recovery unverifiable, never healed by injection; Codex stops at `accruing`". S10's standing-packet row loses one parenthetical, identically in the template and the migration.

## Second-pass review (if required)

**Reviewer:** Fable second-pass reviewer
**Independent read of the artifact: concern**

No blocks-now finding. Three majors, all about what the evidence proves rather than a wrong code path; the slice is dev-gated and observation-only (nothing consumes `diverged`). I read the spec sections, the full diff and the new modules, and the live run's own rollout (`~/.codex/sessions/2026/11/10/rollout-…-01a1c8e9-….jsonl`); I ran no tests and no engine calls.

Confirmed sound: once-per-epoch and lost-ack re-delivery (`codexSeed.ts:206,226`); the fork guard matches the canary's (`codexSeed.ts:96`, `compactionCanary.ts:432`); session-id keying is the same on both sides; Claude Code's canary branch and hook output are unchanged (`HOOK_INPUT=$(cat)` is byte-equivalent for JSON, the seed block is gated on `INSTAR_FRAMEWORK`, `PostUpdateMigrator.ts:21234,21311`); the hook's shell and Python quoting is safe; never `healthy` without a positive control (`compactionCanary.ts:495`); engine-scoped trigger and one run at a time (`ContextBudgetSentinel.ts:353-374`); the three CLAUDE.md row variants converge and are idempotent (`PostUpdateMigrator.ts:16060-16078,16124`). The live rollout shows the pre-turn order `compacted` → SessionStart(compact) note → user prompt → UserPromptSubmit output, so the seed does land on the very prompt that follows a pre-turn compaction.

1. **major — the canary's Codex "recovered" is the hook's own acknowledgement, not transcript evidence.** §9.1 counts "recovery blocks in the transcript", independent of the path under test. `compactionCanary.ts:321-327` reads only the marker that the hook-and-route path writes. The suite proved Codex records hook output as a developer message in the rollout, so the canary could look for `CODEX_SEED_HEADER` after the `compacted` line; the comment at `codexSeed.ts:44` says it does, and it does not. As built, "complete" means "the server was told the hook printed".
2. **major — a marker can be written for a seed the model never got.** The hook allows 4 s for the offer and 2 s for the ack (`PostUpdateMigrator.ts:21319,21340`) on top of the earlier curls, against a registered timeout of `5000` (`installCodexHooks.ts:68-73`; if that is 5 s the budget is exceeded by design). A hook killed during the ack curl can still land the ack server-side while Codex discards the output: a loss, not the "duplicate, never a loss" the artifact states. Finding 1's transcript check would close it; so would bounding offer plus ack under the hook timeout.
3. **major — two suite rows say "reached the model" on rollout presence alone, and the run's one behavioural probe disagreed and was discarded.** Step 5 asks the model to list every token in its context; the reply in the live rollout is `ALPHA-7144 DENY-9666 WORD-1234`, with neither the SEED nor the DELTA token, and the code drops it (`void r5`, `codexAdapterSuite.ts:367`). `seedAfterCompaction` and `perPromptDelta` are judged only by `developerMessageAfter` (`:207,:327,:360-361`). Token counts in the rollout do corroborate delivery (input grows about 940 tokens per turn, the size of one probe note), so the rows are probably true, but the report and §2 of this artifact should say "recorded in the model's input history; the model did not echo it", or the evaluator should use the reply. Also "whole at 7,000" checks only the first 200 pad characters and the trailing token (`:327`), which a head-and-tail truncation passes; the rollout line is in fact 7,002 characters, so this run is fine and the check is weak.
4. **minor — a non-topic prompt after a compaction settles the detection as `diverged`.** The hook exits before the seed block without a `[telegram:N]` prefix (`PostUpdateMigrator.ts:21253`), while the canary counts any real user prompt (`compactionCanary.ts:413`). Injected or continuation prompts on a topic session therefore read `diverged` until a topic prompt seeds. Honest, but §2 does not connect it to the canary.
5. **minor — step 6 records an environment failure as a capability.** A non-zero exit of the restored resume is `refused` ⇒ `absent` with no error pushed (`codexAdapterSuite.ts:378-379`), so a quota or network failure is recorded for that version and never re-run, against the suite's own inconclusive rule.
6. **minor — rollout path validation is shape-only.** Any absolute path with a `sessions` segment and the right basename is read (`codexSeed.ts:56-66`); it is not held to a Codex home. With the bearer and such a file, the offer returns any topic's packet words and restages that topic, and the ack overwrites `_seeded/<id>.json` for any id (`:141-156`). No new exposure for a bearer holder; worth a containment check.
7. **minor — the offer never checks "first prompt after".** Any unseeded newest epoch seeds, however old (`codexSeed.ts:204-206`), so on enabling, each Codex topic session with a historical compaction gets "Your context was compacted" in place of its briefing once. After a server restart the reader re-reads up to 32 MB synchronously on the request (`:42,:80`).
8. **minor — `removeThrowawayProjectTrust` rewrites the live `config.toml`** read-modify-write with no lock (`codexAdapterSuite.ts:392-407`): a concurrent Codex write in that window is lost, a symlinked config becomes a regular file, and a run killed at 10 minutes (six calls at up to 240 s each can exceed it) leaves the table. The user-hooks refusal checks only `hooks.json` (`:172`), not hooks declared elsewhere in the account home.
9. **minor — canary wording.** A Codex group with detections all waiting reads `uninitialized` (`compactionCanary.ts:491`), which §9.1 defines as zero detections; an epoch superseded before any prompt stays pending for good. The CLAUDE.md rows say no test compaction "can be pressed" on Codex (`templates.ts:1355,1360`), while this slice's own report measured one; "is wired yet" is the true wording.
10. **minor — a handed-over gap is dropped silently.** S16's review asked S17's suite to confirm the fork's own-meta-first ordering (`cb-codex-detect.md:161`); the suite does not exercise a fork and the artifact does not say so. `compactionDetection` also reads `supported` when `window_id` is missing (`codexAdapterSuite.ts:98-101`), so it is not the rename drift check S16 expected.

**Builder response (round 1)** — every finding addressed in code or wording. After the fixes the suite was re-run live, and the recorded result is the re-run.
- **1 (fixed).** The canary's Codex recovery artifact is now transcript evidence: the parser's new `seed` kind, a developer message carrying the seed header after the `compacted` entry. It never reads the marker; the marker read was removed from `compactionCanary.ts`. The comment in `codexSeed.ts` now matches. Tested: "the marker alone is not recovery".
- **2 (fixed).** "Already seeded" is decided from the rollout, not the ack, so a dropped delivery is retried on the next topic prompt. The hook's offer and ack timeouts are now 3 s and 1 s. The Codex `timeout` unit is still not confirmed; with the rollout as the record, it no longer decides correctness. Tested: "a delivery the model never got … is retried once".
- **3 (fixed).** The step-5 reply is kept (`afterCompactReply`), and the evidence says whether the model echoed the token. The rows now say "in the model's input (a developer message in the rollout)", and the report explains how to read that. The 7,000-character check matches the full probe text. Re-run result: the same 16 states; the model did not echo, which is recorded.
- **4 (fixed).** The canary settles only on a prompt that names a topic, and the parser flags `topic`. Tested.
- **5 (fixed).** A non-zero restore resume is now an engine error, so the run is inconclusive. Only an explicit not-found reads `refused`.
- **6 (fixed).** The offer requires `sessionBound`: the request's session must be the topic's live Codex session in the session manager (route wiring in `routes.ts`). The ack still needs the rollout's current epoch. Tested in unit and integration (`not-this-topic-session`).
- **7 (fixed).** Only the first topic prompt after the compaction gets the seed, with one retry (`MAX_EARLIER_PROMPTS = 1`; the current prompt is excluded by sha256). A historical compaction is not seeded when the layers are switched on. Tested. The 32 MB first read after a restart is bounded by `MAX_READ_BYTES`, once per rollout; left as is.
- **8 (fixed).** The cleanup writes through a symlink to its target and skips when the file changed between read and write. The per-call timeout is 90 s, so six calls fit the 10-minute kill. The refusal also covers inline `[hooks.*]` tables in `config.toml` (`[hooks.state]` excepted).
- **9 (fixed / kept).** A Codex epoch superseded before any topic prompt is now `superseded` and judged neither way (tested). The rows now say no test compaction "is wired for Codex yet". An all-pending group reading `uninitialized` is kept: it is the canary's existing rule for every engine (Claude Code within its grace reads the same), and changing it belongs with the §9.1 amendment recorded above.
- **10 (disclosed / fixed).** The fork case is not exercised by the suite, and the row's evidence now says so. `compactionDetection` reads `partial` when a `compacted` entry lacks a `window_id`, so it is the rename drift check S16 expected.

**Round 2: concur** — resolution check of the ten findings against the current code, by reading only (no tests or engine calls run by me).
- **1 resolved.** The canary's Codex recovery is the seed header in a developer message after the `compacted` entry (`CodexRolloutParser.ts` `seed` kind; `compactionCanary.ts:410-424`); the marker read is gone, and "the marker alone is not recovery" is tested (`tests/unit/codex-seed.test.ts:230`).
- **2 resolved.** "Already seeded" is read from the rollout (`codexSeed.ts:118,238`), so a dropped delivery is retried once (`:242`, test `:99`); the hook's bounds are 3 s and 1 s (`PostUpdateMigrator.ts:21324,21345`). The marker can still be written for an undelivered seed, and the ack is not session-bound (`codexSeed.ts:254-265`): nothing reads it for a verdict now, so the later §7.7 delta hook must not treat it as proof of delivery.
- **3 resolved.** The step-5 reply is kept and reported (`codexAdapterSuite.ts:121,381`), the delta check matches the full probe text in a developer line (`:340`), and the re-run result records "the model did not echo it".
- **4 resolved.** Only a topic prompt starts the settle grace (`compactionCanary.ts:416`), with the same `[telegram:N]` test the hook uses.
- **5 resolved.** A non-zero restore resume is an error, so the run is inconclusive; only an explicit not-found reads `refused` (`codexAdapterSuite.ts:393-395`).
- **6 resolved.** The offer requires the topic's live Codex session (`codexSeed.ts:233`, `routes.ts` `sessionBound`; test `:123`). The path check itself is still shape-only, which the binding makes moot for the offer.
- **7 resolved.** `MAX_EARLIER_PROMPTS = 1` with the current prompt excluded by hash (`codexSeed.ts:57,241-242`). If the hook's hash ever differs from the rollout's text hash, only the one retry is lost, never the first delivery. The 32 MB first read is kept as stated.
- **8 resolved.** The cleanup edits a symlink's target and skips on a changed mtime or size (a check, not a lock, which is enough here); six calls at 90 s plus the version call fit the 10-minute kill (`codexAdapterSuite.ts:265`); inline `[hooks.*]` tables refuse the run (`:180-183`).
- **9 resolved / accepted.** `superseded` is judged neither way (`compactionCanary.ts:450,490`; test `:239`); the rows say "is wired for Codex yet" in the template and all four migration strings. Keeping `uninitialized` for an all-pending group is accepted with the §9.1 amendment.
- **10 resolved.** The fork gap is stated in the row's evidence (`codexAdapterSuite.ts:105`) and a missing `window_id` reads `partial` (`:102`).
- **Left over, none blocking:** comments that still call the marker the artifact (`compactionCanary.ts` at `CODEX_SEED_GRACE_MS` and the `codex-cli` profile; the route comment in `routes.ts` saying a lost ack re-delivers); the unit of the Codex hook `timeout` is still unconfirmed.

The artifact's other claims match the code, including the disclosed legacy-block duplication and the leftover rollouts in the account home.

---

## Evidence pointers

- **Live suite run:** `docs/specs/reports/context-budget-codex-adapter-suite.result.json` (Codex 0.167.1, machine `m_e8c9b243c449b1337713bc29d47a6f3a`, 2026-11-11T05:09:08Z, 47.7 s, 0 errors). The refusal positive control is quoted in the report.
- **Unit:** `tests/unit/codex-seed.test.ts`, `tests/unit/codex-compaction-channel.test.ts`, `tests/unit/ContextBudgetSentinel.test.ts`, plus the neighbour set.
- **Integration:** `tests/integration/context-budget-codex-seed-route.test.ts`, `tests/integration/context-budget-sentinel-route.test.ts`.
- **E2E:** `tests/e2e/context-budget-codex-seed-alive.test.ts`, `tests/e2e/context-budget-codex-canary-alive.test.ts`.

## Class-Closure Declaration (display-only mirror)

Not a defect fix in an agent-authored artifact; it is a new capability. Because it adds a self-triggered action (the Codex adapter-suite trigger), the trace declares `unbounded-self-action` with closure `guard`, citing `tests/unit/self-action-convergence.test.ts` (ratchet). The trigger is the already-registered `context-budget-adapter-suite` controller: `maybeRunAdapterSuite`, now per engine, with the same brakes. It runs once per unrecorded (engine, version), writes a durable attempt stamp before the run, waits at least 24 h between retries, gives up after 3 attempts, and runs one suite at a time across engines.
