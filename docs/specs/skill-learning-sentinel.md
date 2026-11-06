---
title: "Skill Learning Sentinel — procedural memory: repeated requests become skills that earn their keep"
slug: "skill-learning-sentinel"
author: "echo"
status: draft
parent-principle: "Never-Waste Feedback — corrections compound"
lessons-engaged: "Structure beats Willpower; Verify the State, Not Its Symbol; Signal vs. Authority; An Instar Agent Is Always a Multi-Machine Entity; Never Silently Cut the Data a Decision Depends On; Maturation Path; Decision Provenance & Outcome Review; Know Your Principal — An Unverified Identity Is a Guess; Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: "docs/specs/skill-learning-sentinel.eli16.md"
topic: 139880
ships-staged: true
rollout-flag-path: monitoring.skillLearning.enabled
supervision: tier1
run-boundaries: "Run A = slices 0+1 (observe, draft to proposals, measure, v1 review; ends at the rung-1 operator sample); Run B = slices 2+3 (live writes, patches, retire)"
amends-spec:
  - skill-concept                              # specs/instar-concepts/skill.md — canonical SKILL.md + parity (writer side; lands its deferred backfill)
  - correction-preference-learning-sentinel    # same recurrence-gate shape; this is its procedural twin
review-convergence: "2026-11-06T18:59:04.824Z"
review-iterations: 6
review-completed-at: "2026-11-06T18:59:04.824Z"
review-report: "docs/specs/reports/skill-learning-sentinel-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 29
cheap-to-change-tags: 22
contested-then-cleared: 5
---

# Skill Learning Sentinel

> Preferences are *how the user likes things*. Memory is *what I know*. This is the missing third leg of
> coherence: *how I do things*, learned from the user's own repeated requests, written down once, done the
> same way every time, and improved from corroborated evidence instead of from the model's opinion of itself.

Operator request (Justin, Telegram topic 139880, 2026-11-06 10:12 PST): *"Some sort of job or sentinel that
intelligently assesses various user requests and creates skills that allow the agent to repeat processes and
actions tuned to the users preferences/needs AND allows the agent to tune and improve the skills in an ongoing
manner. This should all happen automatically without the user needing to know. … this process should help the
agent stay consistent, which is a HUGE part of coherency."*

## 1. Problem statement

A user who asks for the same kind of thing on Monday, Thursday and the next Tuesday gets three different
procedures, because each session re-derives the procedure from scratch and the only carrier between sessions is
whatever a session happened to write to memory. The user's corrections on Monday's run are invisible on
Thursday. The agent is inconsistent in exactly the place consistency is cheapest: work it has already done well.

Instar has a skill primitive (a markdown procedure, discoverable as a slash command and auto-triggered by its
description), but every skill is hand-written. Nothing today:

1. **notices** that a request recurs across topics and sessions;
2. **writes** a skill from the runs of that request that went well, carrying the corrections from the runs that
   did not;
3. **measures** whether a skill is actually working (every skill use is logged; nobody reads the log, and the
   log is broken — see §2);
4. **improves or retires** a skill from that measurement.

The only mechanism is one line in the agent's instructions ("user describes a workflow they repeat → suggest
creating a skill"). That is willpower. This spec makes it structure.

### 1.1 What Hermes Agent does, and the failure modes to design out

Verified against the Hermes "Skills System" documentation (hermes-agent.nousresearch.com, read 2026-11-06):
a system-prompt line asks the model to record any non-trivial workflow with a `skill_manage` tool; a background
review after a turn can suggest or stage skill changes; a curator consolidates the library; writes need no
approval by default; skills are `SKILL.md` files on the agentskills.io standard (the same shape as Instar's
canonical skill); a progressive-disclosure index sits in the system prompt. Practitioner reports (2026): two to
four auto-created skills a day; a consolidation pass that merged seven skills into one and deleted the
originals; skills graded by the same model that wrote them; overlapping skills loading conflicting guidance.

| Hermes failure mode | Rule here | Mechanism |
|---|---|---|
| Creates after any complex task → sprawl | Create only on **recurrence** of an operator request | §3.3 gate |
| Self-graded by the author model | Grade by **corroborated outcome evidence**; every version (v1 included) reviewed by a **different model family** | §3.6, §3.7 |
| Destructive merge / delete | **Never merge, never delete**; retire to a recoverable folder; versions kept; bounded per-version auto-revert | §3.8 |
| Prompt bloat from an ever-growing index | Per-skill and total **byte caps**, library cap, retirement | §3.9 |
| Overlapping skills | Dedupe before drafting; fold into an existing *learned* skill as a patch; hand-written skills are never patched | §3.5 |
| Silent quality loss | **No-regression metric** on corroborated outcomes, with `unknown` excluded and coverage reported | §7 |
| Untrusted text becomes standing instructions | Only the **operator's verified** messages and the agent's **tool-call outline** feed a draft; never tool results, never forwarded text | §3.1, §3.5 |

## 2. What already exists — extend, do not duplicate (verified in this session, with the defects found)

