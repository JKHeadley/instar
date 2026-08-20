# Side-Effects Review — rerouted-session completion sentinel must not appear literally in the injected prompt

**Version / slug:** `reroute-sentinel-echo-collision`
**Date:** `2026-08-20`
**Author:** `echo`
**Second-pass reviewer:** `required (session lifecycle + sentinel) — see below`

## Summary of the change

`SessionManager.spawnReroutedInteractive` appended the ASSEMBLED completion sentinel
(`INSTAR_JOB_COMPLETE_<id8>`) to the prompt it injects into the interactive REPL. That
prompt is typed into the session, so every character of it lands on the tmux pane that
`detectSessionCompletion` scans. The sentinel therefore satisfied the completion check
from the moment the prompt rendered — before any work happened — and the monitor loop
reaped the session as `completed` on its first look after the 15s grace.

The change hands the model the sentinel's three pieces (`INSTAR_JOB_COMPLETE`, `_`,
`<id8>`) and instructs it to join them, so the assembled literal reaches the pane only
when the model actually prints it. Files: `src/core/SessionManager.ts` (prompt
construction only) and `tests/unit/headless-spawn-reroute.test.ts`.

Field evidence gathered before the fix, on a live 3-machine fleet, on the lease holder:
31/31 rerouted-interactive sessions killed at 15.3–41.3s, ALL recorded `completed`;
25 scheduled jobs reporting `lastResult: success`, `consecutiveFailures: 0`; 1,074
`sentinel-complete` reaps in the ~43h the machine's reap-log covers.

## Decision-point inventory

- `SessionManager.detectSessionCompletion` (`src/core/SessionManager.ts`) — **pass-through**
  — unchanged. It still substring-matches `session.completionPatterns` against the last
  30 captured pane lines and still holds reap authority. This change alters only what
  reaches its input, not the check itself.
- `SessionManager.spawnReroutedInteractive` prompt construction — **modify** — the
  assembled sentinel is removed from the injected text; the pieces are supplied instead.
- Monitor-loop reap path (`completionMode === 'pattern'` branch) — **pass-through** —
  untouched, including the `protectedSessions` exemption and the hard lifetime cap.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface is added. The relevant risk is the inverse of over-block: a
session that HAS finished failing to be recognised, because the model assembled the
marker incorrectly (e.g. printed `INSTAR_JOB_COMPLETE _1a2b3c4d` with a space, or wrote
only the prefix). That session is not reaped on sentinel, runs to the existing
`subscriptionReroutedLifetimeMinutes` cap (default 45), and is recorded as a **timeout**
via `finalStatus: 'killed'`.

That is the deliberate direction. A timeout is loud, appears in the job's
`consecutiveFailures`, and reruns on the next trigger. The pre-fix behaviour — a silent
false `success` — was undetectable by any status surface, which is precisely how it
survived ~43 hours across 25 jobs.

Verified empirically rather than assumed: a probe job on the affected machine, given the
same three-piece instruction, assembled `ASSEMBLY_PROBE_OK_7f3a2b91` correctly.

## 2. Under-block

**What failure modes does this still miss?**

Three, all pre-existing and none newly introduced:

1. **Model quotes the assembled marker mid-run.** If the model writes the joined literal
   while narrating ("I'll print INSTAR_JOB_COMPLETE_1a2b3c4d when done"), the matcher
   still fires early. Mitigated but NOT eliminated by the added instruction "Write the
   assembled marker ONLY on that final line — never earlier in your output, and never
   quote it back while describing what you are doing." This is model compliance, not a
   structural guarantee.
2. **A task whose own content contains the marker.** A job asked to grep for
   `INSTAR_JOB_COMPLETE_*` would put a matching literal on the pane. Pre-existing;
   narrowed, since the per-session `<id8>` suffix makes an accidental collision unlikely.
3. **The literal matcher still cannot distinguish assertive output from quoted or echoed
   context.** That is the class-level defect and is explicitly NOT closed here — see §4
   and the Class-Closure Declaration.

## 3. Level-of-abstraction fit

The change sits at the **prompt-construction** layer, which is the correct place for it:
the defect is that a producer wrote into a channel a consumer scans. Fixing it at the
producer removes the collision without touching reap authority, session lifecycle, or the
monitor loop — the smallest surface that resolves the observed failure.

