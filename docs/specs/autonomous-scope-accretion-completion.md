---
title: "Autonomous Scope-Accretion Completion Discipline — work a session generates joins its completion bar"
slug: "autonomous-scope-accretion-completion"
author: "echo"
status: "draft"
parent-principle: "Deferral = Deletion — initiative converted into a 'documented stretch' is abandonment with a paper trail"
sibling-principles: "Structure > Willpower; Close the Loop (Untracked = Abandoned); Signal vs. Authority"
lessons-engaged: "AUTONOMOUS-COMPLETION-DISCIPLINE.md (the judge/signal architecture this extends); autonomous-completion-real-checks.md (the veto-shape precedent); scope-accretion-completion-discipline (operator feedback 2026-07-02, topic 29836); B18_AUTONOMY_STOP (MessagingToneGate — the nearest existing statement of the principle)"
parent-spec: "docs/specs/AUTONOMOUS-COMPLETION-DISCIPLINE.md"
project: "self-healing-mesh (topic 29836)"
depends-on: "CompletionEvaluator (src/core/CompletionEvaluator.ts); autonomous stop hook (.claude/skills/autonomous/hooks/autonomous-stop-hook.sh — NOTE: source of truth is .claude/skills/autonomous/, not skills/); parseStopSignals (src/server/routes.ts:~4483); PostUpdateMigrator upgrade() marker mechanism (REALCHECK_VERIFY precedent)"
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
tracks artifacts the session itself drafts**, so a good session that discovers new
in-scope work can convert that initiative into deferral — the exact Deferral =
Deletion anti-pattern — and the judge cannot see it. (`InitiativeTracker` holds a
related drafted/awaiting-ratification ledger, but it is fully decoupled from the
completion path and its rows carry no session attribution.)

## 2. Design — three thin layers on the existing discipline

The feature adds NO new judge, NO new LLM call, and NO new store. It strengthens
the exact seams the completion-discipline architecture built for this
(deterministic detectors → whitelisted signals → the one judge), in its established
fail-safe direction: every layer can only push toward `met:false` (keep working),
never toward a false "done." Duration expiry `(b)` and the emergency stop are
untouched — a session can never be trapped past `end_at`.

**Layer A — the recording duty (SKILL.md contract; rides the EXISTING primary
signal).** The autonomous skill's work-loop and completion guidance gain the
scope-accretion rule: the moment the session creates an in-scope artifact (a spec,
runbook, script, or document) not covered by an existing task, it MUST append a new
unchecked task to the state file's `## Tasks`:
`- [ ] ACCRETED(<ISO date>): <artifact path> — build/converge/deliver, or obtain
operator ratification to defer (quote the ratifying message)`.
The completion-condition template gains the matching self-applied clause (the
wording this session already carries). Because the hook's checkbox scan is the
PRIMARY deterministic "buildable work remains" signal, an accreted task blocks exit
exactly like an original task — zero new parser machinery, pure Structure >
Willpower.

**Layer B — the evasion detector (deterministic hook signal).** Layer A relies on
the agent writing the task down; the failure mode is NOT writing it down. The stop
hook's deterministic-signals block gains a high-precision scan of the assistant
transcript tail for accretion-evasion vocabulary — "documented stretch", "filed for
a future session", "out of (the) completion condition", "a future session runs",
"drafts for later", "deferred as a follow-up spec" — setting a new boolean
`scopeAccretionSuspected` in the signals payload (whitelisted in
`parseStopSignals`, becoming the seventh `StopSignals` field). High-precision by
construction: generic hedges ("I'll look into it later") deliberately do NOT match
— false negatives are acceptable (Layer C still reads the raw transcript), false
positives waste a judge round at most. A SIGNAL, never authority (Signal vs.
Authority): it informs the judge; it blocks nothing by itself.

**Layer C — the judge clause (the authority).** `CompletionEvaluator.evaluate`'s
prompt builder gains the scope-accretion rule: *work the session itself generated
that is aligned with the goal joins the completion bar automatically; if the
surfaced transcript shows in-scope artifacts drafted during the session left
unbuilt, the condition is NOT met — unless the transcript quotes the operator
explicitly ratifying the deferral in the session's topic.* The
`scopeAccretionSuspected` signal is surfaced to the judge alongside the existing
six. The evaluator's conservative parse (`ambiguous → met:false → keep working`)
and the P13 stop-rationale judge's fail-open semantics are both untouched.