| Component | Where | State today | How this spec uses / fixes it |
|---|---|---|---|
| Skill primitive, canonical format, parity rule | `specs/instar-concepts/skill.md` (approved 2026-05-19); `src/providers/parity/rules/skillParityRule.ts` | Canonical `.instar/skills/<name>/SKILL.md` rendered to `.claude/skills/` and `.agents/skills/`; `x-instar-stamp`; `remediate()` refuses on user-edit conflict. **Defects:** the backfill the concept spec deferred (`migrateSkillsCanonicalBackfill`) never shipped — `.instar/skills/` is absent on this agent (35 skills live only under `.claude/skills/`); `migrateParityRenderings` skips with "no canonical instances found"; `FrameworkParitySentinel` is never constructed outside its own file, so nothing re-renders at runtime; `.claude/skills/` is outside `stateDir`, so renderings never git-sync. The parity rule is a structural no-op. | Slice 0 lands the backfill; **every machine** reconciles renderings from synced canonical (§3.2). `skill.md` gets a note that its "initial scan backfills" claim was never carried. |
| Skill usage telemetry hook | `getSkillUsageTelemetryHook()` in `src/core/PostUpdateMigrator.ts` (always overwritten by `migrateHooks`, `:7524`) → `.instar/skill-telemetry.jsonl` | PostToolUse on the Skill tool. **Defects:** writes raw `args` into JSON via shell `echo` with no escaping (8 of 51 rows on this agent are unparseable); `session_id` is `INSTAR_SESSION_ID` (spawn UUID) while every other ledger carries the tmux session name; the file is git-tracked and rotated by `SessionMaintenanceRunner.rotateJsonlFiles` (flat name only), so two machines appending produce sync conflicts. | Slice 0 rewrites the hook: python-emitted JSON; row = `{ts, skill, session_id, session_name (INSTAR_SESSION_NAME), topic_id, machine_id, content_hash}` — `content_hash` is the `x-instar-stamp` the hook reads from the rendered `SKILL.md` at invocation (one grep; absent → `unknown`), so a use is attributed to the version whose stamp the file carried when the hook ran (`versionAttribution: stamp-at-hook` — honest about the window between the Skill tool's read and the hook; a `render-commit` journal row for that skill on this machine between the run's start and the telemetry `ts` buckets the row `version-uncertain`); a use on a machine whose baseline marks that rendering conflicted is bucketed `operator-edited`, excluded from every version score and shown separately; the hook validates the `skill` argument with `SLUG_RE` before building the path — **no free text, so no scrub is needed or claimed**; `machine_id` from a new `INSTAR_MACHINE_ID` tmux `-e` export beside `INSTAR_SESSION_NAME` at the four spawn sites (`SessionManager.ts:4669, 5119, 7853, 8455`; `SessionManager` gains a machine-id dependency read from `.instar/machine/identity.json`; the hook is a bash command hook and inherits process env, so no allowlist entry is needed); the hook validates it against `^[\w-]{1,64}$`, else `unknown`; file `.instar/skill-telemetry/<machineId>.jsonl`; the directory added to `rotateJsonlFiles`; the legacy file untracked (gitignore patch) and read as `unknown` history. |
| Inbound message hook | `TelegramAdapter.onMessageLogged` (`src/messaging/TelegramAdapter.ts:845`, carries `fromUser`, `forwarded`, `telegramUserId`, `authorship`); `SlackAdapter.onMessageLogged` (`src/messaging/slack/SlackAdapter.ts:220`, shared `LogEntry` with `platformUserId`, `forwarded`, no `authorship`) | A **single nullable callback slot** that `server.ts` chains ~12 times by capturing the previous callback (`HumanAsDetectorLog` at `:17540`, correction capture at `:17847`, Slack at `:18213`). | The sentinel **chains after the Human-as-Detector link, never assigns**. Its link does one durable append and nothing else (§3.1). |
| Verified operator identity | `TopicOperatorStore.isVerifiedTopicOperatorBinding` (Telegram `authenticated-inbound` evidence); `UserProfile` (`telegramUserId`, `slackUserId`, `permissions[]`) asserted from config | Telegram has a verified binding; Slack and app do not | Telegram rows: verified binding required. Slack rows: `slackUserId` matching a profile with `permissions` ∋ `admin`, **asserted**, counted `filtered.slack-asserted`; they count toward recurrence support but **never feed a draft** (§3.1, §3.5). App: unmeasurable. |
| `TopicMemory` | `src/memory/TopicMemory.ts` (SQLite + FTS5; `fromUser`, `topicId`, `sessionName`, `telegramUserId`, `timestamp`) | Durable per-topic history. App (mobile) conversations do not reach it. | Catch-up by stored watermark for rows the seam missed; never re-stored. |
| `HumanAsDetectorLog` | `src/monitoring/HumanAsDetectorLog.ts` | Regex-classifies inbound human text into coherence-break categories (weights 1–3; `actually,` fires `factual-correction` at weight 1); metadata-only; logs its own recall misses | A **signal** into outcome attribution (§3.6), never the verdict. |
| Correction & Preference Learning Sentinel | `docs/specs/CORRECTION-PREFERENCE-LEARNING-SENTINEL-SPEC.md`; `.instar/preferences.json`; `GET /preferences/session-context`; `CorrectionAnalyzer.clusterCorrectionRecords` (complete-link Jaccard, O(n²), run weekly on dozens of rows) | Three-pronged recurrence gate; scrubbed ledger; `shouldShed`/rate ceiling; policy-relaxation learnings routed to Attention. **Dark on this agent** (`monitoring.correctionLearning.enabled: false`, approved 2026-05-30, never graduated). | Gate shape and shed/ceiling copied; the policy-relaxation keyword list reused as a **signal** (§3.5). Jaccard reused only incrementally (§3.1). Learned preferences are a drafter input only where the feature is on; turning it on for the dev agent is a rung-0 precondition (§7). |
| Transcript readers | `src/monitoring/TurnEvidence.ts` (last 512 KB, sync read, tool-call outline with 256-byte fields, `truncated` flag, `scrubSecrets`), `src/core/boundedInput.ts` (`boundedHead/boundedTail`) | Structural outline, never prose | The drafter receives **outlines only** through a new async `RunSlice` reader (§3.5). |
| Session identity, lease | `SessionManager` (`nativeSessionId`, `SessionManager.ts:703`); `StateManager.findSessionByTmux` (`:426`); `LeaseRecord { holder, epoch }` (`types.ts:2338`) via `GitLeaseStore.casWrite` / `LeaseCoordinator`; `.instar/machine/identity.json` | tmux name ↔ spawn UUID; fencing epoch is the authority clock | Join key resolution (§3.6); writer fencing (§3.2). |
| Judgment provenance | `src/core/JudgmentProvenanceLog.ts` (`DecisionRowInput`: component, decisionPoint, context, optionsPresented, decision, reason, floor, fallbackRung, model, door, tokens) via `DecisionQualityRecorderImpl` | Binding: every judgment call records scrubbed full context + decision. The log itself is observe-only (`recordDecision` returns `string | null`, never throws; disk failures count in `writeErrors`), so **refusal is the caller's job** | The classifier, drafter and reviewer calls are recorded here with `arbiter: true` (§3); the sentinel refuses its own verdict when the record did not land. `logs/skill-learning.jsonl` is only the content-free index. |
| Evolution system, feature ladders, `featureEvidence`, `DegradationReporter`, `CircuitBreakingIntelligenceProvider`, `LlmQueue` (throws synchronously on cap breach), credential scanner, destructive-ops audit, `checkMandatePin` (`routes.ts:14930`; wording override needed — its default message names mandates), `needs-model.js` | existing | — | Learnings on retire-for-harm; ladder entry; evidence rows; liveness; routed LLM calls; scrub; audit; PIN on writes; operator actions on Home's first screen. |
| Console "Learned" page | `dashboard/console/learned-model.js` | Preferences + corrections, read-only | Gains "What I've learned to do" (§3.10). |

**Verdict (own-feature vs extend): extend.** New code: the request ledger and its tick, the gate, the
drafter/reviewer calls and lints, the evidence join, the version/retire paths, the every-machine reconcile,
routes, console section, and the slice-0 repairs to two existing pieces that were designed but never worked.

## 3. Proposed design

Config block `monitoring.skillLearning` (read live unless noted; `restartNeeded: true` for `enabled` because
the hook chain and tick are wired at boot):

```jsonc
{
  "enabled": false,                 // kill switch; omitted ⇒ off on every agent
  "mode": "shadow",                 // "shadow" | "live"
  "gate": { "minSupport": 3, "minDistinctDays": 2, "minDistinctSessions": 2, "minCleanRuns": 1, "windowDays": 30 },
  "caps": { "newPerDay": 1, "newPerWeek": 4, "libraryMax": 40, "descriptionBytesMax": 6144, "descriptionBytesPerSkill": 200, "bodyBytesMax": 12288 },
  "evidence": { "runSliceBytesPerRun": 98304, "promptBudgetBytes": 262144, "transcriptScanBytes": 4194304 },
  "retire": { "minUses": 5, "scoreFloor": 0.4, "misfireFloor": 0.3, "unusedDays": 60, "measurableFloor": 0.2 },
  "review": { "requireDifferentFamily": true, "minCorrectedRunsSameFamily": 2, "revertBreakerPer30d": 2 },
  "llm": { "maxDailyCents": 50, "batchSize": 20 },
  "tickMinutes": 10
}
```

