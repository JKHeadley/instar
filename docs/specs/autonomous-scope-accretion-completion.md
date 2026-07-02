---
title: "Autonomous Scope-Accretion Completion Discipline — work a session generates joins its completion bar"
slug: "autonomous-scope-accretion-completion"
author: "echo"
status: "draft"
parent-principle: "Deferral = Deletion — initiative converted into a 'documented stretch' is abandonment with a paper trail"
sibling-principles: "Structure > Willpower; Close the Loop (Untracked = Abandoned); Signal vs. Authority; Know Your Principal — An Unverified Identity Is a Guess; Agent Proposes, Operator Approves; Framework-Agnostic — and Framework-Optimizing"
lessons-engaged: "AUTONOMOUS-COMPLETION-DISCIPLINE.md (the judge/signal architecture this extends); autonomous-completion-real-checks.md (the veto-shape + deterministic-corroboration precedent); scope-accretion-completion-discipline (operator feedback 2026-07-02, topic 29836); B18_AUTONOMY_STOP (MessagingToneGate); Know-Your-Principal / operator-binding; P20 Verify the State, Not Its Symbol (the load-bearing signal is GIT truth — the file in the tree — not the tool-event symbol of a write); P13 The Stop Reason Is the Work; P19 No Unbounded Loops (breaker K + persisted breaker state); Scrape/Parser Fixture Realness (all three new parsers registered with captured fixtures); Agent Proposes, Operator Approves (server-authored ratification enumeration — display authority = executed authority)"
parent-spec: "docs/specs/AUTONOMOUS-COMPLETION-DISCIPLINE.md"
project: "self-healing-mesh (topic 29836)"
eli16-overview: "docs/specs/autonomous-scope-accretion-completion.eli16.md"
depends-on: "CompletionEvaluator (src/core/CompletionEvaluator.ts — instruction-inert transcript fence; PROMPT_VERSION canary); POST /autonomous/evaluate-completion (src/server/routes.ts — the server-side chokepoint the deterministic core now lives in); autonomous stop hook (.claude/skills/autonomous/hooks/autonomous-stop-hook.sh — CD_JUDGE_TAIL window, CD_MIGHT_BE_DONE gate, cd_record_judge_failure breaker, hard-blocker exit path); parseStopSignals (src/server/routes.ts:~4483 — gains ONE advisory boolean only); Telegram inbound history (per-topic JSONL written by TelegramAdapter — the REAL operator-message store; NOT src/messaging/MessageStore.ts, which is the agent-to-agent store); TopicOperatorStore (verified auto-bound operator per topic); setup-autonomous.sh + the run registration path (where the server-side start snapshot is taken); PostUpdateMigrator upgrade() marker mechanism (REALCHECK_VERIFY precedent); SafeGitExecutor/read-only git plumbing for the Stop-time sweep"
---

# Autonomous Scope-Accretion Completion Discipline

## 1. Problem

On 2026-07-02 (topic 29836) an autonomous session drafted five specs that were
clearly aligned with its goal, labeled their implementation "the documented stretch
(out of completion condition)," satisfied its start-time completion condition, and
exited. The operator's verdict: an initiative failure — "you shouldn't be able to
label the session as completed until those specs are followed through."

The structural gap: the completion bar is frozen at session start. The judge
(`CompletionEvaluator.evaluate`) sees only the condition string, an ~8KB transcript
tail, and six whitelisted `StopSignals`; the stop hook's only "buildable work
remains" signal is the state-file checkbox scan (`CD_UNCHECKED_COUNT`). **Nothing
deterministic tracks the artifacts the session itself creates.** So a good session
that discovers new in-scope work can convert that initiative into deferral — the exact
Deferral = Deletion anti-pattern — and neither the hook nor the judge can see it.

**Why two earlier designs are wrong (both discovered by review, the hard way).**

1. **Transcript-based detection fails on tail-blindness and forgeable ratification.**
   Artifacts created early scroll out of the ~8KB tail before the done-claim; and a
   "quoted operator approval" read from the transcript is a one-sentence self-issued
   exit permit — the agent authors the transcript. (Round 1.)
2. **A client-side "deterministic" core fails on session-writable substrate.** The
   round-1 rewrite kept the detection in a tool-event ledger file, the config snapshot
   in the run state file, and the ratification verdict in the hook-built signals JSON.
   Round 2's reviewers broke every one of those: files written via Bash heredocs never
   produce Write/Edit tool events (and the wired PostToolUse reporter forwards no file
   path at all); the ledger, the state file, and the hook script are all writable by
   the session they police; a client-supplied `operatorRatifiedDeferral: true` boolean
   is forgeable by construction; and the local inbound-message JSONL is an
   unauthenticated plaintext file whose operator uid the session already knows.