**Explicitly deferred (with reason):** wiring `InitiativeTracker` rows into the
judge. Initiative rows carry no session attribution, so a deterministic
"this session drafted it" join is not currently possible; Layers A–C cover the
failure mode at the session boundary. Tracked follow-up, not a silent omission.

## 3. Migration parity + awareness

- **Marker bump (the REALCHECK_VERIFY precedent, verbatim mechanism):** the three
  `PostUpdateMigrator.upgrade()` calls for the stop hook, `SKILL.md`, and
  `setup-autonomous.sh` bump their marker to `SCOPE_ACCRETION`; the sentinel comment
  is embedded in all three bundled files (cumulative-history note updated). Existing
  agents receive the new skill content on their next update; customized files
  (missing the stock fingerprint) are skipped, per the mechanism's contract.
- **Config off-switch:** `autonomousSessions.completionDiscipline.scopeAccretion.enabled`
  (default TRUE — the change only refuses premature completion, the safe direction;
  read at the chokepoint like the other CD dials, no restart). Rollback = set false:
  the prompt clause and the signal are omitted; Layer A's guidance text remains (a
  recorded task is always legitimate).
- **CLAUDE.md awareness:** the agent template's autonomous-mode section gains the
  scope-accretion rule + proactive trigger ("drafted something new mid-session →
  append the ACCRETED task immediately"), with the matching content-sniffed
  `migrateClaudeMd` append.

## 4. Tests (tiers declared)

Unit: `parseStopSignals-whitelists-scopeAccretionSuspected` (and rejects unknown
fields); `evaluate-prompt-carries-accretion-clause-when-enabled` /
`-omits-when-disabled` (prompt-content assertions — the judge verdict itself is an
LLM output and is not unit-asserted); `phrase-scan-positives` (each canonical
evasion phrase) / `phrase-scan-negatives` ("I'll look into it later", quoting this
spec's own vocabulary in a doc diff, ordinary "stretch goal" in a plan document);
signal-fails-toward-continue (scan error ⇒ signal false ⇒ behavior identical to
today). Hook: extend the existing stop-hook test harness — ACCRETED checkbox blocks
exit via the existing unchecked-count path; evasion phrase in tail sets the signal
in the built payload. Integration: `POST /autonomous/evaluate-completion` round-trips
the new signal; config off-switch honored live. E2E (feature-alive): a state file
with an unchecked ACCRETED task + a met-looking transcript does not exit (rides the
existing CD e2e pattern).

## 5. Safety analysis (why this cannot wedge a run)

The judge fires only when the checkbox scan says zero unchecked tasks (the existing
gate), so Layer B/C engage exactly at the moment the session claims to be done. A
false-positive signal costs one extra work iteration, bounded by: the operator's
explicit ratification path (quote the message → judge sees it → met), the CD
circuit breaker, idle backoff, and the hard duration ceiling `(b)`. There is no code
path where this feature causes an exit — it is monotone toward "keep working," the
direction the completion-discipline architecture designates as safe.

## Frontloaded Decisions

1. **Ride the checkbox scan (Layer A) as the primary mechanism** — an ACCRETED task
   is an ordinary task; no parallel artifact ledger.
2. **The detector is high-precision/low-recall by design** — false negatives fall
   through to the judge's raw-transcript read; false positives cost one iteration.
3. **Ratification = a quoted operator message in the topic**, surfaced in the
   transcript — the judge can verify it without tools (transcript-only by design).
4. **Default ON with a chokepoint off-switch** — the change is monotone-safe;
   dark-shipping a discipline fix would itself be "A Dark Feature Guards Nothing."
5. **InitiativeTracker wiring deferred** (no session attribution today) — named
   follow-up.
6. **SKILL.md redeploy via SCOPE_ACCRETION marker bump** — the proven
   REALCHECK_VERIFY mechanism, all three files.

## Open questions

None.
