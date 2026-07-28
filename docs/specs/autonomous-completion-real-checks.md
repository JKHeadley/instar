---
title: "Autonomous completion — real-checks verification"
slug: "autonomous-completion-real-checks"
author: "echo"
parent-principle: "Distrust Temporary Success — A Recurrence Is a Root Cause"
review-convergence: "2026-06-10T18:03:26.490Z"
review-iterations: 3
review-completed-at: "2026-06-10T18:03:26.490Z"
review-report: "docs/specs/reports/autonomous-completion-real-checks-convergence.md"
cross-model-review: "skipped-abbreviated"
cross-model-review-reason: "focused single-subsystem change; full internal 5-reviewer panel incl mandatory lessons-aware, 3 rounds; external models skipped per abbreviated path"
approved: true
approved-by: "Justin — explicit 'approved' (topic 12143, 2026-06-10) to build this feature; converged + reversible (opt-in); recorded by echo per AGENT-AUTONOMY-PRINCIPLES (no operator stop-and-wait). Open-Q calls: Q1 realCheck.enabled=true; Q2 command in state file + audit; Q3 instar-evaluator path only."
---

# Autonomous completion — real-checks verification

*topic 12143 · 2026-06-10 · tracked as ACT-152 <!-- tracked: ACT-152 --> (the verification
enhancement Justin flagged on 2026-05-24 as the kind he wanted captured so it would not "fall
between the cracks forever"). Builds on the independent CompletionEvaluator shipped in v1.3.465.*

> **Convergence note.** This spec was revised after a 5-reviewer pass (security, adversarial,
> scalability, integration, lessons-aware). The revision added: a P19 real-check breaker
> (§4), a structurally-captured build directory (§3), a portable timeout + source-bounded
> output capture (§5), an audit trail + destructive-pattern pre-block + honest tamper framing
> (§6), output-as-DATA isolation (§5.3), and concrete migration mechanics (§7). The original
> single-gate sketch is preserved as §2.

## 1. Problem statement

The autonomous stop-hook decides "is the goal done?" by asking an INDEPENDENT model
(`CompletionEvaluator.evaluate(condition, transcriptTail)`) whether a verifiable completion
**condition** is met — judging **only the transcript** the agent has surfaced. That was the
robustness win over the old self-declared `<promise>` token: a second mind grades the homework
instead of the agent grading its own.

But the judge is still **transcript-only**, by deliberate design (original spec decision #2, which
named this verification a "clean later enhancement"). It judges what the agent *says* happened, not what
*actually* happened. A condition like "all tests pass" is judged MET when the transcript shows
the agent claiming the tests passed — even if the agent never ran them, ran them in a stale
worktree, or misread red output as green. The judge mirrors the framework `/goal` contract
(transcript-only) precisely because it does not run tools.

The gap Justin named: **"make the 'is it really done?' check actually run the tests instead of
just trusting the agent's word."** When a condition is objectively checkable by a command (a
test suite, a build, a grep, a CI status, a file-exists test), the loop should be able to RUN
that check before it accepts the exit — not infer success from prose. This is the same insight
`/verify-claim` encodes (a claim of "done" is not goal achievement; run the real check), applied
to the autonomous loop's continue/stop authority.

### What the real check is, and is NOT (honest scope)

The real check **strengthens the loop against honest failure modes**: a misread test result, a
stale worktree, a premature "done" the agent believes. It is layered on top of an independent
LLM judge that *already* said MET, so it can only *raise* the bar for stopping.

It is **NOT an adversarial-containment mechanism.** The command is agent-influenceable (see §6):
an autonomous instar agent can already edit its own state file and already holds far larger
powers (it can edit source, run builds, push code). A genuinely adversarial agent that wants to
escape the gate can weaken the command — and the floor simply returns to today's transcript-only
behavior (the independent judge still had to say MET). The spec therefore makes the *defeat
detectable* (audit, §6.3) rather than pretending it is *prevented*, and hardens the **execution**
of the command (timeout, env, destructive-pattern block) because the command runs **unattended
in a hook**. The earlier draft's claim that the field carries "the same trust as the condition"
was wrong and is corrected: the condition is DATA passed to the judge and never executed;
`verification_command` is the loop's **first agent-writable, shell-EXECUTED field**, so it gets
execution hardening the condition never needed.