**The correct design (R11):** the load-bearing facts are computed **server-side, at
the existing `POST /autonomous/evaluate-completion` chokepoint, from git truth and
server-owned state** — never transported from the session's environment and never
read from files the session routinely edits. What did this session create? Ask git.
Did the verified operator ratify deferral? Ask the server's own record of an
explicit, server-authored confirmation exchange (or the PIN-gated route). The
transcript/tool-event layers are demoted to advisory corroboration.

**Honest tamper-resistance bound (R12).** A full-shell agent on the same machine can,
in the limit, edit server state files or the server itself. The guarantee this spec
earns is therefore stated precisely: every load-bearing input is moved out of the
files the session *routinely and legitimately* writes (its state file, its worktree
ledgers, its hook payloads) into server-owned stores + git history, where tampering
is (a) never part of normal operation, (b) individually detectable (git history is
content-addressed; server stores are outside the run's documented write surface), and
(c) a visible, attributable lie under the constitution's deterrence framing — the
same bound the parent CD spec documents for its own state. "Impossible to evade" is
not claimed; "cannot be evaded by any path that is also a normal workflow step" is.

## 2. Design — a server-side deterministic core; advisory client layers

The feature adds NO new judge and NO new LLM call. All blocking logic lives at the
server chokepoint in its established fail-safe direction: every layer pushes only
toward `met:false` (keep working), never toward a false "done." Duration expiry and
the emergency stop are untouched — a session can never be trapped past `end_at`.

### 2.1 Start snapshot (server-side, at run registration) — R13, made concrete (R30)

**The registration route is NEW — round 3 verified no server-side run registration
exists today** (`setup-autonomous.sh` only calls `GET /autonomous/can-start` and the
native-goal set; the run record it writes is the client-owned state file). This spec
therefore DEFINES it: `POST /autonomous/register` (Bearer), called by
`setup-autonomous.sh` at session setup, body `{ topicId, condition, workDir,
declaredDeliverables?: string[], startedAt }`. The SERVER mints `runId`, takes the
snapshot below, persists the server-owned run record
(`state/autonomous-server/<topicId>.<runId>.json`, written only by the server), and
returns `{ runId }`; setup writes the runId into the state-file frontmatter so the
hook can echo it. **One registration per active run:** a re-register for a topic with
an active run is REFUSED (409) and flagged (attention item) — a session cannot
re-register mid-run with a broadened declared list. The server-side sessionId↔topicId
map (§2.3) is built here. The snapshot:

- `scopeAccretion` config (the whole sub-object) — closes the mid-run self-disable
  bypass at the correct layer: the session editing `.instar/config.json` OR its own
  state-file frontmatter changes nothing the chokepoint reads.
- The completion-condition text as registered, and the **declared-deliverable set**
  parsed from it by the frontloaded grammar (§2.4), plus an optional explicit
  `declared_deliverables:` list that `setup-autonomous.sh` writes at registration
  (exact repo-relative paths). Mid-run edits to the state-file condition are ignored
  for accretion purposes and flagged (attention item, deduped per run).
- The run's `work_dir`, and the sweep's BASE roots with their **start-SHAs**: the
  work_dir's repo root and the agent-home repo, each recorded with `git rev-parse
  HEAD` at registration. (The sweep re-derives the FULL root set live at sweep time —
  §2.2 — so mid-run worktrees cannot escape by being created after registration.)

**Operator emergency lever preserved (R14 — closes the rollback-regression).** The
snapshot removes the *session's* ability to self-disable, but the operator keeps an
instant mid-run off-switch: `POST /autonomous/:topic/scope-accretion-override`
(dashboard-PIN-gated, body `{"enabled": false, "reason": "..."}`) updates the
server-side snapshot with an audited, principal-verified action. The config-file
comment contracts in `ConfigDefaults.ts`/`types.ts` and the CLAUDE.md template are
updated to say "live for the operator via the PIN route; snapshotted against the
running session" — the change-site list (§4) includes those doc edits.

### 2.2 Layer 0 — the git-truth accretion sweep (LOAD-BEARING) — R15

At evaluate-completion time (and ONLY then — the judge path already fires only when
`CD_MIGHT_BE_DONE`), the server computes the accreted-artifact set from **git state**
over a root set RE-DERIVED LIVE at sweep time (R31 — closes the mid-run-worktree
escape):

- **Roots:** the registered base roots (§2.1) PLUS, per base root, every checkout in
  `git worktree list` PLUS any directory under the agent-home worktree convention
  (`.worktrees/*`) created after `started_at`. A worktree first seen at sweep time
  gets its start-SHA recorded on first sight (= the merge-base with its base branch
  at creation, falling back to registration-time base-root SHA).
- **Per root:** committed arm = `git log <startSHA>..HEAD --diff-filter=ACR
  --name-only` (SHA-anchored, NOT `--since` — commit dates are author-settable);
  uncommitted arm = `git status --porcelain`. Both filtered by class globs (§2.4).
- The sweep is read-only (`SafeGitExecutor.readSync` verbs), bounded (per-root
  timeout, total budget, path-count clamp of 200), and runs in-process on the server
  at judge-fire only — no data crosses from the session's environment. Writes to
  repos/dirs OUTSIDE this root set are a named residual bound (§6), surfaced as
  `scopeAccretionSuspected` when the advisory ledger (§2.3) saw a Write there.

Why git truth: it catches files created by Write/Edit, Bash heredocs, `tee`, `cp`,
`mv`-from-scratch, python scripts, and subagent sessions identically (P20 — the file
in the tree is the state; the tool event was only a symbol). Framework parity, honest
scope (R16, corrected by round 3): the DETECTION substrate is engine-independent
(git + server), but the guarantee FIRES only for an engine whose autonomous loop
consults the evaluate-completion chokepoint — Claude's stop hook today, Codex when
its loop-driver graduates (it ships self-gated dark), while gemini/pi have no
completion-discipline loop at all and therefore **no gated exit of any kind** — a
foundation coverage bound this spec names but does not close. The advisory
tool-event ledger below remains Claude-first with Codex wiring; gemini/pi are
advisory-absent (named, honest).

**Deletion is not an exit (R17 — closes the deletion-beats-deferral inversion).** An
accreted deliverable that disappears from the working tree before run end does NOT
reclassify to scratch. It stays in the unbuilt set flagged `deleted:true`, and the
exit surface (hard-blocker/attention/final notice) lists deleted accreted
deliverables loudly ("session deleted N accreted deliverables: <basenames>").
Ratification clears it like any other accreted artifact. Genuine throwaway spikes
belong under scratchpad paths from the start; git-restorable deletion of committed
work is visible in the sweep's committed arm regardless.

### 2.3 Advisory tool-event ledger (corroboration only) — R18

The per-session PostToolUse stream feeds a server-written advisory ledger
(`state/autonomous-server/<topicId>.<runId>.artifacts.jsonl`) used for attribution
detail (which turn, which tool) — never for the blocking set. Because the wired
reporter today forwards only `{event, session_id, tool_name}` (no path), this layer
requires the reporter payload to add `file_path` for Write/Edit events — a
template-hook change shipped via the always-overwrite migration to BOTH duplicated
template copies (which the builder must also reconcile: the migrator's copy already
carries a `cwd` field the init copy lacks), listed in §4. The payload change is
**designed-benign and UNGATED** (the receiver already stores extra fields; a 3-field
payload remains valid; `file_path` is optional) — honestly: it persists under
`enabled:false`, so §2.8's rollback byte-identity claim is scoped to the judge
prompt + signals + sweep, not the reporter payload. Codex gets a PostToolUse reporter group
added to `buildInstarCodexHookGroups` (verified feasible — Codex supports
PostToolUse); gemini/pi have no hook layer and are named advisory-absent. The
session→topic resolution uses a server-side cached map built at run registration
(sessionId ↔ topicId, refreshed on the existing session-respawn record path) — a
resolution miss degrades the ADVISORY layer only (R19; the git sweep is unaffected).

### 2.4 Artifact classes + declared-deliverable grammar (frontloaded) — R20

Class globs (path-based, fully deterministic — the "CLI entry points the session
presents as output" clause is DROPPED as undecidable):

- `deliverable`: `docs/specs/**/*.md` (excluding `*.eli16.md`), `docs/audits/**/*.md`,
  `**/*runbook*.md`, `scripts/**`, `docs/incidents/**/*.md`.
- `companion`: `docs/specs/**/*.eli16.md` — tied to its parent spec path; cleared iff
  the parent clears (a companion alone never blocks and never evades: a "spec" written
  only as an eli16 file has no cleared parent and surfaces via the advisory flag below).
- `scratch`: anything under the scratchpad/`/tmp`/`.worktrees/*/tmp` conventions —
  ledgered, never blocks.
- `out-of-allowlist doc` (advisory): any other new tracked `docs/**/*.md` or `*.md` at
  repo root → sets `scopeAccretionSuspected` (it does not block; it makes evasion by
  path choice visible to the judge and the exit notice).

Declared-deliverable extraction grammar: repo-relative path tokens in the registered
condition text matching `[A-Za-z0-9_./-]+\.(md|sh|mjs|js|cjs|ts|py)` (extension set
aligned with the deliverable globs — `scripts/**` covers js/cjs too) that also match
a deliverable glob, UNION the explicit `declaredDeliverables` list from registration
(§2.1).
**A pathless condition ("draft five specs…") declares NOTHING** — that is the honest
reading of the motivating incident: drafting was the abandonment, so drafts are held
unless the operator declared them at setup or ratifies at exit. (The registration-time
list is the escape for genuinely draft-only missions; it is operator-confirmed at
setup, which bounds the "word the condition broadly" gaming lens.)

### 2.5 Corroboration of "built/delivered" (per-class, monotone, cached) — R21

An accreted deliverable clears ONLY by class-appropriate deterministic evidence,
computed server-side at judge-fire time:

- **Spec:** EITHER (a) the convergence REPORT artifact exists at
  `docs/specs/reports/<slug>-convergence.md` **AND the server's own ceremony record
  corroborates it** (R32 — round 3 caught that the report file alone is as
  self-authorable as the frontmatter marker round 2 rejected): the ceremony already
  calls `POST /spec/conformance-check` on every round against THIS server, so those
  invocations are persisted server-side keyed by spec slug, and the report arm
  clears only when ≥1 recorded conformance-check for the slug falls inside the run
  window — a forged report without a real ceremony run has no server record; OR
  (b) a merged PR that passes the deterministic predicate below.
- **Merged-PR predicate (R33, defined exactly):** the PR's merged diff includes the
  artifact's path AND ≥1 non-`docs/**` path with a combined non-docs diff of ≥10
  changed lines. An artifact's own file NEVER corroborates itself; a docs-only PR
  NEVER corroborates a spec. The residual bundling game (padding a docs PR with a
  trivial 10-line non-docs edit) is NAMED as an accepted deterrence bound: a merged
  PR is a public, attributable artifact — the same honesty framing as R24.
- **Audit/runbook/incident doc:** merged PR containing the file (predicate above,
  own-file rule relaxed: for a doc whose deliverable IS the doc, the merged PR
  containing it suffices), or declared.
- **Script:** merged PR touching the script path.
- **Primary evidence source is git, not the network (R34):** merged-PR reality is
  checked first as `git log origin/main <startSHA>..HEAD -- <path>` in the swept
  root (zero network, rides the same sweep); the batched `gh` query is the fallback
  for cross-repo/branch cases only.

Cost discipline (R22): corroboration runs only on the judge path; merged-PR evidence
is fetched with ONE batched query per evaluation (`gh pr list --state merged
--search "merged:><started_at>"` + name-only diffs), each call `-m`-bounded (10s
total budget); positive corroborations are PERSISTED in the server run record
(monotone — a merged PR stays merged; never re-queried); negatives carry a 5-minute
TTL. A network failure leaves artifacts uncorroborated (fail toward keep-working),
bounded by the breaker (§3) — never a wedge, and the failure is named in the judge
context (`corroborationDegraded: true`).

### 2.6 Ratification — verified-principal, display-integral, server-resolved — R23

Ratification NEVER travels as a client-supplied signal. `parseStopSignals` gains ONE
new whitelisted field total: the advisory boolean `scopeAccretionSuspected` (Layer B,
§2.7). The blocking inputs (`unbuiltAccretedArtifacts`, ratification state) are
computed inside the route. `POST /autonomous/evaluate-completion`'s body gains
`topicId` + `runId` (whitelist-validated; absent topicId = accretion gate inert for
legacy callers, honest degradation logged).

**Arming is server-resolved, never client-selected (R35 — round 3 caught that
"absent topicId = gate inert" was a one-line self-exemption via hook edit).** The
server resolves the topic itself: the sessionId↔topicId map from registration
(§2.1), with the existing topic-session registry as fallback. A done-claim that
carries no resolvable topic while ANY active registered run exists on this server is
REFUSED (`met:false`, reason `unattributed-done-claim`) and raises ONE deduped
attention item (version-skew vs tamper is distinguished by the PostUpdateMigrator
marker state: pre-migration hooks are skew, post-migration omissions are
tamper-shaped and say so). Only a server with ZERO active registered runs treats a
topic-less call as a true legacy caller (gate inert, logged). Similarly, when a run
is registered, the judge evaluates the SERVER-REGISTERED condition text (R36 — the
body `condition` is used only for legacy callers; a divergence between body and
registered condition is logged + flagged, closing the weakened-condition bypass).

Two ratification paths, both terminating in server-owned records:

1. **PIN route (authoritative, phone-first):**
   `POST /autonomous/:topic/ratify-deferral` (dashboard-PIN-gated). Body
   `{"artifacts": ["<repo-relative path>", ...]}` or `{"all": true}` (ratifies the
   set enumerated in the server's current unbuilt list at call time — the response
   echoes exactly what was ratified). Persisted into the server run record
   (survives restarts); audited.

2. **Conversational path (proposal → server-authored enumeration → confirmation).**
   Closes the display-integrity gap (Agent Proposes, Operator Approves): the operator
   must approve a SERVER-authored statement whose displayed set is byte-identical to
   what executes.
   - Trigger: a deterministic scan of the topic's REAL inbound history (the
     adapter's single `telegram-messages.jsonl`, filtered per-topic on read — rows
     carry `messageId` + `telegramUserId`; NOT `MessageStore`, which is the A2A
     store) for defer-intent vocabulary
     (frontloaded list: "defer", "later session", "don't build", "skip building",
     "leave for a future", "ratify deferral") from the VERIFIED operator
     (TopicOperatorStore uid match on the authenticated sender id), windowed to
     `[max(started_at, oldest unbuilt artifact ts), now]` with an indexed/windowed
     read (never a full-store scan).
   - On trigger, the SERVER (not the session) sends the enumeration via
     `TelegramAdapter.sendToTopic` under the server's own bot credentials (R37 —
     component named): "Ratify deferring these N artifacts? <exact repo-relative
     paths> — reply to this message with yes/approve, or use the dashboard." The
     enumeration is clamped (50 paths + "and N more"); if chunked by message-size
     limits, the FIRST chunk's message id is the anchor. The send response's message
     id is recorded in the server run record. Enumerations are deduped per
     unbuilt-set hash: an unchanged set re-uses the recorded enumeration and never
     re-sends (bounded by the K=3 breaker regardless).
   - ONLY a confirmation from the verified operator that is **reply-anchored** —
     a Telegram reply (`reply_to_message_id`) to the recorded enumeration message,
     or a message containing the explicit token "ratify" — with affirmative content
     ("yes", "approve", "confirm", "👍") binds; it binds exactly the enumerated set
     (message-id chain). A bare affirmative NOT reply-anchored resolves to the EMPTY
     set (R38 — round 3 caught that a busy topic's unrelated "yes" post-dating the
     enumeration would otherwise ratify silently; this is the one path that pushes
     toward exit, so it is strict). A pre-accretion blanket "defer those" alone
     ratifies NOTHING; vocabulary-only matches with no anchored confirmation resolve
     to the EMPTY set.
   - The forged-JSONL vector is bounded honestly (R24, reframed by round 3): the
     anchor is an ORDERING constraint, not an authenticity proof — confirmations are
     read from the same local history file, so a session could observe the delivered
     enumeration and append a forged reply-anchored affirmative after it. What the
     design guarantees is that this forgery is a deliberate TWO-STEP fabrication
     that is never a normal workflow step, that the enumeration genuinely lands in
     the operator's real topic (so the attempt is visible live), and that the exit
     notice always lists ratified-deferred artifacts — R12 deterrence, not
     impossibility (§6). Hardening option the builder SHOULD take: consume
     confirmations at the server's in-process Telegram receive path (the server
     long-polls Telegram itself) rather than re-reading the on-disk history — that
     eliminates the forged-row vector outright at near-zero cost.

### 2.7 Advisory layers A and B (unchanged in role, honest in claims)

- **Layer A (recording duty, SKILL.md):** the session SHOULD append
  `- [ ] ACCRETED(<ISO date>): <path> — build/converge/deliver, or obtain operator
  ratification` the moment it creates a deliverable. Willpower-assist for the honest
  case; carries zero safety weight (R9 retained).
- **Layer B (evasion-vocabulary scan):** the stop hook scans the already-extracted
  `CD_JUDGE_TAIL`/`CD_TAIL_LC` window (no second transcript read) for accretion-evasion
  vocabulary ("documented stretch", "filed for a future session", "out of (the)
  completion condition", "drafts for later", "deferred as a follow-up spec") and sets
  the advisory `scopeAccretionSuspected` boolean. The fenced/quoted-region exclusion
  is NEW bash logic (the milestone/injection scans are plain substring matches — the
  round-1 claim that exclusion rules exist to reuse was wrong and is corrected here);
  it ships with captured-fixture tests (§5). Advisory by construction; false negatives
  are harmless (Layer 0 is the defense).

### 2.8 The gate at the chokepoint (deterministic; the judge is not laundered) — R25

Per the Signal-vs-Authority review: the accretion hold is a DETERMINISTIC invariant,
so it is enforced deterministically at the route — not paraphrased into the judge
prompt as if it were judgment. Order of operations in
`POST /autonomous/evaluate-completion`:

1. Compute the sweep (§2.2), corroboration (§2.5), ratification state (§2.6).
2. If unratified, uncorroborated, non-declared deliverables remain → return
   `met:false` with machine-readable `reason: "scope-accretion-hold"` + the path list
   (clamped to 50 + "and N more") WITHOUT spending the judge LLM call. The hook
   surfaces the hold verbatim to the session (it knows exactly what to build).
3. Otherwise → the judge runs exactly as today; the accretion facts ride along as
   CONTEXT lines in the signals block (advisory corroboration for its narrative
   verdict), gated on field presence so disabled mode is byte-identical
   (`PROMPT_VERSION` bumps with the block change; §4).

Rollback = the snapshot's `enabled:false` (config at start, or the operator PIN
override): step 1 short-circuits to "no hold", no sweep runs, the judge prompt is
byte-identical to today.

## 3. Safety analysis — bounded, monotone, no wedge

Every added path is monotone toward "keep working"; there is no code path that
manufactures a false "done." The judge fires only when the checkbox scan says zero
unchecked tasks, so the sweep cost lands only on done-claims (R22).

**The bound on an unbuildable-accretion loop (P19, persisted breaker) — R26.** The CD
circuit breaker counts only judge *failures*, so it cannot bound a legitimate
`met:false` loop. The scope-accretion breaker is its own persisted server-side state:
`{ accretedSetHash, firstSeenAt, consecutiveHolds, lastProgressAt }` in the run
record. `K = 3` consecutive scope-accretion holds with an unchanged set hash and no
new corroboration/ratification (config `scopeAccretion.breakerK`, default 3, min 2)
trips the breaker: ONE loud, distinctly-labeled attention item + topic notice —
"exiting via scope-accretion breaker with N unbuilt accreted artifacts: <list>
(deleted: <sublist>)" — carrying the P13 stop-rationale classification verdict
(recorded, never bypassed: a `buildable` verdict is DISPLAYED in the item so the
operator sees the evasion shape; the breaker still permits the clean exit to
preserve the no-wedge guarantee). The set hash changing, or any new corroboration,
resets the counter. The session's honest early exit for a genuinely blocked artifact
remains the existing `<hard-blocker>` path, unchanged.

**Post-trip semantics (R39):** after the breaker trips and the loud item is raised,
the accretion gate DISENGAGES for that run (subsequent evaluations fall through to
the judge as today) — the exit is permitted, the label is the deterrent, and the
no-wedge guarantee holds.

**EVERY exit is loud, not just the breaker's (R40 — round 3 caught the clock-out
bypass: never claim done, idle to `end_at`, exit silently).** Every run-end surface —
breaker trip, `<hard-blocker>` exit, DURATION EXPIRY, and the normal met-path final
notice — runs a non-blocking advisory sweep and, when the unbuilt accreted set is
non-empty, enumerates it (with the deleted sublist) in the end-of-run notice and
raises the same ONE deduped attention item. The expiry path is never blocked or
delayed (the no-trap guarantee is untouched); it just can no longer be silent. With
R40, §3's claim is true as stated: the incident's SILENT exit is structurally
impossible on every path; what remains is a loud one — the honest floor for a
machine that cannot compel work.

## 4. Config, migration parity + awareness

- **Config:** `autonomousSessions.completionDiscipline.scopeAccretion` =
  `{ enabled: true, breakerK: 3 }` (defaults in `ConfigDefaults.ts`; shape in
  `types.ts`). Default ON (monotone-safe, operator-requested). Snapshot semantics +
  operator PIN override per §2.1 — the "instant rollback" comment text in
  `ConfigDefaults.ts`/`types.ts` and the CLAUDE.md template is REWORDED (change
  sites listed) to name the PIN route as the live lever.
- **Complete change-site list (R27):** `src/server/routes.ts` (NEW
  `POST /autonomous/register`; evaluate-completion: topicId/runId body fields +
  server-resolved arming + registered-condition authority + the deterministic gate;
  the two new PIN-gated routes: ratify-deferral + scope-accretion-override;
  `parseStopSignals`: + `scopeAccretionSuspected` boolean only);
  `src/core/CompletionEvaluator.ts` (context lines, field-gated; `PROMPT_VERSION`
  bump + canary test); the server run-record store (new module,
  `state/autonomous-server/` — incl. the ceremony-record persistence hook in the
  conformance-check route, R32); the git sweep helper (read-only,
  `SafeGitExecutor.readSync` verbs, worktree enumeration R31);
  `src/core/WorkingSetManifest.ts` (a scan line for the new store dir; archived
  records excluded); the reporter payload `file_path` extension in BOTH duplicated
  template copies (`src/commands/init.ts` + `src/core/PostUpdateMigrator.ts` — sync
  them, reconciling the pre-existing `cwd` divergence); `buildInstarCodexHookGroups`
  (+ PostToolUse reporter group); `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh`
  (Layer B scan; surface the hold reason verbatim; echo runId; marker bump
  `SCOPE_ACCRETION`); `SKILL.md` + `setup-autonomous.sh` (Layer A duty; the
  registration call + `declaredDeliverables` flag; marker bump); `PostUpdateMigrator`
  (marker bumps, REALCHECK_VERIFY-precedent); config defaults in
  `src/config/ConfigDefaults.ts` + the `scopeAccretion` shape in `src/core/types.ts`
  (comment contracts reworded per R14); CLAUDE.md template awareness section +
  `migrateClaudeMd`; feature-metrics key `scope-accretion` (holds, breaker trips,
  ratifications, enumerations, sweep latency, unattributed-done-claim refusals).
- **Multi-machine posture:** all new state is machine-local BY DESIGN (a run executes
  on one machine); the server run record + advisory ledger ride the working-set
  carrier on transfer (verified: the manifest nominates `autonomous/<topic>.*` by
  prefix — the server-record path is added to the manifest's nomination globs, listed
  as a change site). Signals are recomputed per evaluation.
- **Ledger/record lifecycle (R28, trigger made real by round 3 — there is no
  "state-file archive"; the hook `rm -f`s the state file, and the server has no
  run-end signal today):** a run record is archived (renamed `.archived.json`, same
  retention policy as logs) when (a) a NEW registration arrives for the same topic
  (lazy archive of the predecessor), or (b) a daily sweep finds a record whose
  `end_at` passed >24h ago. Archived records are excluded from the working-set
  carrier nomination.
- **Audit discipline:** booleans + pattern-names + path basenames only; ratification
  records store `{ enumerationMessageId, confirmationMessageId, verifiedOperatorUidHash,
  ratifiedArtifacts }`, never message bodies; realcheck secret-scrub before write.
- **Dev-first soak:** feature-metrics observed on the development agent before the
  fleet default is trusted (`scope-accretion` key); the deterministic core carries the
  guarantee regardless. Maturation-path note: default-ON everywhere is the documented,
  justified exception (monotone-safe discipline fix, operator-directed) — recorded
  here explicitly so the conformance gate's dev-agent-first check reads an honest
  declaration rather than silence.

## 5. Tests (tiers declared; parsers registered with captured fixtures)

**Fixture realness (R29):** the three new text parsers are REGISTERED per the
standard, each fed byte-for-byte captured fixtures under `tests/fixtures/captured/`:
(1) Layer B scan — a real autonomous-run transcript tail (incl. fenced/quoted regions
and ANSI); (2) ratification trigger + confirmation matcher — real per-topic Telegram
JSONL rows; (3) declared-deliverable grammar — real registered completion-condition
texts (including the pathless "draft five specs" incident shape asserting EMPTY set).

Unit: sweep classifier (per class glob; deletion flag; out-of-allowlist advisory;
clamps); corroboration resolver (report-exists / merged-PR-with-non-docs-path /
declared → cleared; self-file, docs-only PR, self-inserted frontmatter marker,
checked checkbox → NOT cleared; positive-persistence monotonicity; negative TTL);
ratification (PIN route body forms; enumeration→confirmation ordering; pre-dated
blanket → empty; non-operator sender → refused; vocabulary-only → empty);
snapshot semantics (mid-run config/state-file/condition edits ignored + flagged;
PIN override honored); breaker (K holds → trip with recorded P13 verdict; set-change
resets; persisted across server restart); `parseStopSignals` whitelists
`scopeAccretionSuspected` only and rejects client-supplied `unbuiltAccretedArtifacts`
/`operatorRatifiedDeferral`; prompt byte-identity when disabled + `PROMPT_VERSION`
canary. Hook: hold-reason surfaced; Layer B fixture positives/negatives; no second
transcript read. Integration: evaluate-completion round-trips topicId → hold →
ratify → met-path; both PIN routes (auth, contract, persistence); timeout/degraded
corroboration path. E2E (feature-alive): a run that creates `docs/specs/foo.md` VIA
BASH HEREDOC (the required evasion-shaped case) and presents a met-looking transcript
does NOT exit until corroborated/ratified; and the breaker-exit E2E asserting the
loud labeled item. Wiring-integrity: reporter payload carries a real `file_path`
end-to-end into the advisory ledger on both template copies; Codex PostToolUse group
fires.

## Frontloaded Decisions

1. **The load-bearing mechanism is the server-side git-truth sweep at the
   evaluate-completion chokepoint** (R15) — not a transcript scan (tail-blind), not
   the checkbox (self-writable), not a client-side tool-event ledger (Bash-bypassable,
   session-writable, path-less in today's payload). Tool events survive only as an
   advisory attribution ledger (R18).
2. **No blocking input is client-transported, INCLUDING the arming** (R23+R35):
   `parseStopSignals` gains only the advisory `scopeAccretionSuspected`; the route
   computes the rest server-side, resolves the topic from its OWN registration map,
   REFUSES unattributed done-claims while registered runs are active, and judges the
   SERVER-registered condition (R36). The run lifecycle is anchored by the new
   `POST /autonomous/register` route (R30) — one registration per active run,
   immutable declared list.
3. **Ratification is display-integral**: PIN route, or verified-operator confirmation
   of a SERVER-authored enumeration that post-dates the artifacts and is bound by
   message-id chain (R23/R24). Blanket pre-accretion phrases ratify nothing. Store
   identity corrected: the per-topic Telegram inbound JSONL, not `MessageStore`.
4. **Corroboration is per-class and never self-authorable** (R21+R32+R33+R34):
   spec-class clears by report+server-recorded-ceremony-evidence or the exact
   merged-PR predicate (≥1 non-docs path, ≥10 non-docs lines, never the artifact's
   own file alone); git-first evidence (SHA-anchored), gh fallback; positives
   persist (monotone).
5. **Class boundary is glob-only** (R20): the undecidable "presents as output" clause
   is dropped; eli16 companions clear with their parent; out-of-allowlist docs are
   advisory-flagged, never blocking.
6. **Declared-deliverable grammar is fixed** (R20): path-token regex ∩ deliverable
   globs, ∪ explicit registration list; pathless conditions declare nothing.
7. **Config snapshots at registration, server-side; the operator's live lever is the
   PIN override route** (R13/R14); mid-run session-side edits (config, state file,
   condition text) are ignored + flagged.
8. **Deletion of an accreted deliverable never clears it silently** (R17) — flagged,
   listed loudly at exit, clearable only by ratification/corroboration.
9. **The hold is a deterministic pre-judge gate** (R25) — the judge is not asked to
   re-decide a regex's verdict; it receives the facts as context on the met-path only.
10. **Breaker: K=3 (config `breakerK`), persisted state, loud labeled exit carrying
    the P13 classification; post-trip the gate disengages for the run** (R26+R39) —
    surface-to-operator-and-stop, never silent churn, never a wedge. **Every exit
    surface — including duration expiry and the normal final notice — runs the
    advisory sweep and enumerates a non-empty unbuilt set loudly** (R40): the silent
    clock-out is structurally closed.
11. **Default ON with the documented maturation-path exception** (contested and
    cleared in round 1; re-affirmed with the R14 operator lever in place).
12. **Framework parity by construction** (R16): the load-bearing core is
    engine-independent (git + server); Codex gains the advisory PostToolUse group;
    gemini/pi named advisory-absent. Honest degradation, never silent absence.

## 6. Residual risks (the honest bounds register — R12 applied)

- **Same-machine tamper:** a full-shell agent can, in the limit, edit server state
  files or the server itself. Bound: no load-bearing input lives in files the
  session routinely writes; tampering is never a normal workflow step, is
  individually detectable, and is a visible attributable lie (constitution framing).
- **Forged confirmation (two-step):** induce an enumeration, then append a forged
  reply-anchored operator row to the local history. Non-normal-workflow, visible
  live in the operator's real topic, listed at exit; eliminated outright if the
  builder takes the in-process receive-path option (R24).
- **Out-of-root writes:** deliverables written to repos/dirs outside the swept root
  set (R31) are invisible to the blocking sweep; the advisory ledger flags them as
  suspected when it saw the Write. Accepted bound, stated.
- **Backdated commits:** mitigated by SHA-anchored sweeps (R31) — a commit is seen
  regardless of its dates; only history rewritten below the recorded start-SHA
  evades, which is tamper-class, not workflow-class.
- **Report+ceremony forgery:** clearing a spec via arm (a) of R32 requires forging
  BOTH the report file AND a server-recorded conformance-check invocation in-window
  — the latter requires actually calling the gate, which records what it checked.
  Cost exceeds running the real ceremony.
- **Docs-PR bundling:** the R33 predicate's ≥10-line non-docs floor is a deterrence
  bound, not proof of implementation — named, accepted, loud (a merged PR is public
  and attributable).

## Open questions

None.
