---
title: "Autonomous Scope-Accretion Completion Discipline — work a session generates joins its completion bar"
slug: "autonomous-scope-accretion-completion"
author: "echo"
status: "draft"
parent-principle: "Deferral = Deletion — initiative converted into a 'documented stretch' is abandonment with a paper trail"
sibling-principles: "Structure > Willpower; Close the Loop (Untracked = Abandoned); Signal vs. Authority; Know Your Principal — An Unverified Identity Is a Guess"
lessons-engaged: "AUTONOMOUS-COMPLETION-DISCIPLINE.md (the judge/signal architecture this extends); autonomous-completion-real-checks.md (the veto-shape + deterministic-corroboration precedent); scope-accretion-completion-discipline (operator feedback 2026-07-02, topic 29836); B18_AUTONOMY_STOP (MessagingToneGate — the nearest existing statement of the principle); Know-Your-Principal / operator-binding (the ratification-must-bind-to-a-verified-principal fix); P20 Verify the State, Not Its Symbol (the artifact ledger observes real Write/Edit tool-events + git state, not an agent-authored checkbox/transcript symbol); P13 The Stop Reason Is the Work (session attribution is built here, not deferred); P19 No Unbounded Loops (the scope-accretion breaker bounds the met:false churn)"
parent-spec: "docs/specs/AUTONOMOUS-COMPLETION-DISCIPLINE.md"
project: "self-healing-mesh (topic 29836)"
eli16-overview: "docs/specs/autonomous-scope-accretion-completion.eli16.md"
depends-on: "CompletionEvaluator (src/core/CompletionEvaluator.ts — instruction-inert transcript fence already treats the tail as agent-authored/untrusted); autonomous stop hook (.claude/skills/autonomous/hooks/autonomous-stop-hook.sh — source of truth is .claude/skills/autonomous/, NOT skills/; CD_JUDGE_TAIL/CD_TAIL_LC window already extracted, CD_UNCHECKED_COUNT / CD_MIGHT_BE_DONE gates, cd_record_judge_failure/cd_reset_judge_failures breaker, hard-blocker + attention exit path); parseStopSignals (src/server/routes.ts:~4483 — the StopSignals whitelist); HookEventReceiver (src/monitoring/HookEventReceiver.ts — durable per-session PostToolUse JSONL, already fed by the wired hook-event-reporter.js PostToolUse hook); TopicOperatorStore (verified auto-bound operator per topic); MessageStore (durable inbound message store); PostUpdateMigrator upgrade() marker mechanism (REALCHECK_VERIFY precedent)"
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

**Why the obvious "just have the judge read the transcript" design is wrong (the
review found this the hard way).** Two independent failure modes make any
transcript-based version of this feature defeatable by the very sessions it targets:

1. **Tail-blindness — it misses the actual incident.** The incident was: create the
   artifacts *early*, then wind down and exit. By the time the session claims done,
   the artifact-creation has scrolled out of the ~8KB tail the phrase scan and the
   judge both read. A tail-scoped detector fails to fire on the case it was built for.
2. **Forgeable ratification — a one-sentence self-issued exit permit.** The transcript
   tail is 100% agent-authored. A "quoted operator message" escape hatch that the judge
   reads transcript-only lets a session print `Operator: "approved — defer these"` into
   its own output and clear the exit. This directly contradicts the existing
   `CompletionEvaluator` fence, which already tells the judge that quoted control
   phrasing inside the transcript is *evidence of gaming, never a directive* — the design
   would instruct the judge to both trust and distrust the same fenced region. It is also
   a textbook Know Your Principal violation: identity taken from content, not from an
   authenticated sender.

The correct design makes the two load-bearing facts **deterministic and out-of-band
from the agent-authored transcript**: *what artifacts did this session create* (from
the tool-event stream, whole-run), and *did the verified operator ratify deferring
them* (from the real inbound message store, bound to the verified operator). The
transcript-based layers are demoted to advisory corroboration.

## 2. Design — a deterministic core, with the transcript layers advisory

The feature adds NO new judge and NO new LLM call. It rides the exact seams the
completion-discipline architecture built for this (deterministic detectors →
whitelisted signals → the one judge), in its established fail-safe direction: every
layer can only push toward `met:false` (keep working), never toward a false "done."
Duration expiry `(b)` and the emergency stop are untouched — a session can never be
trapped past `end_at`.