## 2. Core design — the verification gate

Add an **opt-in verification command** to an autonomous job. When the transcript-judge returns
`met:true`, the stop-hook RUNS the declared command and only allows the exit if the command ALSO
succeeds (exit 0). A failing command does not end the run — it **blocks the exit and feeds the
command's sanitized output back as next-turn guidance** (§5.3). The judge stays transcript-only
and unchanged; the real check is a second, independent gate layered on the (rare) met path.

### 2.1 Why a declared deterministic command (not "inject /verify-claim into the session")

- **(A) A declared command the hook runs directly** — on a `met:true` verdict the hook executes
  it (bounded, hardened) and gates the exit on its exit code.
- **(B) Inject `/verify-claim <condition>` into the running session** — the agent runs the
  4-tier protocol itself and surfaces a verdict the hook parses back out of the transcript.

This spec adopts **(A)**. (A) is **independent** — the hook runs the check, not the agent grading
its own homework, which is the entire point. (B) routes verification back through the agent that
just claimed done (the homework-grading problem the CompletionEvaluator exists to fix) and
depends on fragile transcript round-trip parsing. (A) is deterministic, cheap (no extra LLM
call), and reuses the exact "run the real check" discipline `/verify-claim` documents — executed
by the loop, not narrated by the agent. (B)'s only edge — conditions with no single command — is
preserved by leaving the field **optional**: absent → byte-identical to today (transcript-only).

### 2.2 Where it slots in (precise placement)

The gate goes **inside the existing `if [[ "$EVAL_MET" == "true" ]]` block** of
`.claude/skills/autonomous/hooks/autonomous-stop-hook.sh` (CD branch ~`:917-925`, legacy branch
~`:927-932`), AFTER the `CD_BLOCK_TERMINAL` guard and the P13 check, and BEFORE `rm -f
"$STATE_FILE"; exit 0`. Placing it there means it **inherits for free** the contradictory-marker
guard: a turn that emits BOTH a `<hard-blocker>` and a met-condition sets `CD_BLOCK_TERMINAL=true`
(`:787`) and short-circuits the whole completion block — so the real check never runs on a
hard-blocker/P13-blocked turn. The gate is scoped to the **completion-condition and legacy-promise
met paths only**; it explicitly does NOT wrap the `(a)` hard-blocker exit (running a real check
when the agent says "I cannot proceed" is incoherent) and does NOT run under `goal_mode:native`
(instar's evaluator stands down there — §8 Open Q3).

Pseudocode (both branches):

```
if EVAL_MET == "true" and not CD_BLOCK_TERMINAL and P13 allows:
    if realCheck.enabled and VERIFICATION_COMMAND is set:
        if realcheck_breaker_open():            # §4 P19 brake
            EVAL_REASON = "real check has failed repeatedly — paused re-running it; <guidance>"
            # fall through to keep-working (no judge re-fire, no command run)
        else:
            run_verification()                  # §5 bounded, hardened, audited
            if exit 0:
                allow exit (judge MET + real check PASSED)
            else:
                realcheck_record_failure(output_hash)   # §4
                EVAL_REASON = realcheck_guidance(cmd, clamped_output)   # §5.3
                # keep working
    else:
        allow exit (transcript-only behavior, unchanged)
```

## 3. State, setup, and the build directory (CWD)

`.claude/skills/autonomous/scripts/setup-autonomous.sh` gains two optional flags written to the
per-topic state file frontmatter:

- `--verification-command "<cmd>"` → `verification_command: "<cmd>"`.
- `--verification-cwd "<dir>"` → `verification_cwd: "<dir>"` (the directory the command runs in).

**Build-directory correctness (lessons-aware F4 — must-fix).** The dominant use case for "run
the real check" is an autonomous *build* run, which by the worktree-default convention executes
**inside a worktree that is NOT the agent home**. Running a relative `npm test` from the agent
home would test the wrong tree — re-introducing the exact stale-tree failure this feature exists
to close. So the command's CWD is resolved **structurally**, not by agent willpower:

1. `verification_cwd` if set (operator/agent declared the build dir explicitly), else
2. `work_dir` — the session's working directory captured at setup time (setup-autonomous.sh
   records `work_dir: "$(pwd)"` into the state file), else
