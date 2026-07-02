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

### 2.1 Start snapshot (server-side, at run registration) — R13

When an autonomous run registers (the existing setup path that creates the run
record), the SERVER snapshots into a server-owned run record
(`state/autonomous-server/<topicId>.<runId>.json`, written only by the server):

- `scopeAccretion` config (the whole sub-object) — closes the mid-run self-disable
  bypass at the correct layer: the session editing `.instar/config.json` OR its own
  state-file frontmatter changes nothing the chokepoint reads.
- The completion-condition text as registered, and the **declared-deliverable set**
  parsed from it by the frontloaded grammar (§2.4), plus an optional explicit
  `declared_deliverables:` list that `setup-autonomous.sh` writes at registration
  (exact repo-relative paths). Mid-run edits to the state-file condition are ignored
  for accretion purposes and flagged (attention item, deduped per run).
- The run's `work_dir` and repo roots (the git sweep's scope, §2.2).

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
in the snapshotted repo roots:

- New tracked/untracked files since `started_at` matching deliverable globs:
  `git log --since <started_at> --diff-filter=ACR --name-only` (committed) plus
  `git status --porcelain` (uncommitted), filtered by class globs (§2.4).
- The sweep is read-only, bounded (`-m`-style timeout, path-count clamp of 200), and
  runs in-process on the server — no data crosses from the session's environment.

Why git truth: it catches files created by Write/Edit, Bash heredocs, `tee`, `cp`,
`mv`-from-scratch, python scripts, and subagent sessions identically (P20 — the file
in the tree is the state; the tool event was only a symbol). It is also
**framework-agnostic by construction** (R16): a Codex/Gemini/pi autonomous run gets
the identical load-bearing guarantee, because the server asks git, not the engine's
hook layer. This resolves the framework-agnostic conformance flag for the
load-bearing core; the advisory tool-event ledger below remains Claude-first with
Codex wiring, and gemini/pi are explicitly advisory-absent (named, honest).

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
template-hook change shipped via the always-overwrite migration, listed in §4, and
**gated so the payload change is benign everywhere** (3-field payload remains valid;
the receiver treats `file_path` as optional). Codex gets a PostToolUse reporter group
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
condition text matching `[A-Za-z0-9_./-]+\.(md|sh|mjs|ts|py)` that also match a
deliverable glob, UNION the explicit `declared_deliverables:` list from registration.
**A pathless condition ("draft five specs…") declares NOTHING** — that is the honest
reading of the motivating incident: drafting was the abandonment, so drafts are held
unless the operator declared them at setup or ratifies at exit. (The registration-time
list is the escape for genuinely draft-only missions; it is operator-confirmed at
setup, which bounds the "word the condition broadly" gaming lens.)

### 2.5 Corroboration of "built/delivered" (per-class, monotone, cached) — R21

An accreted deliverable clears ONLY by class-appropriate deterministic evidence,
computed server-side at judge-fire time:

- **Spec:** the convergence ceremony's REPORT artifact exists at
  `docs/specs/reports/<slug>-convergence.md` (the artifact the ceremony writes — a
  self-inserted `review-convergence:` frontmatter line clears NOTHING, closing the
  self-stamp hole), OR a merged PR whose diff touches **at least one non-`docs/**`
  path** attributable to the spec's implementation. An artifact's own file NEVER
  corroborates itself, and a docs-only merged PR NEVER corroborates a spec (closing
  merge-your-own-spec).
- **Audit/runbook/incident doc:** merged PR containing the file, or declared.
- **Script:** merged PR touching the script path.

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
   - Trigger: a deterministic scan of the topic's REAL inbound history (the per-topic
     Telegram JSONL the adapter writes — NOT `MessageStore`, which is the A2A store;
     store identity corrected per review) for defer-intent vocabulary
     (frontloaded list: "defer", "later session", "don't build", "skip building",
     "leave for a future", "ratify deferral") from the VERIFIED operator
     (TopicOperatorStore uid match on the authenticated sender id), windowed to
     `[max(started_at, oldest unbuilt artifact ts), now]` with an indexed/windowed
     read (never a full-store scan).
   - On trigger, the SERVER (not the session) sends the enumeration: "Ratify
     deferring these N artifacts? <exact repo-relative paths> — reply yes/approve, or
     use the dashboard." The enumeration message id is recorded server-side.
   - ONLY an affirmative reply ("yes", "approve", "confirm", "👍") from the verified
     operator that POST-DATES the enumeration binds — and it binds exactly the
     enumerated set (recorded by message-id chain). A pre-accretion blanket "defer
     those" alone ratifies NOTHING (it can only trigger an enumeration of artifacts
     that already exist); vocabulary-only matches with no enumeration-confirmation
     resolve to the EMPTY set.
   - The forged-JSONL vector is bounded honestly (R24): a forged inbound row could at
     most trigger an ENUMERATION (visible to the real operator in the real topic);
     it cannot confirm, because the confirmation must post-date the server's own
     recorded enumeration message id — an out-of-band anchor the session cannot
     pre-author. Residual risk (forging a confirmation row after inducing an
     enumeration) is named in §6 with the same-machine bound of R12, and the exit
     notice always lists ratified-deferred artifacts, making a forged ratification a
     visible, attributable lie in the operator's own topic.

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