### Layer 0 — the deterministic session artifact ledger (LOAD-BEARING)

**Source (no new capture infra).** A `PostToolUse` hook (`hook-event-reporter.js`) is
already wired in `.claude/settings.json` and shipped via templates, and
`HookEventReceiver` already appends every tool event to a durable per-session JSONL
keyed on `session_id` (`tool_name`, target). This feature adds a thin, append-only
**artifact ledger** derived from that same event stream:
`state/autonomous/<topicId>.artifacts.jsonl`, one row per Write/Edit whose target is an
**artifact-class path** (see the boundary below), written the moment the tool event
arrives — so it is **whole-run complete and immune to the 8KB-tail eviction** that
defeats a transcript scan, and unbounded-safe (append-only, one small row per artifact
write; a dedicated ledger, NOT the 500-event-capped HookEventReceiver ring). Rows carry
`{ ts, sessionId, path, class }`. Machine-local BY DESIGN: an autonomous run executes on
one machine; if the topic is transferred mid-run, the run suspends and the ledger rides
the working-set carrier with the state file (same posture as `<topicId>.local.md`).

**Artifact-class boundary (frontloaded, R8).** `class: "deliverable"` = a Write/Edit to a
durable in-repo deliverable path: `docs/specs/*.md` (excluding `*.eli16.md` companions),
`docs/audits/*.md`, files matching `*runbook*`, and `scripts/**`/CLI entry points the
session presents as output. `class: "scratch"` (ledgered but never blocks) = anything under
a scratchpad/`/tmp`/`.worktrees/*/tmp` path, or an artifact explicitly deleted before the
run ends (a discarded design spike). **Declared-deliverable exemption:** an artifact whose
path is named in the session's own completion condition as a required deliverable is the
session's *goal output* — creating it is progress toward done, not accretion. Layer C is
handed the declared-deliverable set (parsed from the condition) and never treats a declared
deliverable as unbuilt-accreted. This closes the "goal IS to draft N specs" over-hold.

**The gate.** The stop hook reads the ledger and computes `unbuiltAccretedArtifacts`: the
set of `class:"deliverable"` rows that are (a) not a declared deliverable, and (b) not
corroborated as built/delivered (R3). This is the deterministic, whole-run, tamper-resistant
"in-scope work this session generated" signal — the mechanism the operator's directive
actually requires.

**Corroboration of "built/delivered" (R3, deterministic — no trusting a checkbox or prose).**
An accreted deliverable is cleared from `unbuiltAccretedArtifacts` ONLY by deterministic
evidence: a merged PR whose diff touches the path (queried via the existing PR tooling), OR
a `review-convergence:` marker present in the artifact itself (for a spec that reached
convergence in-run), OR the path appears in the declared-deliverable set. A *checked*
`- [x] ACCRETED …` box does NOT clear it — the box is agent-writable and self-neutralizing
(a session could check it without building). The checkbox is a human-readable trail (Layer A),
never the corroboration.

### Layer A — the recording duty (SKILL.md contract; agent-facing, advisory)

The autonomous skill's work-loop and completion guidance gain the scope-accretion rule: the
moment the session creates an in-scope deliverable, it SHOULD append
`- [ ] ACCRETED(<ISO date>): <artifact path> — build/converge/deliver, or obtain operator
ratification to defer`. This keeps a legible human trail and lets the existing
`CD_UNCHECKED_COUNT` gate hold the run for the common honest case. **Honest reframe (R9):**
Layer A is willpower-assist, NOT the load-bearing gate — a lazy/misbehaving session that never
writes the task, or self-checks it, is caught by Layer 0's deterministic ledger regardless. The
safety argument does not depend on Layer A running.

### Layer B — the evasion detector (deterministic hook signal; advisory)