It is explicitly NOT the right layer for the deeper problem. A literal-token detector
holding kill authority over screen text is an authority-placement defect, and the correct
fix there is either a terminal-line-equality contract, demotion of the matcher to a signal
feeding a completion authority, or moving completion off the screen channel entirely (a
file the model touches). Doing that here would be a lifecycle-behaviour change riding on a
bugfix; it is tracked as ACT-1798 instead.

Nothing is re-implemented: the existing `completionPatterns` mechanism, matcher, grace
period and lifetime cap are all reused unchanged.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No** — this change has no block/allow surface. It removes a false input from an
  existing detector; it neither adds a detector nor grants authority.

Narrative, stated honestly: the surrounding design **is** a signal-vs-authority violation
and this change does not repair it. `detectSessionCompletion` is a brittle literal matcher
that owns reap authority directly, with no context-rich authority between detection and
the kill. That is exactly the shape `docs/signal-vs-authority.md` forbids, and it is why a
single string on a screen could terminate 31 sessions and mark them successful.

This change is deliberately scoped to the collision, not the authority, because the
authority repair changes session-lifecycle behaviour and deserves its own spec and review.
Declaring compliance here would be false; the honest declaration is "no new authority, the
existing violation persists, and it is tracked as ACT-1798 (high)."

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The change adds no
decision logic at all — it edits a prompt string. The pre-existing completion decision is
a single-signal check (marker present / absent), not a competing-signals judgment point;
whether it *should* become one is the question ACT-1798 carries.

---

## 5. Interactions

- **Shadowing:** none. The prompt is built before injection; nothing else reads or
  rewrites it. `withClaudeUltracodePrompt` still wraps the caller's prompt first and its
  output is unchanged.
- **Double-fire:** none. `completionPatterns` remains a single-element array holding the
  assembled sentinel, so the matcher's behaviour is identical for any given pane content.
  The per-session `<id8>` keying that prevents two concurrent rerouted sessions
  false-triggering each other is preserved (verified by the V2 test asserting
  `completionPatterns === [sentinel]`).
- **Races:** none introduced. The 15s grace, the `alive === false` branch, the CAS re-read
  before mutation, and the `skipped:active-process` guard are all untouched.
- **Feedback loops:** this closes one. The pre-fix arrangement was a genuine loop — the
  system's own instruction was fed back into its completion sensor.

---

## 6. External surfaces

- **Other agents on the same machine:** none. Per-session state only.
- **Install base:** yes, and this is the point — every agent running
  `intelligence.subscriptionPath.mode` in `force` or `auto` (where the reroute gate
  allows) is affected today. They will see rerouted jobs actually run to completion
  instead of being reaped at ~16s. Job durations, token spend and wall-clock for these
  jobs all rise from near-zero to their true cost. That is a restoration of intended
  behaviour, but it is a real change in observed load and should be expected.
- **External systems:** none. No API, route, schema, or wire format changes.
- **Persistent state:** none. No migration. Existing sessions keep their stored
  `completionPatterns`; only newly-spawned sessions get the new prompt.
- **Timing / runtime conditions:** the fix depends on model compliance with an assembly
  instruction. Checked live against the real model rather than assumed (see §1).
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing actions
  added or touched.

---

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard renderer, approval page, or
grant/revoke/secret-drop form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: machine-local BY DESIGN.**

Reason: a session's completion sentinel is scoped to one tmux pane on one host. The
prompt is constructed at spawn time by the machine that owns the session; the matcher
reads that machine's own pane. There is no cross-machine state to replicate and no
merged read that would be meaningful — another machine cannot observe this pane, and
should not.

- **User-facing notices:** none emitted. No one-voice gating needed.
- **Durable state:** none introduced, so nothing strands on topic transfer. Session
  records already move with the existing transfer machinery, unchanged by this.
- **Generated URLs:** none.

Worth recording, because it shaped the investigation: the *impact* is decidedly not
machine-local. Only the machine holding the serving lease runs the scheduler, so the
fleet-wide symptom concentrated entirely on one machine while its peers looked healthy —
and the affected machine's own status surfaces reported success throughout.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit, ship as the next patch. The change is a single
  prompt string plus tests.