LLM calls are routed through `CircuitBreakingIntelligenceProvider` under component ids
`skillLearning.classifier` (the `fast` tier; also used for outcome attribution), `skillLearning.drafter` and
`skillLearning.reviewer` (the `capable` tier, resolved per framework by the same tier resolver the cross-model
reviewer uses — never a pinned name; overridable per component id through per-component routing), with the
sentinel's own `LlmQueue` instance and `maxDailyCents` (admission errors are caught and retried next tick).
`nonGatingFailureSwap` applies; `grok-build` is excluded. **Every call is a judgment call recorded through
`JudgmentProvenanceLog`** (scrubbed full context + decision + floor + fallback rung, `arbiter: true`); `logs/skill-learning.jsonl`
carries the content-free index. **Fail closed on an unrecorded judgment:** when `isRecordingLive()` is false or
`recordDecision` returns `null`, the verdict is discarded — a classifier row is retried next tick, a draft is
`draft-refused: unrecorded`, a patch is held; a non-zero `writeErrors` delta on a tick raises a `DegradationReporter`
row and refuses all three until it clears. Per-component override of the framework:
`sessions.componentFrameworks.overrides[<componentId>]` (category `sentinel`).

### 3.1 Observe: the request ledger (no LLM on the message path)

**Seam link (synchronous, one durable append):** chained after the Human-as-Detector link on both adapters.
For a row that passes the **structural** filter it appends
`{ source: {channel, chatId, messageId}, topicId, sessionName, at, detectorCategory, identity: verified|asserted, replyTo }`
to this machine's ledger file (§3.2; fsync'd append is the durable write; the SQLite cache row is derived). The
structural filter is the only pre-classification drop, and each drop reason is counted (`filtered.<reason>`):

- `not-user`: `fromUser` false;
- `unverified-authorship` (Telegram): `authorship` not in `{human, agent-verified}` (UNRESOLVED and pre-layer rows
  are dropped, never inferred as human);
- `forwarded`;
- `not-operator`: Telegram sender without a verified `TopicOperatorStore` binding; Slack sender not matching an
  `admin` profile (matching Slack rows are kept with `identity: asserted`, counted `slack-asserted`);
- `confirmation-reply`: a reply to a `PendingConfirmation` row.

Short questions, acknowledgements and detector-classified corrections are **not** dropped: the detector
category travels with the row as a classifier input (Intelligence Infers, Keywords Only Guard). A
preference-phrased request ("always send me the CI report on Mondays") reaches both ledgers.