**Why the breaker is not a cheap exit lever:** the price is K judge-path holds PLUS a
permanently-recorded, operator-visible item enumerating exactly what was abandoned —
the incident's silent exit is structurally impossible; what remains is a loud one,
which is the honest floor for a machine that cannot compel work.

## 4. Config, migration parity + awareness

- **Config:** `autonomousSessions.completionDiscipline.scopeAccretion` =
  `{ enabled: true, breakerK: 3 }` (defaults in `ConfigDefaults.ts`; shape in
  `types.ts`). Default ON (monotone-safe, operator-requested). Snapshot semantics +
  operator PIN override per §2.1 — the "instant rollback" comment text in
  `ConfigDefaults.ts`/`types.ts` and the CLAUDE.md template is REWORDED (change
  sites listed) to name the PIN route as the live lever.
- **Complete change-site list (R27):** `src/server/routes.ts` (evaluate-completion:
  topicId/runId body fields, the deterministic gate, the two new PIN-gated routes:
  ratify-deferral + scope-accretion-override; `parseStopSignals`: + `scopeAccretionSuspected`
  boolean only); `src/core/CompletionEvaluator.ts` (context lines, field-gated;
  `PROMPT_VERSION` bump + canary test); the server run-record store (new module,
  `state/autonomous-server/`); the git sweep helper (read-only, SafeGitExecutor-familied);
  the reporter payload `file_path` extension in BOTH duplicated template copies
  (`src/commands/init.ts` + `src/core/PostUpdateMigrator.ts` — kept in sync, receiver
  treats it optional); `buildInstarCodexHookGroups` (+ PostToolUse reporter group);
  `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh` (Layer B scan; surface the
  hold reason; marker bump `SCOPE_ACCRETION`); `SKILL.md` + `setup-autonomous.sh`
  (Layer A duty; `declared_deliverables:` registration; marker bump); `PostUpdateMigrator`
  (marker bumps, REALCHECK_VERIFY-precedent); CLAUDE.md template awareness section +
  `migrateClaudeMd`; feature-metrics key `scope-accretion` (holds, breaker trips,
  ratifications, sweep latency).
- **Multi-machine posture:** all new state is machine-local BY DESIGN (a run executes
  on one machine); the server run record + advisory ledger ride the working-set
  carrier on transfer (verified: the manifest nominates `autonomous/<topic>.*` by
  prefix — the server-record path is added to the manifest's nomination globs, listed
  as a change site). Signals are recomputed per evaluation.
- **Ledger/record lifecycle (R28):** on run end the server run record + advisory
  ledger are archived beside the state-file archive (same retention), so the carrier
  never ships stale live records.
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
2. **No blocking input is client-transported** (R23): `parseStopSignals` gains only
   the advisory `scopeAccretionSuspected`; the route computes the rest server-side.
   `evaluate-completion` gains `topicId`/`runId` body fields.
3. **Ratification is display-integral**: PIN route, or verified-operator confirmation
   of a SERVER-authored enumeration that post-dates the artifacts and is bound by
   message-id chain (R23/R24). Blanket pre-accretion phrases ratify nothing. Store
   identity corrected: the per-topic Telegram inbound JSONL, not `MessageStore`.
4. **Corroboration is per-class and never self-authorable** (R21): convergence
   REPORT artifact (not a frontmatter line), merged PR with ≥1 non-docs path (never
   the artifact's own file alone), or registration-declared. Positives persist
   (monotone); one batched bounded query per evaluation.
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
    the P13 classification** (R26) — surface-to-operator-and-stop, never silent churn,
    never a wedge.
11. **Default ON with the documented maturation-path exception** (contested and
    cleared in round 1; re-affirmed with the R14 operator lever in place).
12. **Framework parity by construction** (R16): the load-bearing core is
    engine-independent (git + server); Codex gains the advisory PostToolUse group;
    gemini/pi named advisory-absent. Honest degradation, never silent absence.

## Open questions

None.