- **Data migration:** none. No persistent state, no schema, no ledger column.
- **Agent state repair:** none. Sessions spawned under either version carry their own
  `completionPatterns` and are handled identically by the unchanged matcher.
- **User visibility during rollback:** reverting restores the defect — rerouted jobs
  would again be reaped at ~16s and marked successful. So rollback is cheap mechanically
  and expensive behaviourally; the correct response to a problem with this change is
  almost certainly to fix forward, not revert.

---

## Conclusion

The review produced no design change, and one deliberate scope decision worth naming: the
fix removes the collision at the producer rather than repairing the authority placement at
the consumer, because the latter changes session-lifecycle behaviour and needs its own
spec. §4 therefore records a *persisting* signal-vs-authority violation rather than
claiming compliance, and ACT-1798 tracks it at high priority.

The review also changed how the fix is evidenced. The original tests passed both before
and after, which is worthless as a regression guard, so the new test was checked against
the unfixed source and confirmed to fail. The model's ability to assemble the marker — the
one assumption unit tests cannot validate — was checked live on the affected machine
rather than assumed.

Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** `echo (independent audit pass — see note)`
**Independent read of the artifact: concur, with one concern recorded**

- **Concur** that the change is minimal, has no block/allow surface, introduces no
  persistent state, and fails in the safe direction (timeout, not false success).
- **Concern raised:** §2 under-block item 1 — the "quote it back mid-run" failure mode is
  mitigated only by model compliance with a prompt instruction, which is precisely the
  kind of guarantee this codebase treats as a wish rather than a structure. **Resolution:**
  accepted as a residual risk for this change, because it is strictly narrower than the
  pre-fix behaviour (which fired with certainty on every session rather than occasionally
  on a narrating one), and because the structural repair is the same one ACT-1798 carries.
  This does not block the fix; it raises the priority of ACT-1798, which is filed `high`.
- **Note on reviewer independence:** no second agent was available to audit this at the
  time of the fix, so this pass was conducted by the same agent against the artifact and
  the diff rather than by an independent reviewer. That is a weaker guarantee than the
  skill intends and is recorded here rather than presented as a genuine second pass.

---

## Evidence pointers

- Live reproduction: probe session on the affected machine, polling
  `GET /sessions/:name/output?lines=30` — sentinel present in the scanned window
  continuously from ~10s after spawn, followed by the reap.
- Reap-log corroboration: two entries for the probe —
  `skipped:active-process` at 16s, then `reaped | sentinel-complete | terminal` at 41s.
- Population evidence: 31/31 rerouted sessions 15.3–41.3s, all `completed`; 25 jobs at
  `lastResult: success`, `consecutiveFailures: 0`; 1,074 `sentinel-complete` reaps over
  the ~43h of reap-log held on that machine.
- Contrast/control: the headless lane (`completionMode: 'exit'`) on another machine ran a
  comparable job for 3m38s and completed correctly.
- Assembly check: probe returned `ASSEMBLY_PROBE_OK_7f3a2b91` correctly joined.
- Test-tier results: unit 27 passed, integration passed, e2e 4 passed, `tsc --noEmit` clean.
- Negative control: both new assertions fail on the unfixed source.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `brittle-keyword-authority`. A literal-token detector
  (`detectSessionCompletion`) assigns a consequential classification (session complete →
  reap) over raw pane text without distinguishing the model's assertive output from
  non-assertive context — here, the system's own echoed instruction.
- **`closure`** — `gap`. This change closes the INSTANCE (the producer no longer writes
  the matching literal into the consumer's channel) but not the CLASS (the brittle matcher
  still holds kill authority and still cannot tell assertion from echo or quotation).
  Claiming `guard` on the strength of an instance-level regression test would overstate
  what was built.
- **`gap`** — `ACT-1798` (priority `high`, dueBy 2026-09-10): promote the literal sentinel
  matcher from authority to signal, or pin completion to a terminal-line-equality contract,
  or move completion off the screen channel entirely.
- **`guardEvidence`** — not claimed (see `closure: gap`). For the record, the
  instance-level ratchet added here is
  `tests/unit/headless-spawn-reroute.test.ts` →
  `"REGRESSION: the injected prompt, seen as pane output, is NOT completion"`, which feeds
  the real injected prompt to the real matcher and was verified to fail on the unfixed
  source. It guards this lane's collision, not the class.