**Tick (every `tickMinutes`):** pending rows are classified in **batches** of `llm.batchSize` (one call per
batch, each row `boundedHead(2 KB)` — a chosen constant recorded beside its check `batchSize × 2 KB ≤ fast-tier input budget`
(the 256 KB prompt budget belongs to the drafter, not this call); a cut is disclosed inside the row as `[cut: N bytes from the tail]`; a cut row never
yields `outcomeOfPrevRun` and is re-run alone under the full prompt budget (`needs-full`) — idempotent by `source`, retried on later ticks; copies the correction
loop's `shouldShed` and per-topic rate ceiling). The batch carries, per topic, the **current key list** so
folding is **by meaning** (the classifier assigns an existing key or proposes a new one); token Jaccard against
stored cluster representatives is the secondary fold, counted. A classifier outage is a visible backlog
(`pendingBacklog`, `classifierFailures24h`; `DegradationReporter` row), never a silently missing fact. Per row:

```ts
{ repeatable: boolean, procedureKey: string, paraphrase: string /* ≤160 chars */, outcomeOfPrevRun?: ... /* §3.6 */ }
```

`paraphrase` is passed through `scrubSecrets` before and after the call. Raw message text is never stored;
`source` is the pointer back to `TopicMemory`. Clustering is incremental: only new rows are compared, against
memoized representatives bucketed by key; `clusterId` is persisted; nothing is recomputed over the window.

**Channels:** Telegram and Slack through their hook slots; `TopicMemory` catch-up by watermark for rows the
seam missed. App conversations reach neither: declared **unmeasurable** in v1 (`channels.app: unmeasurable`).

### 3.2 Storage, multi-machine posture, and the single writer

## Multi-machine posture

Default `unified`; this spec meets it:

| Surface | Posture | Path |
|---|---|---|
| Request ledger + run outcomes | **unified** — append-only JSONL **per machine**, `.instar/skill-learning/ledger/<machineId>.jsonl` (`machineId` from `.instar/machine/identity.json`), git-synced on the hourly sync (never the 30 s debounced queue); no file is written by two machines, so sync cannot conflict; rows deduped by `source` across machines | derived SQLite cache `.instar/state/skill-learning.db` (git-ignored), rebuilt async off the boot path, incremental by `(file, byteOffset)`, full rescan when a file shrank (another machine rotated it) |
| Learned skills, versions, proposals, retired | **unified** — under `.instar/skills/` and `.instar/skill-learning/{versions,proposals,retired}/`, git-synced | lock/state live **in the skill's frontmatter** (synced); the DB only caches them |
| Renderings (`.claude/skills/`, `.agents/skills/`) | **unified by reconcile** — outside `stateDir`, never synced; **every machine** reconciles `instar-learned` canonicals at boot, at the two `GitSync.sync()` call sites when `result.pulled` (no post-pull hook exists in `GitSync`; the tick is the backstop), and on each tick. The reconcile is **verify-then-render**: `verifyRendering` first, render only when it reports issues or the canonical `bodyHash` differs from the DB-cached rendered stamp (zero writes on a steady-state tick); each rendering's **last-rendered content hash is persisted in a per-machine shard** `.instar/skill-learning/rendered-baselines/<machineId>.json` (**unified**, written by one machine, synced and backed up like the ledger shards; **not** the derived cache; written temp + rename), loaded synchronously before any reconcile; each local rendering/baseline transition is journaled in this machine's journal (`render-prepare` → render → baseline → `render-commit`) and recovered before edit detection, so a crash between rendering and baseline never reads as an operator edit; local rendering content is compared with that baseline before any render — a difference is an operator edit on this machine → `user-edit-conflict`, lock, never overwritten (the concept spec's stamp alone would read a stale stamp as overwritable after a remote canonical update); **no baseline for a rendering whose stamp is stale ⇒ `unknown` ⇒ treated as a conflict: lock, never render** (the cache-loss / first-boot case); the boot reconcile runs only after the baseline file is loaded; renderings are written temp + rename (the renderer is patched in slice 0); per-skill try/catch, conflicts counted, never propagated; `removeOrphans()` for retired skills | a retire or confirm on one machine is effective on every machine within one hourly sync + tick; a machine that was away rebuilds its cache from the synced ledgers and renders what it missed — the same lag `preferences.json` and memory carry today |
| Skill-use telemetry | **unified** — per-machine files `.instar/skill-telemetry/<machineId>.jsonl` | read across machines |
| Write journal | **unified** — `.instar/skill-learning/journal/<machineId>.jsonl` | §3.5 commit protocol |

**Single writer (a coordination rule, not a state surface):** drafting, patching, reverting and retiring run
only on the machine holding the operator-messaging lease, fenced by `LeaseRecord.epoch` **read from the lease
store at write time after a successful `pullRebase`** when the lease medium is git **with a remote** (a pull that
fails is the cached-belief case: the write is aborted as `aborted-unreachable` and the machine is observe-only until
the remote is reachable again; `GET /skills/learned` shows `abortedUnreachable24h`, and 3 in a row raise a
`DegradationReporter` row). When there is no remote (detected directly: `git remote` empty, or `LocalLeaseStore` selected — never inferred
from the solo-captain flag) the fence is the locally read epoch, exactly as `casWrite` 4b does, journaled `fence: local` — a single-machine agent is never
observe-only by construction. Because the pull is not a storage-enforced token, **this spec explicitly accepts
disconnected local activation**: a machine whose partition begins after a successful pull may write and render
locally; the write is published by the next sync, where the epoch rule decides. Observation, scoring, routes and reconcile run on every machine.
The lease store is git-backed and gives no partition-safe validation coupled to a write, and the pull-before-write rule above means **a partitioned machine cannot write**; the residual case this spec
**explicitly accepts** is the window between a successful pull and the push of a competing holder's write, in which
two machines may briefly render different procedures until the next sync. Version rows are per machine, so the
ledgers never conflict; a conflicting canonical `SKILL.md` on sync is resolved deterministically — the higher epoch
wins and the loser's body becomes a proposal; **equal epochs** (a split-brain of the store itself) fail closed unless the bodies are
identical (a benign double-apply): otherwise both bodies become proposals, the skill is unrendered everywhere, and
attention item 5 names it; the "last version row"
is ordered across machines by `(epoch, at)` and the conflict loser's rows are marked `superseded`, so the next holder
never reads a loser's hash as an operator edit; a canonical merged by `LLMConflictResolver` fails the
`bodyHash` check and locks `operator-owned` (fail-safe: unrendered, surfaced). Operator actions (lock, retire,
restore, confirm) are routed through the same writer: a non-holder forwards the request **body unchanged, PIN
included**, over the authenticated mesh route (the `/pool/transfer` precedent via `resolveRouterUrl`); the holder
runs `checkMandatePin` itself and records `forwardedFromMachine` as the origin in the audit row; the standby never
pre-validates; holder unreachable → `503 lease-holder-unreachable`, never queued; a router URL that resolves to this machine is
never proxied (the pool precedent returns null for self).

Ledger files are **immutable segments**: `<machineId>.<generation>.jsonl`, a new generation opened at 4 MB and the
old one never rewritten (retention prunes whole segments older than `windowDays` × 3 after their retained rows
are re-emitted into the current generation); every row carries a unique `eventId` and outcome revisions are
separate rows ordered by `(runId, revision)`; the cache reads by `(segment, byteOffset)` and a new generation is
simply a new file, so the shrink check is never needed. Request dedupe by `source` applies to observation rows
only, never to revisions. Rows are bounded per key (200, prune-in-cache).

### 3.3 Recurrence gate (why this does not sprawl)

A `procedureKey` becomes a **draft candidate** only when all hold inside `windowDays`:

| Prong | Default | Why |
|---|---|---|
| `minSupport` | 3 occurrences | one busy afternoon is not a habit |
| `minDistinctDays` | 2 | restart-proof: a burst within one day is one occasion |
| `minDistinctSessions` | 2 | the request survived a fresh conversation |
| `minCleanRuns` | 1 **corroborated** clean run from a **verified** row (§3.6) | there must be a run to learn from; `unknown` and asserted-identity runs do not count |
| covered-by check | no existing skill covers the key | `skillUsed` on ≥2 occurrences → **improve** (§3.7) if the skill is learned, or `covered-by-handwritten` (recorded, no action) |

Caps apply after the gate: `newPerDay` / `newPerWeek`, and none once the learned library holds `libraryMax`.

### 3.4 Shadow mode first

`mode: "shadow"` runs §3.1–§3.6 in full but writes the draft to
`.instar/skill-learning/proposals/<name>/SKILL.md` (a directory no framework discovers) and logs
`would-create` with the triggering evidence. The console shows each proposal with its **body and the
paraphrases that triggered it on the first screen**, an agree tap and a disagree tap that requires a reason
tag; it also shows five of the week's "judged not repeatable" paraphrases so recall is visible, not only
precision. Agree-then-retired later counts against rung 1. Nothing changes in any session.

### 3.5 Draft: a skill written from the operator's own requests and the agent's own actions

Inputs to one drafter call, bounded by `boundedHead/boundedTail` under `evidence.promptBudgetBytes` (256 KB —
the same transport derivation as `CONTEXT_BUDGET_BYTES`, recorded beside the constant) and every cut
**disclosed inside the prompt**:

1. The operator's **verified** messages for the clean runs (by `source`, from `TopicMemory`, scrubbed).
   Asserted-identity (Slack) rows are never drafter input.
2. The agent's **tool-call outline** for those runs (`RunSlice`: async read of the transcript rows inside the
   run window, located by reading backward from the tail in 512 KB chunks, bounded by
   `evidence.transcriptScanBytes`; tool name + target + 256-byte args excerpt, **never tool results**;
   `scrubSecrets`; `evidence.runSliceBytesPerRun` cap; `truncated` recorded). A truncated clean run **refuses**
   the draft (`draft-refused: evidence-cut`). Args excerpts are **untrusted evidence** (an Edit payload can carry copied result text): the drafter may use a
   tool-call *target* from them but never a sentence; every field-level cut (256-byte excerpt, per-run cap, prompt
   budget) is disclosed in the prompt, and a cut that removes a step's target refuses the draft like a truncated run
   does. This is a mitigation, not a guarantee: planted text can still reach the reviewer's eyes, which is why the
   different-family review and the rung-2 confirmation tap exist.
3. The correction-class messages from the corrected runs (verified operator-authored only, scrubbed).
4. The active learned preferences block (where correction learning is on), each line with its source ref.
5. The names + descriptions of **every** existing skill for the covered-by check.

The drafter returns `{ action: "covered-by", target }`, `{ action: "patch", target }` (valid only when `target`
carries `instar-learned-origin` — ownership is enforced in code before any mutation) or a new canonical skill:

```yaml
---
name: ci-health-report                          # slug grammar from the concept spec, enforced at every entry point
description: "Use when Justin asks for the weekly CI health of the instar repo (failing jobs, slowest runs, flaky tests). Not for deploy status or a single run."
metadata:
  short-description: "CI health, weekly, plain language"
  instar-learned-origin: "skill-learning-sentinel"    # presence = the sentinel owns this file (flat string keys)
  instar-learned-key: "ci-health-report"
  instar-learned-version: "1"
  instar-learned-created: "2026-11-06T18:40:00Z"
  instar-learned-locked: "false"
  instar-learned-state: "active"                      # pending | active | operator-owned | retired
  instar-learned-evidence: "clean=2 corrected=1 occurrences=3 src=tg:-100123:1182,1240,1301"
---
```

**Structural lint** (deterministic, `invariant`; a failure discards the draft and logs the rule): `bodyBytesMax`;
description ≤ `descriptionBytesPerSkill` containing "use when" and "not for/when"; no `scripts/`; credential
scanner clean; **provenance of references** — every URL, route or path in the body appears in input 1 or in a
tool-call *target* of input 2; no name collision with canonical, `.claude/skills/` or `.agents/skills/` (the
patch target exempt); attribution lines carry a source (`src:` ref or `preferences.json` entry id) or are
phrased as the agent's own reading; no transcript excerpts (lessons, not logs).

**Semantic flags** (signals, `judgment-candidate`): token-Jaccard overlap ≥ 0.6 between the description and any
hand-written description; a line matching the correction sentinel's policy-relaxation keyword list (reduce
confirmation, logging, gates, approvals); a step that reports state without naming the registry/route it reads.
Each flagged line is handed to the **cross-family reviewer**, which must explicitly clear or strike it; the
conservative default when it cannot decide is **refuse the draft**. A struck policy-relaxation line is sent to
Attention as the correction sentinel does.