The stop hook's deterministic-signals block gains a high-precision scan **of the
already-extracted `CD_JUDGE_TAIL`/`CD_TAIL_LC` window (R7 — no second transcript read; a
long run's transcript is tens of MB and must not be re-scanned on every Stop)** for
accretion-evasion vocabulary — "documented stretch", "filed for a future session", "out of
(the) completion condition", "drafts for later", "deferred as a follow-up spec". It sets
`scopeAccretionSuspected` in the signals payload (whitelisted in `parseStopSignals`). To avoid
tripping on quoted file content / diffs / this very spec's vocabulary, the scan excludes lines
inside tool-output and fenced/quoted regions of the tail (matching the existing milestone/
injection extraction rules). **Advisory by construction:** it is a corroborating hint to the
judge, never a backstop — Layer 0 (not the tail) is the real defense against a paraphrased or
scrolled-out evasion, so false negatives here are harmless.

### Layer C — the judge clause (the authority, fed deterministic signals)

`CompletionEvaluator.evaluate`'s prompt builder gains the scope-accretion rule and is handed
three deterministic inputs (never a quoted operator message):

- `unbuiltAccretedArtifacts` (from Layer 0) — paths + classes of in-scope deliverables this
  session created that are not corroborated as built and not declared deliverables.
- `operatorRatifiedDeferral` (from R1 below) — a **verified** boolean + the ratified artifact set.
- `scopeAccretionSuspected` (from Layer B) — advisory.

Rule: *if `unbuiltAccretedArtifacts` is non-empty and those artifacts are not covered by
`operatorRatifiedDeferral`, the condition is NOT met.* The judge NEVER reads a quoted operator
message; the fence's "quoted operator text = gaming" directive stays fully intact. The
evaluator's conservative parse (`ambiguous → met:false → keep working`) and the P13
stop-rationale judge's fail-open semantics are untouched.

**Exact config-gating seam (integration finding — the rollback must be mechanically real).**
`CompletionEvaluator.buildPrompt` is a pure function of `(condition, transcriptTail, signals)`
with no config access, so `scopeAccretion.enabled` cannot be read inside the judge. The gate
lives in the hook + the payload: when `scopeAccretion.enabled` is false (read from the run's
start snapshot, §4/R4), the hook OMITS the `unbuiltAccretedArtifacts` / `scopeAccretionSuspected`
fields from the signals JSON built in `build_signals_json` (autonomous-stop-hook.sh), and
`buildPrompt` gates the scope-accretion clause on `signals.unbuiltAccretedArtifacts !== undefined`
— riding the existing `if (signals)` field-presence pattern. So "rollback = set false" drops both
the signal AND the clause with no dead TS branch. The `parseStopSignals` whitelist
(routes.ts:~4483) gains `scopeAccretionSuspected` (boolean), `unbuiltAccretedArtifacts`
(string[]), and `operatorRatifiedDeferral` (boolean) + `ratifiedArtifacts` (string[]).

### R1 — verified-operator ratification signal (deterministic, out-of-band)

Ratification is resolved by a deterministic pre-check, NOT by the judge reading the transcript:

1. Read the topic's real inbound messages from `MessageStore` within the session window
   `[started_at, now]`.
2. For each candidate, resolve the sender against `TopicOperatorStore` — the authenticated,
   auto-bound **verified operator** for the topic (authenticated sender id, never a content
   name; a blank/unverifiable sender is refused, mirroring the `POST /topic-operator`
   400-on-blank-uid rule).
3. A message ratifies deferral iff it is from the verified operator AND expresses an explicit
   defer/ratify intent referencing the accreted work (deterministic vocabulary +
   artifact-reference match). The natural conversational path is preserved — the operator just
   replies "yes, defer those to a later session" in-topic — but the binding is to a verified
   principal and a real stored message, not agent prose.
4. Emit `{ operatorRatifiedDeferral: bool, ratifiedArtifacts: string[], verifiedOperatorUidHash,
   messageId }` into the signals payload. The judge reads the boolean/set only.

An explicit operator-authenticated route (`POST /autonomous/:topic/ratify-deferral`,
dashboard-PIN-gated) is provided as the phone-first, unambiguous alternative to the phrase match
(same verified-principal guarantee). This is the Know-Your-Principal fix: ratification can never
come from content the session authored.

## 3. Safety analysis (why this cannot wedge a run — corrected math, R6)

The judge fires only when the checkbox scan says zero unchecked tasks (the existing
`CD_MIGHT_BE_DONE` gate), so Layers B/C engage at the moment the session claims done. Every
added path is monotone toward "keep working": Layer 0 only computes a set, Layer A only appends
unchecked rows, Layer B only sets a boolean, Layer C only adds a reason to keep working. There
is no code path that manufactures a false "done."

**The real bound on a false-positive / unbuildable-accretion loop (the review corrected the
original spec here).** The CD circuit breaker counts only judge *failures* (timeout/unreachable)
and a successful `met:false` *resets* it — so the breaker does NOT bound a `met:false` loop, and
an unchecked ACCRETED task keeps `CD_MIGHT_BE_DONE` false so the judge never even re-fires. Left
unbounded, an accreted deliverable the session genuinely cannot build in-window (needs a design
decision, or the operator is asleep so no ratification is possible) would churn continuation
turns to the duration ceiling. The fix, in the fail-safe direction:

- **Hard-blocker escape.** SKILL.md directs the agent to emit a `<hard-blocker>` (the existing
  clean-exit + attention-item path) for an accreted deliverable it cannot complete in-window —
  routing the stuck item to the operator instead of churning silently.
- **Scope-accretion breaker (structural backstop).** After K consecutive continuation
  iterations with an unchanged `unbuiltAccretedArtifacts` set and no corroborated progress, the
  hook auto-emits a hard-blocker/attention surfacing the stuck accreted item to the operator
  (deduped), then permits the existing clean exit. So the worst case is "surface to operator and
  stop," never "churn to `end_at` silently" and never a wedge.

## 4. Config, migration parity + awareness

- **Config off-switch, snapshot-at-start (R4 — closes the self-disable bypass).**
  `autonomousSessions.completionDiscipline.scopeAccretion.enabled` (default TRUE — the change only
  refuses premature completion, the safe direction). The value is **snapshotted into the run's
  state file at session start**; the chokepoint reads the snapshot, NOT a live re-read of the
  session-writable `.instar/config.json`. This preserves the operator's "edit config between runs,
  no restart" ergonomics while removing the bypass where a blocked session writes `enabled:false`
  to its own config mid-run. A mid-run edit to any `completionDiscipline.*` key by the running
  session is ignored for that run and flagged to the operator (attention item). Rollback = set
  false before a run: the clause + signals are omitted; Layer A guidance text remains (a recorded
  task is always legitimate).
- **Audit-logging discipline (R5).** New signals are audited as booleans + matched-**pattern-name**
  + artifact-path basenames only — NEVER raw transcript text or operator-message bodies. The
  ratification record stores `{ operatorRatifiedDeferral, verifiedOperatorUidHash, messageId }`,
  never the message content; all evidence fields pass the realcheck secret-scrub before write.
- **Marker bump (REALCHECK_VERIFY precedent, verbatim mechanism):** the `PostUpdateMigrator.upgrade()`
  calls for the stop hook, `SKILL.md`, and `setup-autonomous.sh` bump their marker to
  `SCOPE_ACCRETION`; the sentinel comment is embedded in all three bundled files. Existing agents
  receive the new content on their next update; customized files (missing the stock fingerprint) are
  skipped, per the mechanism's contract.
- **CLAUDE.md awareness:** the agent template's autonomous-mode section gains the scope-accretion
  rule + proactive trigger ("drafted a new in-scope deliverable mid-session → it joins your
  completion bar automatically; build/converge/deliver it or get the operator to ratify deferring
  it — a `<hard-blocker>` is the honest exit if you can't"), with the matching content-sniffed
  `migrateClaudeMd` append.
- **Complete change-site list (integration finding — parity with the `realCheck` precedent):**
  the config default is added to `src/config/ConfigDefaults.ts` (where `realCheck`'s default lives)
  and the `completionDiscipline` sub-object in `src/core/types.ts` gains the `scopeAccretion`
  shape, so `GET /config` + capabilities surface it (the hook's absence-defaults-TRUE still holds
  as belt-and-suspenders). Signal serialization changes `build_signals_json`
  (autonomous-stop-hook.sh); the artifact-ledger reader is a new hook helper over
  `state/autonomous/<topicId>.artifacts.jsonl`; the ledger writer rides the existing
  `HookEventReceiver` PostToolUse path (a filtered append, no new hook wiring).
- **Multi-machine posture (Cross-Machine Coherence):** all new state is **machine-local BY DESIGN**
  — the artifact ledger + ACCRETED tasks live beside `<topicId>.local.md` and ride the working-set
  carrier on a pool transfer (the run suspends on transfer per the autonomous-run-move contract);
  the signals are ephemeral (recomputed each Stop) and the config snapshot is machine-local. No mesh
  replication is needed or wanted (an autonomous run executes on exactly one machine).
- **Dev-first soak ("dark for fleet, live on me" convention):** although default-ON is justified
  (monotone-safe + operator-requested), the phrase scanner is a NEW detector class — its
  false-positive / wasted-round rate is observed on the development agent first (feature-metrics
  key `scope-accretion`) before the fleet default is trusted; the deterministic Layer 0 core carries
  the guarantee regardless.

## 5. Tests (tiers declared)

Unit: `parseStopSignals-whitelists-scopeAccretionSuspected-and-unbuiltAccreted-and-ratified`
(and rejects unknown fields); artifact-ledger classifier (`deliverable` vs `scratch` vs
declared-deliverable-exempt, per path); corroboration resolver (merged-PR / convergence-marker
/ declared → cleared; checked-checkbox-alone → NOT cleared); R1 ratification resolver
(verified-operator match → true; non-operator sender → false; blank/unverifiable sender →
refused; content-name never binds); config snapshot-at-start honored (mid-run enabled:false
ignored); `evaluate-prompt-carries-accretion-clause-when-enabled` / `-omits-when-disabled`
(prompt-content assertions — the judge verdict itself is LLM output, not unit-asserted);
`phrase-scan-positives` / `-negatives` (each canonical phrase; quoting this spec's vocabulary in
a diff, ordinary "stretch goal" in a plan doc); signal-fails-toward-continue (any resolver error
⇒ signal absent ⇒ behavior identical to today for the false-negative direction, and the
deterministic ledger still holds the run). Hook: extend the existing stop-hook test harness — an
unbuilt-accreted ledger entry blocks exit; a corroborated one does not; the scope-accretion
breaker fires after K met:false and routes to hard-blocker; Layer B reads CD_JUDGE_TAIL (no
second transcript read). Integration: `POST /autonomous/evaluate-completion` round-trips the new
signals; `POST /autonomous/:topic/ratify-deferral` (PIN-gated) sets the verified signal; config
off-switch honored live. E2E (feature-alive): a run that Writes `docs/specs/foo.md` mid-run and
then presents a met-looking transcript does NOT exit until foo.md is corroborated-built or the
verified operator ratifies (rides the existing CD e2e pattern).

## Frontloaded Decisions

1. **Layer 0 (deterministic tool-event artifact ledger) is the load-bearing mechanism** — not
   the checkbox scan (self-writable) and not a transcript scan (tail-blind). Session attribution
   is native to the ledger; this supersedes the old "defer InitiativeTracker" framing (R10 — no
   deferral: the durable session-attributed signal the externals asked for is built here in v1).
2. **Ratification is a deterministic verified-operator signal** (R1), resolved against
   `MessageStore` + `TopicOperatorStore` or a PIN-gated route — NEVER a transcript-quoted
   message. Governing standard: Know Your Principal. The `CompletionEvaluator` fence's "quoted
   operator text = gaming" directive is preserved unchanged.
3. **"Built/delivered" is corroborated deterministically** (R3): merged-PR-touches-path OR
   in-artifact convergence marker OR declared-deliverable — a checked ACCRETED box alone never
   clears an artifact.
4. **Artifact-class boundary + declared-deliverable exemption are path-based and frontloaded**
   (R8) — a session whose goal IS to produce document X is not held for producing X.
5. **Config is snapshotted at session start** (R4) — a running session cannot disable its own
   guard by editing `.instar/config.json`; a mid-run `completionDiscipline.*` edit is ignored +
   flagged.
6. **The met:false / unbuildable-accretion loop is bounded** (R6) by a hard-blocker escape +
   a scope-accretion breaker (surface-to-operator-and-stop), never a silent churn to `end_at`.
   §3 corrects the original spec's wrong circuit-breaker citation.
7. **Default ON with a chokepoint off-switch** — the change is monotone-safe and directly
   operator-requested; dark-shipping a discipline fix the operator asked for would itself be
   "A Dark Feature Guards Nothing." (Decision-Completeness reviewer contested and cleared this:
   user-visible behavior change, but bounded by the untouched duration ceiling; no new
   unbounded cost, no external side-effect, no identity mutation.)
8. **Layers A/B are advisory; Layer 0 + R1 are the deterministic core** (R9) — the safety
   argument does not depend on the agent writing a checkbox or on the phrase list's recall.
9. **New signals audited as booleans + pattern-name + path basenames only** (R5) — never raw
   transcript or operator-message bodies; secret-scrubbed.

## Open questions

None.
</content>
</invoke>