3. the agent home (today's behavior) as the last-resort fallback.

The hook runs the command in a SUBSHELL so it never disturbs the hook's own anchored CWD:
`( cd "$RESOLVED_CWD" && <bounded exec> )`. The resolved CWD is recorded in the audit row (§6.3)
so a wrong-tree mistake is visible. Docs note: prefer a command that *recomputes* state
(`npm test`, `npm run build`) over one that *reads a flag file* (`test -f built.ok`) — a flag the
agent wrote earlier is as gameable as the transcript (§6.2 TOCTOU residual).

Absent `verification_command` → field omitted → unchanged behavior. The hook reads the fields via
a **quote-preserving** read (NOT the existing `fm_get`, which does `tr -d '"'` and would mangle a
command containing literal quotes); a small `fm_get_raw` helper (or a `python3` YAML/JSON-style
read mirroring the existing `CD_CFG` reader) returns the value verbatim.

## 4. P19 brake — the real-check failure breaker (must-fix)

A failing, flaky, mis-scoped, or maliciously-rigged `verification_command` would otherwise
re-run on **every** `met:true` verdict for the whole duration — and because the judge fires first
to *produce* the met verdict, it also **re-spends the LLM judge every iteration**. That is a new
unbounded repeating behavior, which P19 ("No Unbounded Loops") forbids shipping without
**backoff + breaker + cap built into the looping component** (not the duration limit alone — that
is the forbidden single-cap).

Design — reuse the existing `CD_BACKOFF_STATE` sidecar machinery (`cd_breaker_open` /
`cd_record_judge_failure` pattern, hook `:536-590`) with a sibling counter:

- **Counter.** `realCheckFailures` (consecutive) + `realCheckFailWindowStart` +
  `realCheckLastFailHash` (hash of the clamped failure output) in `CD_BACKOFF_STATE`.
- **Backoff + breaker.** After `realCheckFailBreakerThreshold` (config, default 3) consecutive
  failures within `realCheckFailWindowMs` (default 600000), the real-check breaker is OPEN for
  `realCheckFailCooldownMs` (default 600000). While OPEN, the met path does a **cheap
  checkbox-only continue** — it does NOT re-fire the judge and does NOT run the command (mirrors
  the existing judge-breaker-open branch `:876-883`). This bounds LLM + command spend to roughly
  one judge+command attempt cycle per cooldown window instead of one per iteration (precisely: the
  single reset iteration after each window fires both the judge and the command before the failure
  re-trips the breaker — still bounded, the property P19 requires). (Design choice: breaker-OPEN
  keeps working — it never silently weakens the gate to a transcript-only exit. The cost is that a
  genuinely-finished run whose command is mis-authored can keep working until duration; this is
  bounded by the duration limit AND surfaced by the Attention item below, so the operator holds
  the lever to stop/fix it. The alternative — degrading to a transcript-only exit on breaker-open
  — was deliberately not taken: it would turn a persistently-failing check into a free pass.)
- **Cap + Close-the-Loop.** On crossing the threshold, raise **ONE** deduped Attention item
  (reuse `cd_raise_attention_item`, source-tagged `autonomous-realcheck-stuck`, one per run via a
  started-at-keyed id) — "the declared real check has failed N times; likely an authoring
  problem" — so a flaky/wrong command surfaces to the operator instead of silently eating the
  whole duration. Bounded-Notification-Surface compliant (one item, not per-failure).
- **Reset.** A real-check PASS resets the counter (`cd_reset`-style) and closes the breaker.
- **Fail-direction + write integrity.** `realcheck_breaker_open()` MUST fail **CLOSED** ("breaker
  closed → run the check") on ANY sidecar read/parse error — the safe direction for the FEATURE is
  to keep verifying, never to silently suppress the check (which would fail-OPEN the whole
  feature on a transient `jq`/disk hiccup and let an unverified transcript-met exit through). This
  mirrors `cd_breaker_open`'s `echo 0`-on-failure default (`:542-556`). Counter writes use the same
  atomic `.tmp.$$` + `mv` pattern the existing breaker uses (`:572-577`) so concurrent met-path
  fires can't tear the sidecar.

Test (must-have, §9): drive the gate against a permanently-failing command and assert the
command-invocation count AND judge-call count stay bounded across a simulated multi-iteration run
(the P19 sustained-failure test the original draft lacked).

## 5. Execution safety (the command runs unattended in the Stop hook)

### 5.1 Portable, guaranteed timeout (must-fix)

The hook today bounds sub-processes with `curl -m`; it never invokes `timeout(1)`, which is
**absent on stock macOS** (ships only as `gtimeout` via Homebrew). A bare `timeout "$s" …` would,
under `set -uo pipefail` (no `-e`), fail with `command not found` → the command never runs →
treated as FAIL → keep working. That is the safe direction, but it silently **disables the entire
feature fleet-wide on the primary platform**. Required mechanism, in order:

1. `command -v timeout` → use it WITH `--kill-after` (e.g. `timeout -k 5 "$secs" …`) so the whole
   process group is reaped, not just the leader; else
2. `command -v gtimeout` → use it with `--kill-after` (same); else
3. a portable `perl` alarm wrapper (perl is already a hook dependency — used by `hb_field`) that
   **reaps the child process GROUP**, not just the leader — important because the dominant case
   (`npm test` → node → jest workers) spawns grandchildren that would otherwise orphan and keep
   running (holding the build dir / ports) after the hook moves on:
   ```
   perl -e 'my($t,@c)=@ARGV; my $p=fork; if($p==0){setpgrp(0,0); exec @c or exit 127}
            $SIG{ALRM}=sub{kill("-KILL",$p); exit 124}; alarm($t); waitpid($p,0); exit($?>>8)' \
        "$secs" bash -c "$cmd"
   ```
   (the child is made a process-group leader via `setpgrp(0,0)`, so on `SIGALRM` `kill("-KILL",$p)`
   signals the whole group, reaping `node`/`jest` descendants; exit 124 = timeout, 127 = spawn
   fail); else
4. if even perl is unavailable: treat the real check as **unavailable → keep working** with a loud
   stderr breadcrumb + an audit row (NEVER run the command unbounded).

`realCheckTimeoutMs` (config, default 120000ms / 2min, floored 5s). A timeout is a FAIL → keep
working, and counts toward the §4 breaker. Unit tests assert the bound fires **with no GNU
`timeout` on PATH** (forces the perl path via a stubbed PATH) AND that a child that spawns a
grandchild is fully reaped on timeout (no orphaned process survives). On a platform where neither
`timeout`/`gtimeout` nor the perl group-kill can reap the group, the orphaned-child possibility is
named as a residual in §6.2 rather than hidden.

### 5.2 Source-bounded output capture + exit-code capture (must-fix)

- **Bound at the source, not only at the clamp.** Capture combined stdout+stderr through a byte
  cap AT READ TIME — `… 2>&1 | head -c "$REALCHECK_CAPTURE_BYTES"` (default 65536) — so a runaway
  command (a 1GB test log) can never be buffered whole into the hook before the 2000-char clamp.
- **Exit code via `${PIPESTATUS[0]}`** (the command's status, not `head`'s). Rule, stated
  mechanically: **exit 0 → PASS (allow exit); ANY other value → FAIL (block, keep working)**,
  including the timeout sentinel (124 from `timeout`, the perl-alarm equivalent) and 127
  (spawn-failure / missing binary). There is no "unparseable exit" — `$?` is always an integer;
  the only ambiguity (the wrapper itself failing) resolves to non-zero → FAIL → safe direction.
  Unit tests cover exit 0, exit 1, exit 124 (timeout), exit 127 (missing binary).
- **Executor.** `bash -c "$VERIFICATION_COMMAND"` — single expansion, never `eval`, never
  concatenated into a larger template with other interpolated state. The command string is passed
  as a single argument.
- **No PREMATURE exit on any error path.** Every failure mode (non-zero, timeout, spawn-fail,
  missing-timeout-binary, perl-missing) routes to keep-working. There is no code path where a
  verification error CAUSES an exit. This is the cardinal invariant of the hook.

### 5.3 Output handling — sanitize order, leak scrub, and DATA isolation (must-fix)

The failure output becomes next-turn guidance, so it is processed in this PINNED order (reusing
the hard-blocker discipline verbatim):

1. **Sanitize** — strip control chars + collapse whitespace (the `hb_sanitize` transform,
   `:736`), AND scrub invalid UTF-8 (the source `head -c` byte-cap can split a multibyte char,
   leaving a lone continuation byte that would later break the `jq -nc --arg` body for the next
   judge → empty body → a spurious judge-unreachable/breaker trip). Add an `iconv -c -f utf-8 -t
   utf-8` pass (or `LC_ALL=C` printable-only filter) so the captured text is always valid UTF-8
   before clamp/JSON-encode. A unit test feeds a multibyte-boundary-truncated capture and asserts
   the next judge payload still builds. Done on the source-bounded capture.
2. **Leak-scrub on the SANITIZED text** (BEFORE clamp, so a credential split across the clamp
   boundary cannot evade the regex). Reuse `hb_leak_hit` patterns AND extend them for this path:
   - the agent's **own `authToken`** value (read it, redact any literal occurrence), and
   - generic `Bearer [A-Za-z0-9._-]{20,}`.
   A hit replaces the whole output with `[output withheld: possible credential in check output]`.
3. **Clamp** to `realCheckMaxChars` (default 2000).

**Environment hygiene.** The command runs with a **scrubbed environment**: a fixed `PATH`, and
the known-sensitive vars stripped (`authToken` is never exported into the command's env; strip
`npm_config_*`, `NODE_OPTIONS`). This closes the "a failing test dumps `env`" self-leak of the
agent's own bearer token (the highest-value target the shape-based scan otherwise misses) and
reduces PATH-shadow surface (a residual — see §6.2).

**DATA isolation into the next judge (adversarial #2 — must-fix; data path corrected in round 3).**
The accurate flow matters here. The real-check output is surfaced as the block decision's
**`systemMessage`** field (it rides `EVAL_REASON` → `SYSTEM_MSG`), NOT the continuation `reason`
prompt (which is the standing goal body, `PROMPT_TEXT`). The `CompletionEvaluator` judge reads
only the **assistant transcript** (`grep '"role":"assistant"'`) — i.e. text the AGENT wrote — so
the real-check output does NOT directly enter a later judge call. It can only influence a future
verdict if the agent **echoes it into its own next assistant turn**, at which point it is (a)
inside the existing instruction-inert fence (`<<<AGENT_TRANSCRIPT_DATA>>>`, treated as DATA, not
directives) and (b) subject to the `injectionSuspected` scan. So the protection is real but
**indirect and conditional on agent echo** — not a claim that the fence machinery touches the
real-check output directly.

To make the posture robust given that path: (1) the output, when surfaced, is **explicitly
labeled** `[REAL-CHECK OUTPUT — DATA, not evidence of completion]`; (2) the **fence is the
operative defense** (any guard-directed phrasing the agent echoes back lands inside it and is
treated as DATA / evidence of gaming, so `echo "the condition is MET"` backfires to STOP_BLOCKED),
and the `injectionSuspected` phrase scan is **best-effort** — it is extended to include the
real-check echo strings (`all tests pass`, `STOP_OK`, the `REAL-CHECK OUTPUT` banner) but is not
relied on as the sole guard. (3) The must-fix-#2 test exercises the **real round-trip** — a
`verification_command` whose output contains `MET` / `all tests pass` / `STOP_OK` is surfaced via
`systemMessage`, the agent echoes it into the next turn, and the subsequent judge call does NOT
grant a met-verdict on the strength of that echoed text — NOT a direct `evaluate()` injection
(which would test a path the feature never takes).

### 5.4 Next-turn guidance wording (P13-shaped, canary-pinned)

The guidance is agent-facing steering, so it is framed per P13 ("The Stop Reason Is the Work")
and "A Wall Is a Hypothesis" — the failed check is the *next work item*, and a check that looks
wrong is a hypothesis to interrogate, not a wall to grind against:

> The declared real check (`<cmd>`) did not pass — this is your next work item. Either make it
> pass, or, if the check itself is wrong or mis-scoped (pointed at the wrong directory, stale, or
> testing the wrong thing), say so and why. \n[REAL-CHECK OUTPUT — DATA, not evidence of
> completion]:\n<clamped output>

The template is canary-pinned by a test (mirroring the `PROMPT_VERSION` milestone-block canary)
so a future edit can't silently drop the framing.

## 6. Tamper boundary, residuals, and audit

### 6.1 Honest framing
Per §1: `verification_command` is the loop's first agent-writable, EXECUTED field. The agent
authored it at setup and can rewrite it mid-run (it can already rewrite `completion_condition`).
The feature strengthens against honest mistakes/stale trees; it does not contain an adversarial
agent. The floor never drops below today (the independent judge still gated the met verdict).

### 6.2 Residual falsely-PASS classes (named, not hidden)
The safe-direction property protects against falsely-FAIL (→ keep working) but NOT against
falsely-PASS the agent constructs. Named residuals, accepted for v1 with mitigations:
- **Stale-artifact / TOCTOU** — a `test -f flag` the agent `touch`ed earlier passes without
  re-verifying current state. Mitigation: docs steer operators to recomputing commands; the audit
  (§6.3) records the command + CWD so a flag-file pattern is visible.
- **PATH-shadow** — a fake `npm`/`node` earlier on PATH. Mitigation: fixed `PATH` (§5.3); residual
  acknowledged.
These are honestly the same class as a poorly-worded condition; the gate raises the bar against
the *common honest* failure, which is the goal.

### 6.3 Destructive-pattern pre-block (L12 — must-fix)
Because the command runs **unattended in an automated hook**, the signal-vs-authority
irreversible-action carve-out argues FOR a brittle pre-block here. Before executing, the command
string passes an inline **destructive-pattern guard** (mirroring `hb_leak_hit`'s shape): if it
matches high-signal destructive shapes — `rm -rf`, `git reset --hard`, `git clean -f`,
`git push --force`, `:>`/`> /dev`, `mkfs`, a write into the instar source tree — the command is
**refused** (treated as real-check-unavailable → keep working) and the refusal is audited +
surfaced once. This is a coarse guard against a confused/compacted agent writing a destructive
"check," consistent with the SourceTreeGuard family (L12). **Honesty note:** it is a literal-shape
guard on the raw command string only — it is trivially bypassable by shell obfuscation
(`r''m -rf`, `$(echo rm) -rf`, a base64-decoded payload), exactly the same honest-mistake-not-
adversarial-containment posture as §6.1/§6.2. It exists to catch a fat-fingered/compacted-agent
destructive command, NOT to contain an agent that wants to run one (such an agent already holds
larger destructive powers directly).

### 6.4 Audit trail
Every verification run appends ONE JSONL row to `logs/autonomous-realcheck.jsonl` (mirroring
`logs/autonomous-hard-blocker.jsonl`, with the same size-rotate): `{ts, topic, iteration,
command (clamped), cwd, exitCode, durationMs, outcome: pass|fail|timeout|refused-destructive|
unavailable, breakerOpen}`. Read-only; no notifications beyond the §4 single Attention item. This
makes a self-rubber-stamping pattern (`verification_command: true`) detectable post-hoc even
though v1 does not prevent it.

## 7. Migration parity (concrete — must-fix)

All paths verified against the worktree (v1.3.470). The change MUST touch:

- **`src/core/PostUpdateMigrator.ts` → `migrateAutonomousStopHookTopicKeyed` (~`:1750`).** Bump
  the **hook marker** (`:1818`), the **setup-autonomous marker** (`:1837`), AND the **SKILL.md
  marker** (`:1884`) to a NEW distinct string (e.g. `REAL_CHECK_VERIFY`) that appears ONLY in the
  new bundled files — otherwise the early-return at `:1758` (`includes('COMPLETION_DISCIPLINE')`)
  skips the re-deploy and existing agents get the config default but not the hook = a
  half-installed feature. Add the established `// Marker bumped X → Y` comment block. The SKILL.md
  bump is required because the SKILL.md Write-template (the per-topic state frontmatter block) and
  the `--verification-command` docs ride it.
- **`src/core/PostUpdateMigrator.ts` → `migrateClaudeMd` (~`:2997`).** Add an APPENDED real-check
  awareness subsection gated on a fresh content-sniff marker (e.g.
  `if (!content.includes('Real-Check Verification'))`). `migrateClaudeMd` only adds ABSENT
  sections — it never edits an existing section in place — so updating `templates.ts` alone would
  leave every existing agent without `--verification-command` awareness (an Agent Awareness
  Standard violation).
- **`src/config/ConfigDefaults.ts` (~`:613`).** Add the `realCheck` block NESTED INSIDE the
  existing `autonomousSessions.completionDiscipline` object:
  `realCheck: { enabled: true, timeoutMs: 120000, maxChars: 2000, captureBytes: 65536,
  failBreakerThreshold: 3, failWindowMs: 600000, failCooldownMs: 600000 }`. No dedicated
  `migrateConfig` block is needed — `applyDefaults` recurses into the existing object (`:822-827`)
  and backfills the missing `realCheck` per-leaf without clobbering operator config.
- **`.claude/skills/autonomous/hooks/autonomous-stop-hook.sh` `CD_CFG` block (`:229-258`).** Parse
  the `realCheck` config HERE (extend the `print()` tuple, BOTH bare-except fallback default
  strings, and the `read -r` destructuring) so the no-restart rollback property (read at the
  chokepoint each fire, like `CD_ENABLED`) actually holds.
- **`.claude/skills/autonomous/scripts/setup-autonomous.sh`.** Arg parser gains
  `--verification-command` + `--verification-cwd`; the `cat > "$STATE_PATH"` heredoc gains
  `verification_command:`, `verification_cwd:`, and `work_dir: "$(pwd)"`.
- **`.claude/skills/autonomous/SKILL.md`.** The Write-template frontmatter block documents the
  optional `verification_command:` / `verification_cwd:` fields (agents who follow the SKILL.md
  Write path instead of the CLI must emit them); a prose paragraph documents the feature.
- **`src/scaffold/templates.ts` `generateClaudeMd()`** (the discipline section) — for NEW agents,
  paired with the `migrateClaudeMd` step above for existing agents.

## 8. Open questions

1. **Default of `realCheck.enabled`.** Recommended **true** — the gate is a no-op unless a job
   declares a `verification_command`, so "enabled" costs nothing for jobs that don't use it, and a
   job that DOES declare one clearly wants it enforced. **Confirm** (alternative: ship dark).
2. **Command source location.** v1 keeps `verification_command` in the agent-writable state file
   (the agent authored it at setup anyway), with honest framing + audit + execution hardening +
   destructive-pattern block rather than a false-assurance "tamper-proof" store. A `0444` sibling
   would only block *mid-run* tampering, not setup-time authorship, and the agent can `chmod` it —
   so it adds complexity without real containment. **Confirm acceptable for v1** (the durable
   answer if adversarial containment is ever required is a non-agent execution context, out of
   scope for this honest-mistake feature).
3. **Native `/goal` mode.** When `goal_mode:native`, instar's evaluator stands down, so the
   real-check gate (which lives on instar's evaluator path) does too — native runs are unaffected
   in v1. **Confirm** (also gating native exits is a larger change, excluded from v1's scope).

## 9. Standards / parity + tests

- **Structure > Willpower:** "run the real checks" moves from a prompt exhortation into an
  executed gate; the build directory is captured structurally, not left to agent memory (§3).
- **Signal-vs-authority:** an exit-code is a STRUCTURAL VALIDATOR (the principle's allowed
  detector class — `signal-vs-authority.md` ~L46), not a meaning-judgment; the LLM judge remains
  the sole *judgment* authority on the exit, and the real check's only autonomous authority is in
  the SAFE (keep-working) direction.
- **P19 No Unbounded Loops:** §4 ships backoff + breaker + cap in the looping component.
- **P13 / A Wall Is a Hypothesis:** §5.4 guidance framing.
- **L12 destructive containment:** §6.3 pre-block.
- **Migration parity:** §7 (concrete functions + markers).
- **Testing Integrity (all three tiers):**
  - **Unit (bash-hook harness, new `INSTAR_HOOK_VERIFY_OVERRIDE` seam to avoid real commands in
    CI):** judge MET + cmd exit0 → allow; judge MET + cmd exit1 → block + reason carries clamped,
    DATA-labeled output; exit 124 (timeout) → block; exit 127 (missing binary) → block; **no GNU
    `timeout` on PATH** → perl path bounds it; **timeout reaps a grandchild** (a command that
    spawns a child leaves no orphan after the group-kill, §5.1); **sustained failure** →
    invocation + judge-call counts bounded by the §4 breaker (P19 test); **breaker fail-direction**
    → a corrupt/unreadable `CD_BACKOFF_STATE` yields breaker-CLOSED (the check still runs), never a
    silent suppression; contradictory hard-blocker+met turn → real-check NOT invoked; absent field
    → byte-identical to today (back-compat); leak-scrub redacts a planted `authToken`/`Bearer`
    before clamp; **invalid-UTF-8 capture** (multibyte-boundary truncation) → next judge payload
    still builds (§5.3 step 1); destructive command (`rm -rf …`) → refused; **echoed-output
    round-trip** → output containing `MET`/`all tests pass`/`STOP_OK` surfaced via `systemMessage`,
    echoed by the agent into the next turn, does NOT induce a met-verdict in the subsequent judge
    call (the real path, §5.3 — not a direct `evaluate()` injection).
  - **Integration:** `setup-autonomous.sh --verification-command --verification-cwd` writes the
    fields + `work_dir`; they round-trip through the hook's quote-preserving read.
  - **E2E ("feature is alive"):** a condition-driven autonomous run with a `verification_command`
    that initially FAILS keeps working past a transcript-"met" turn and exits only once the
    command passes.
- **Complete in one PR:** the full feature (gate + breaker + build-dir + exec hardening + audit +
  migration + tests + docs) ships in ONE PR. The §4 brakes are part of THIS same PR.

## 10. Risks + rollback

- **Flaky command loops the agent** — bounded by the §4 breaker (not the duration limit alone).
- **Command runs in the Stop hook** — only on a `met:true` verdict (rare), bounded timeout,
  source-bounded capture; re-runs per met-verdict (not cached), so docs steer operators to fast,
  targeted checks over full suites.
- **B24 timeout budget** — `realCheckTimeoutMs` (120s) + judge curl (≤35s) + (hard-blocker path)
  a second P13 curl must stay well under the registered Stop-hook timeout (~10000s) so a slow
  check can never push the hook to a host-kill (a host-killed Stop hook fails OPEN and strands the
  loop). 120s ≪ 10000s; documented, and the idle-backoff self-clamp is unaffected because a
  met→fail iteration is by definition not a rapid-idle one.
- **Output as an injection vector** — sanitize→scrub→clamp order + DATA labeling + fence
  treatment (§5.3).
- **Rollback:** config `realCheck.enabled:false` (read at the chokepoint each fire — no restart)
  reverts to transcript-only instantly. A job omitting `verification_command` is already
  unaffected.