**One validation pipeline for every candidate body** — a new draft, a reviewer patch, a revert, a restore: the
*complete resulting document* passes the structural lint, the semantic flags and an independent review before the
commit protocol runs. Who authors and who reviews, as one table (this supersedes any looser wording elsewhere):

| Candidate | Author | Validation reviewer | One family reachable | Operator override |
|---|---|---|---|---|
| new draft (v1) | drafter, family A | family ≠ A | held `pending` until a second family or the console confirm tap | confirm / reject |
| patch after a corrected run | reviewer, family B ≠ current version's author | family ≠ B | held until `minCorrectedRunsSameFamily` corrected runs agree **and** the operator confirm tap; the version row records `reviewerFamily: same-as-author` | confirm / reject |
| bounded revert (body of N) | the sentinel (deterministic) | lint + semantic flags only; the body was reviewed when N was written | — | — |
| restore | the sentinel | family ≠ the retired version's author; held like a patch | held | restore tap is the override |

A refused revert leaves N+1 **`pending` (unrendered)** and raises attention item 1 — a harmful version is never left live because its rollback failed validation. **v1 is reviewed
before it is written** by a different family ("does every step follow from the operator's own
requests and the agent's own tool calls? clear or strike each flagged line"); a "no" discards. With one family
reachable, creation waits until a second family is reachable or the operator confirms the pending skill on the
console (the §3.7 hold has no analogue for a draft with no corrected runs, so the release is explicit). In `live` mode during rung 2 a new skill is written with
`instar-learned-state: pending` (unrendered) until a **one-tap console confirmation**
(`POST /skills/learned/pending/:name/{confirm,reject}`); once rung 2 has held (§7) a new skill renders
immediately with a 7-day "new" label. The operator asked for silence; the one tap is the price of the
untrusted-text class until the gate has proven itself, and it ends.

**Commit protocol (every write, including patches, reverts, retire and restore):**

1. **prepare** row to the machine's journal: `{ name, op, expectedPrevHash, newHash, epoch, at }`, fsync'd;
2. `pullRebase` (git-with-remote media only; `fence: local` otherwise), then the lease epoch re-read; pull failed → abort (`aborted-unreachable`); stale epoch → abort (`aborted`);
3. on-disk canonical `bodyHash` must equal `expectedPrevHash` (the last version row); mismatch → the operator
   edited canonical → `operator-owned`, `locked`, abort;
4. rendering preflight against the **old** canonical (the stamp only detects edits relative to the current
   canonical); `user-edit-conflict` → lock, abort;
5. version row appended; canonical written temp + rename; renderings via `skillParityRule.remediate()`;
6. **commit** row. Recovery on boot reads **this machine's own journal only** (a foreign dangling prepare pulled
   by sync is reported, never acted on — a standby never writes). Three-way: canonical hash = `newHash` → re-check the
   fence, finish rendering, commit; = `expectedPrevHash` → nothing was replaced, mark the prepare and its version
   row `void`; any other hash → a newer sync or an operator edit intervened: preserve it, lock `operator-owned`,
   surface the conflict. Retire and restore are journaled as moves with both paths so a half-moved directory is
   completed or reversed the same way. An interrupted system write is never classified as an operator edit,
   because the journal names it.

### 3.6 Measure: outcomes are corroborated, never inferred from silence

Every recorded request opens a **run** (`runId`). Outcome labels, with precedence top-down, and each detector's
symbol / state / corroboration / unmeasurable case:

| Label | Symbol read | State claimed | Corroboration | Unmeasurable → |
|---|---|---|---|---|
| `corrected` | a detector-class or classifier-judged correction **attributed to this run** by the reviewer call (given the run's reply, `replyTo`, outline) | the run was wrong | the attribution; regex alone is a signal | `unknown` |
| `redo` (= corrected) | a same-key request whose classifier verdict is "asked again because the first was unsatisfactory" (given the prior reply) | the first run did not satisfy | the classifier's verdict, not mere recurrence | routine recurrence is **not** redo |
| `accepted` | a delivered agent reply (outbound log) **and** the next operator message classified as an acknowledgement **of that reply** (`replyTo` or content) | the run served the request | the explicit acknowledgement | `unknown` |
| `accepted-inferred` | a delivered reply **and** the next same-key request judged routine with no correction between | continued demand with no complaint — weaker than acceptance | the routine-recurrence verdict; reported separately from `accepted` everywhere | `unknown` |
| `weak-positive` | a delivered reply and the next operator message is an unrelated request with no correction | nothing claimed — moving on is not satisfaction | — | not in the score; share reported |
| `unknown` | window closed by timeout, lease move, no reply, app channel, or no signal | nothing claimed | — | excluded from scores, drafter input and the metric |

`minCleanRuns` (§3.3) is met by one `accepted` run or two `accepted-inferred` runs. Label accuracy is audited:
five sampled runs a week, stratified by label, are shown on the console with their label for a one-tap agree/disagree, and the agreement
rate is a rung-1 number. Every non-`corrected` label (including `weak-positive` and `accepted-inferred`) is revisable.

**Window rules:** the window closes at the next operator message **after at least one agent reply** (that
message is inside the window), or at the session clock's end for a time-boxed run, or at 2 h; a new request
before any reply closes the previous run as `unknown`. **Timeout outcomes are provisional:** until `windowDays`
expire, a later correction the reviewer attributes to the most recent run of that key flips the run to `corrected`
(outcome rows are revisable; the index records the revision; the rung-2 metric is computed at read time). **A flip
reaches the skill, not only the ledger:** when the flipped run is cited in any version's evidence or its key has a
learned skill, the reviewer (§3.7) is enqueued with that correction (it feeds the reviewer, not the current version's score,
when the flipped run predates that version), and the skill's evidence line is rewritten.

| Detector | Symbol | State | Corroboration | Unmeasurable → |
|---|---|---|---|---|
| `skillUsed` | telemetry row with `session_name` = the run's session (also resolved to the spawn UUID via `findSessionByTmux`), `topic_id` = the run's topic, timestamp inside the window, from any machine's file | the skill ran for this request | the transcript (`RunSlice`, bounded scan) shows the Skill tool call | empty session/topic, or scan bound exceeded → `unknown`, never "not used" |
| `misfire` | `skillUsed` where the triggering request's key ≠ the skill's key | the description over-triggers | the classifier's key for that message | — |
| `measurableRate` | corroborated runs ÷ uses | how much of this skill's use the evidence can see | — | reported; below `retire.measurableFloor` with `uses ≥ minUses` → console "unmeasured" + attention item |

Score per skill **and per version** = `(accepted + ½·inferred + 1) / (accepted + ½·inferred + corrected + 2)` — the
same half weight the gate gives an inferred run — with `accepted` and `accepted-inferred` always shown as separate
counts (`acceptedInferred` in every route and console line). Hand-written skills get the
same numbers, read-only. Console wording: "N runs accepted, M corrected, K unknown" — never "works". All of it is
recorded through `featureEvidence.record('monitoring.skillLearning', …)`.

### 3.7 Improve: a reviewer that is not the author, with replay and a bounded revert

After a `corrected` run of a learned skill, a **reviewer call** receives the current body, the attributed
correction (scrubbed), the run's tool-call outline and the run's verified operator messages, and returns a
minimal patch with, per hunk, **which correction it answers** (a hunk citing none is dropped) or `no-change`.
Routing and the one-family hold are the §3.5 table's (the hold also needs the operator's confirm tap; the console
labels `reviewerFamily: same-as-author`, and such versions are excluded from the rung-2 metric). The patch is applied as version N+1 through the commit protocol;
bodies of the last 20 versions are kept as files, older bodies content-addressed, every version row forever.

**Bounded auto-revert:** when version N+1 has ≥3 corroborated runs with ≥2 `corrected` and a corrected rate
strictly above version N's, the sentinel writes version N+2 = body of N (a version write) recording
`rejectedBodyHash = hash(N+1)` and the uncertainty (counts on both sides). A later patch whose body hash, or
whose cited-correction set, matches a rejected version is refused; after one revert the key needs two agreeing
corrected runs before any patch; `revertBreakerPer30d` reverts on one key → lock + attention item.

### 3.8 Retire, never delete; never merge; lock is not immunity

A learned skill is **retired** (canonical moved to `.instar/skill-learning/retired/<name>/`, renderings removed
on every machine by the reconcile, `instar-learned-state: retired`, reason recorded) when
`uses ≥ retire.minUses` **and the current version has ≥ 3 corroborated runs** (the same minimum the bounded revert
needs, so the heal can always run first; below it the skill is "unmeasured", never retired for score) and
`score < retire.scoreFloor`, or (`uses ≥ retire.minUses` and misfires ≥ 2 and misfire rate ≥ `retire.misfireFloor`), or unused for
`retire.unusedDays` **after at least one observed request of its key on a telemetry-emitting framework**.
Retirement for harm also posts a learning to `POST /evolution/learnings`. A `locked` (operator-owned) skill is
never **patched**, but it is still scored and can still be retired for harm — retirement **deactivates**: the
operator-edited rendering is moved, byte-for-byte, to `.instar/skill-learning/retired/<name>/renderings/<machineId>/`
(recoverable, outside every discovery path) and surfaced as a conflict with its new location; a retire that
cannot move the file reports `retire-blocked` and the skill as still active, never silently. Restore (one tap) re-runs the structural lint and the reviewer, resets
counters, and shows the retirement reason when it was harm. The sentinel never merges two skills and never
deletes a file.

### 3.9 Keep the library small and the prompt flat

Learned skills are discovered exactly like hand-written ones (Claude's own skill index, progressive
disclosure); the session-start hook injects nothing extra. `descriptionBytesPerSkill` bounds one skill;
`descriptionBytesMax` bounds the sum (34 hand-written descriptions are 8.4 KB today; the cap adds at most
~1.5 k tokens to each session's index). When a draft would exceed the sum, the lowest-scored unused learned
skill is retired first (that is the self-heal), or the draft waits. `libraryMax` bounds the count.

### 3.10 Surfaces — silent to the operator by default

- `GET /skills/learned` → `{ mode, counts, channels, pendingBacklog, classifierFailures24h, filtered, skills: [{ name, state, score, uses, accepted, acceptedInferred, corrected, unknown, weakPositive, measurableRate, misfires, version, reviewerFamily, lastUsedAt, locked }], proposals, pending, retired }` (503 when off).
- `GET /skills/learned/:name` → versions + evidence rows (paraphrases and source refs, never raw text).
- Writes, all `checkMandatePin` (with a skill-specific message) plus bearer, `:name` validated by the concept
  spec's `SLUG_RE` at the route edge (400), forwarded to the lease holder when this machine is not it:
  `POST /skills/learned/:name/{lock,unlock,retire,restore}`, `POST /skills/learned/retire-all`,
  `POST /skills/learned/proposals/:name/{agree,disagree}` (disagree carries a reason tag),
  `POST /skills/learned/pending/:name/{confirm,reject}`.
- Console **Learned** page gains "What I've learned to do": one plain line per skill with its numbers in words,
  proposals (shadow) and pending skills (rung 2) with their body and paraphrases on the first screen (rendered as
  text via `textContent`, never markdown→HTML — drafter output can carry copied HTML), retired
  with restore, locked with the conflict shown. Pending confirmations, proposal samples and the weekly label-audit samples are registered in
  `dashboard/console/needs-model.js` so they appear on Home's first screen and count.
- **No Telegram message** on create, patch or ordinary retire. Attention items, each with its self-heal
  declared (Self-Heal Before Notify), class `recoverable`, `dedupe-key` = `procedureKey`, `max-attempts 3`,
  backoff 1 h / 6 h / 24 h, breaker: 3 heals of one key in 7 days → escalate, `max-notification-latency 120s`
  after exhaustion, audit in `logs/skill-learning.jsonl`:
  1. **retired for harm** — heal = the bounded revert first (§3.7); notify only if the reverted version is also below floor;
  2. **library cap blocking drafts** — heal = retire the lowest-scored unused skill (§3.9); notify only if nothing can be freed;
  3. **drafter refused 5× in a row** — heal = swap the drafter family once; then notify;
  4. **classifier failure rate > 50 % over 24 h** — heal = the bounded failure swap; then notify;
  5. **unmeasured skill** (`measurableRate` below floor at `minUses`), **revert breaker**, or **equal-epoch split-brain** — heal = none possible (evidence, not a fault); notify with the numbers.

## 4. Decision points touched (Judgment Within Floors)

| Decision point | Class | Floor / justification |
|---|---|---|
| Structural pre-filter (§3.1) | `invariant` | provenance facts, not meaning; each drop counted |
| `repeatable` + `procedureKey` + key folding | `judgment-candidate` | bounded action space (record / fold / not); conservative default: not recorded; fallback: retry next tick → visible backlog → `unknown`; arbiter: the batch classifier |
| Recurrence gate prongs and caps | `invariant` | deterministic counts |
| covered-by / patch-vs-new | `judgment-candidate` | floor: patch target carries `instar-learned-origin` (code-enforced); default: no skill |
| Structural lint (§3.5) | `invariant` | deterministic refusals |
| Semantic flags: description overlap, policy relaxation, ungrounded step | `judgment-candidate` | the Jaccard / keyword hits are signals; arbiter: the cross-family reviewer must clear or strike each; default: refuse the draft |
| Outcome labels (§3.6) | `judgment-candidate` | floor: `accepted` needs a delivered reply + a positive signal; `redo` needs a dissatisfaction verdict; default `unknown`; arbiter: the classifier / reviewer |
| Reviewer patch and v1 review | `judgment-candidate` | every hunk cites a correction; different family or the hold; default `no-change` / discard |
| Bounded revert, retire thresholds, byte caps, never-delete, never-merge, hand-written read-only, commit protocol | `invariant` | deterministic |
| Operator lock / unlock / retire / restore / confirm / agree | `invariant` | PIN-gated operator authority; a chat "yes" is never approval |
| Rung-2 pending state | `invariant` while rung 2 is unproven | removed by the ladder, not by a model |
| Unrecorded judgment → refuse | `invariant` | the provenance record is the precondition of every verdict; no record, no action |

> No message gate is added or changed; the sentinel never blocks, delays or rewrites an outbound message. Its
> only write authority is over files whose frontmatter it created.

## 5. Frontloaded Decisions

| # | Decision | Answer | Tag |
|---|---|---|---|
| 1 | Go-live of a new skill in `live` mode | `pending` until a one-tap console confirmation during rung 2; immediate with a 7-day "new" label after rung 2 holds (a one-family draft stays `pending` until a second family or the tap, at any rung) | user-visible interface — not cheap |
| 2 | Ledger replication | unified: per-machine append-only JSONL under `.instar/skill-learning/ledger/`, git-synced hourly; SQLite is a git-ignored derived cache; `machineId` from `.instar/machine/identity.json` | on-disk layout — not cheap |
| 3 | Which dirs git-sync | `.instar/skills/`, `.instar/skill-learning/{ledger,journal,versions,proposals,retired,rendered-baselines}`, `.instar/skill-telemetry/`; not `.instar/state/skill-learning.db*` (gitignore migration, `PostUpdateMigrator` precedent at `:3459`); legacy `skill-telemetry.jsonl*` untracked | not cheap |
| 4 | Slack/app inbound | Slack via its `onMessageLogged` slot with asserted `admin`-profile identity (support only, never draft input); app `unmeasurable` in v1 | cheap-to-change-after (shadow, internal) |
| 5 | Correction sentinel on the dev agent | on for the shadow rung (rung-0 precondition) | cheap-to-change-after |
| 6 | Slice-0 backfill conflict policy | `.claude/skills/<name>/` becomes canonical; a differing `.agents/skills/<name>/` is left untouched, unstamped, logged; non-markdown files copied verbatim; nothing deleted | fleet-wide migration — not cheap |
| 7 | Slice 0 behind the flag? | no: unconditional, copy-only, idempotent; `ships-staged` is false for slice 0 alone | not cheap |
| 8 | Routing component ids | `skillLearning.classifier` (also outcome attribution) / `.drafter` / `.reviewer` | cheap-to-change-after (contested: ids appear in `/metrics/features`; cleared — internal) |
| 9 | Model tiers and spend | classifier `fast` tier; drafter/reviewer `capable` tier via the existing per-framework tier resolver; `llm.maxDailyCents: 50` | money — not cheap |
| 10 | Reviewer family set | claude / gpt / gemini; grok-build excluded | cheap-to-change-after |
| 11 | Route paths, PIN, console section | as §3.10; `checkMandatePin` (signature `(req, res, pinOverride?)`, a message override is a needed change) run on the holder for forwarded writes; holder unreachable → `503 lease-holder-unreachable`; the Learned page section and its `needs-model.js` registration | published interface — not cheap |
| 12 | File locations | as §3.2; `skill-learning/` and the db created 0700/0600 | on-disk format — not cheap |
| 13 | Learned-skill metadata | flat `instar-learned-*` string keys | format a loader reads — not cheap |
| 14 | Retire thresholds | `minUses 5`, `scoreFloor 0.4` with ≥3 corroborated runs on the current version, `misfireFloor 0.3` with ≥2 misfires, `unusedDays 60` with the observed-request precondition, `measurableFloor 0.2` | removes a slash command — not cheap |
| 15 | Gate prongs, caps, window rules, Jaccard 0.6, Laplace score, lint-refusal count 5, "new" 7 days (contested: a label, not a contract; cleared), batch 20, tick 10 min | as stated | cheap-to-change-after ×9 (shadow-measured) |
| 16 | Scheduling | in-process tick, not a `jobs.json` job; `supervision: tier1` = the reviewer validates every write | cheap-to-change-after |
| 17 | Run boundaries | Run A = slices 0+1 (observe, draft to proposals, measure, v1 review), ends at the rung-1 operator sample; Run B = slices 2+3 | — |
| 18 | Telemetry hook rewrite | per-machine file, JSON via python, no free text, `session_name` + `topic_id` + `machine_id` (new `INSTAR_MACHINE_ID` tmux export at the four spawn sites), rotation for the directory | fleet-wide hook change — not cheap |
| 19 | Parity re-render actor | every machine reconciles `instar-learned` renderings at boot, at the `sync()` call sites when pulled, and each tick (verify-then-render, baseline-hash edit protection, temp + rename) via `skillParityRule.remediate()` / `removeOrphans()`; `FrameworkParitySentinel` wiring is out of scope | cheap-to-change-after |
| 20 | Config default migration | `migrateConfig` adds `monitoring.skillLearning` with existence checks; `restartNeeded: true` | not cheap |
| 21 | Backup | `BackupManager.includeFiles` += `skills/`, `skill-learning/`, `skill-telemetry/`, `state/skill-learning.db*` | not cheap |
| 22 | Rollback residue | a revert leaves the config block, ledger files and `instar-learned` skills, which keep working as ordinary skills; `retire-all` is the one-step cleanup; stated in §9 | — |
| 23 | Learning registry on retire-for-harm | `POST /evolution/learnings` | cheap-to-change-after (contested: durable rows; cleared — internal, recoverable) |
| 24 | Version body retention | last 20 bodies as files, older content-addressed, rows forever | cheap-to-change-after (contested: moves bodies; cleared — deletes nothing) |
| 25 | Evidence budgets | `runSliceBytesPerRun 96 KB`, `promptBudgetBytes 256 KB` (transport-derived, recorded beside the constant), `transcriptScanBytes 4 MB` | cheap-to-change-after (shadow-measured) |
| 26 | Lease epoch source and dedupe key | `LeaseRecord.epoch` read from the lease store after a successful pull at write time; ledger dedupe by `source = (channel, chatId, messageId)` | cheap-to-change-after |
| 27 | Revert breaker `revertBreakerPer30d: 2` (contested: a lock, reversible by unlock; cleared); re-arm review default 14 days (an audit field); label-audit sample size 5/week | as stated | cheap-to-change-after ×3 |
| 28 | Rendering baseline shard | `.instar/skill-learning/rendered-baselines/<machineId>.json`, unified per-machine shard (synced, backed up, temp + rename, transitions journaled); missing baseline + stale stamp = conflict | on-disk format — not cheap |
| 29 | Telemetry `content_hash` | the rendered `x-instar-stamp` read by the hook at invocation; absent → version-unknown | part of the hook rewrite (row 18) — not cheap |

Counts: frontloaded 29; cheap-to-change tags surviving 22 by instance (12 rows; row 15 carries nine, row 27 three); contested-then-cleared 5 (rows 8, 15's label, 23, 24, 27's breaker); contested-rejected 1 (the retire minimum, moved into row 14).

## 6. Slices

0. **Repairs the concept spec deferred (unconditional, fleet-wide, copy-only):** `migrateSkillsCanonicalBackfill()`
   per decision 6; `installBuiltinSkills()` writes canonical then remediates (as a migration, P3 §5); the
   every-machine reconcile; `BackupManager` entries; gitignore patch; telemetry hook rewrite + `INSTAR_MACHINE_ID`
   export + rotation (decision 18); a note in `skill.md`. Own PR.
1. **Observe, gate, shadow drafting, measurement, v1 review** (§3.1–§3.6, drafts to proposals only), read routes,
   proposal agree/disagree, ladder entry, console section. Ends Run A at the rung-1 sample.
2. **Live writes** (§3.5 commit protocol, pending/confirm, §3.9).
3. **Reviewer patches, versions, bounded revert, retire, attention items** (§3.7, §3.8, §3.10 writes).

## Maturation plan

- **ladder:** monitoring.skillLearning
- **test-agent-live:** a throwaway agent under the user-role harness replays a scripted history (3 occurrences /
  2 days / 2 sessions / 1 corroborated clean run → exactly one proposal; 2 occurrences → none; a forwarded
  message, a non-operator sender and an asserted-identity-only history → none), then the correction / retire /
  restore paths, and retire-on-A-removes-rendering-on-B across two machines. Precondition: correction learning
  on for the dev agent (decision 5).
- **dark-window:** 7 days on the development agent with the flag on and `mode: shadow`: nothing written anywhere
  but proposals, journal and logs.
- **dev-agent-live:** rung 1 (shadow, ≥14 days): ≥10 `would-create` decisions from ≥3 distinct keys; operator
  agreement ≥ 70 % on ≥8 sampled proposals; classifier failure rate < 5 %; zero raw-text rows (weekly self-check
  + test); `unknown` + `weak-positive` share reported (if > 60 %, the positive-signal design is revisited before
  rung 2). Then rung 2 (`mode: live`, pending/confirm): harm metric = **no-regression on corroborated outcomes** —
  per key with a learned skill, corrected-rate with the skill ≤ corrected-rate of that key before it (paired,
  ≥5 corroborated runs each side, `unknown`/`weak-positive` excluded, same-family-reviewed versions excluded;
  the **primary** metric counts `accepted` and `corrected` only, and the same figure *with* `accepted-inferred`
  is reported beside it as a sensitivity, never as the gate),
  with **coverage ≥ 70 %** of learned-skill uses inside the paired metric, the coverage reported, and the
  measurable share before and after the skill within 20 points of each other (a change in what is measurable is
  not a change in quality); label-accuracy agreement ≥ 80 % on the weekly samples; zero
  user-edit overwrites; zero deletes under the learned paths (destructive-ops audit). This metric is
  **observational** — user-feedback evidence (acknowledgements, attributed corrections), not verified task
  outcomes; where a key has a deterministic postcondition (a report delivered, a PR opened) the run records it as
  `postcondition: met | unmet | n/a` and the metric is also reported on that subset. It is only meaningful because
  `accepted` requires a positive signal; with silence-as-clean it could not see a regression.
- **fleet:** default-on after rung 2 holds 30 days on the development agent and on one more agent, by the
  recurring model review with two independent readings (the D7 evaluator owns `ready`); descriptors exported for
  `feature-ladders.json` (`ran` = `would-create`/`create` rows, `harm` = regression and revert rows, from
  `logs/skill-learning.jsonl`, `windowDays 14`, `minSamples 10`). Never operator-only, never automatic.
- **graduation criterion:** each rung's numbers above, read from the feature's own logged behaviour; the final
  rung by recorded model review, never by elapsed time.

## 8. Tests (three tiers, per the Testing Integrity Standard)

- **Unit:** structural filter (each reason, counted; Slack asserted rows never reach the drafter); gate prongs
  each side of the boundary; caps; every structural lint rule with a realistic bad draft; semantic flags are
  passed, not refused, and the reviewer's strike/clear is honoured with refuse as default; provenance-of-references
  (a URL only in a tool *result* is refused); outcome table (silence → `unknown`; unrelated next request →
  `weak-positive`; routine recurrence → `accepted-inferred`; dissatisfaction verdict → `redo`; late correction flips a
  provisional outcome); join key resolution and `unknown` on empty session; per-version score, bounded revert,
  rejected-hash refusal, breaker; version N+1 and never-delete; different-family routing and the hold; ledger
  idempotency by `source` and raw-text absence; incremental clustering touches only new rows; slug grammar at
  the routes; stale-epoch write refused; journal recovery for every interruption point; the hook chain wraps and
  does not replace; `JudgmentProvenanceLog` row written for each of the three calls, and a null record id discards the verdict; a cut classifier row never yields an outcome; a late flip enqueues the reviewer; retire-for-score refused below 3 corroborated runs; the reconcile never overwrites a rendering edited on another machine (edit on B, update on A); own-journal-only recovery, three-way; a write with a failed pull aborts `aborted-unreachable`; cache deletion then a remote update with a locally edited rendering locks and never renders; a patch body fails the same lint a draft would; telemetry rows carry the stamp read at the hook, an absent stamp reads version-unknown, and a render during the run reads version-uncertain; misfire retirement needs two verdicts; a no-remote store writes with `fence: local`; a refused revert leaves N+1 pending with a notice; an `operator-edited` use never enters a version score; a crash between render and baseline write recovers from the journal, not as an edit.
- **Integration:** routes 200/503; shadow writes only to proposals; live writes go through the commit protocol
  and `skillParityRule` with `x-instar-stamp`; user-edit conflict and canonical-edit both lock; `pending` is
  unrendered until confirm; `retire-all`; restore re-lints and re-reviews; attention items fire on exactly the
  five conditions after their heals; backfill migration idempotent on a fixture with conflicting
  `.claude`/`.agents` copies; telemetry hook emits valid JSON for hostile args; backup includes the new paths;
  non-holder write routes forward to the holder.
- **E2E (alive test):** server boots with the flag on → `GET /skills/learned` 200; the test-agent replay yields
  exactly one proposal in shadow and exactly one rendered skill in live after the confirmation tap.
- **Live-user-channel proof** before "done": the test-agent rung on a demo Telegram channel, driven by the
  user-role harness through happy path, correction, retire and restore, on two machines.

## 9. Kill switch and rollback

`monitoring.skillLearning.enabled: false` (restart) stops observation, drafting, review and retirement; routes
503; learned skills on disk keep working as ordinary skills. `POST /skills/learned/retire-all` (PIN) retires
every learned skill in one step, recoverable. Both record an audit row with the actor and a re-arm review date
(default 14 days) so a rollback cannot outlive its reason unnoticed. A code revert removes the sentinel and
routes; it leaves the config block, the ledger files, and any `instar-learned` skills (ordinary files;
`retire-all` first if they should go). Slice 0 stays: it is the concept spec's own deferred item.

## 10. Open questions

*(none)*

> Q1–Q4 of the first draft became decisions 1, 2, 4 and 5 in §5.
