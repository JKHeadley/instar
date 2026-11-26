# Side-Effects Review — confined spawns on the subscription (rerouted interactive) lane

**Version / slug:** `confined-spawn-subscription-reroute`
**Date:** `2026-10-19`
**Author:** `Echo`
**Spec:** `docs/specs/confined-spawn-subscription-reroute.md` (converged at round 12; see its report)
**Second-pass reviewer:** required (session lifecycle, confinement, a gate). See the end of this file.

## Summary of the change

Under `intelligence.subscriptionPath.mode: force` (the operated host's mode), `SessionManager.spawnSession` refused every confined spawn (`confinement-reroute-unsupported`). The feedback executor spawns both its session canary and every build confined, so no executor attempt could ever run, even after the operator's approver tap. This change gives the rerouted interactive lane the same confinement as the headless lane:
- one shared adapter (`applyClaudeConfinement`): no permission bypass, `dontAsk`, the confined tool list, `env -i` plus an allowlist, and the attempt temp dir;
- no agent authority in the tmux env;
- the prompt delivered as a 0600 file behind one fixed typed line (D1);
- a deterministic startup state machine that answers only the measured trust dialog (exact path, verified focus) and the browser offer's safe default, and kills the session on anything else (D2);
- no Instar writer may press a key or type into a confined session except during the D2 startup driver's hold on it (a time-scoped exclusion, at most 120 s, during which any caller is admitted; the monitor already skips the auto-answerers for confined sessions, so none evaluates the pane then): the guard sits at the real chokepoints (`performTmuxInjectionEffect` for text, `sendKey`/`sendKeyAsync`, `performStuckInputKeyEffect`, `detectClaudePrompt`'s consent auto-accept, and the server's `tmuxOps.sendKeys`), and a test enumerates every raw `send-keys` site in SessionManager and the server and requires each to be guarded or allowlisted by name (D3);
- boot kills an undelivered confined rerouted session;
- the executor defers claims while the lane is full and maps a typed `RerouteRefusedError` to `stopped` / `reroute-capacity`, with an exactly-once, capped start refund.

## Decision-point inventory

- `spawnSession` confined + reroute — **modify**: from refuse to launch confined on the interactive lane.
- D2 startup state machine (`confinedStartupDialogs.ts` + `runConfinedStartup`) — **add**: deterministic floor; its only actions are two known safe answers, wait, type one fixed line, or fail-and-kill.
- D3 auto-answerer exclusion for `confinedConfigHome` sessions — **add**: removes authority only.
- `purgeDeadSessions` confined-undelivered kill — **add**.
- Executor admission `reroute-capacity`, plus the `RerouteRefusedError` mapping — **add**: defers or stops, never grants.

## 1. Over-block

- A Claude Code release that rewords either dialog, or the composer/footer, fails closed (`dialog-unknown`) until the fixtures are updated. The canary catches it first, so it shows as the executor's existing `profile-unenforceable` Attention item and the item is untouched.
- A sustained full reroute lane defers executor claims. This is visible: `admission: reroute-capacity`, plus one degradation report after 12 saturated ticks.

## 2. Under-block

- **Named residual:** a key pressed during startup or at submit could land on a dialog that appeared in the milliseconds after the last capture. Launch-fixed controls (env, Bash sandbox, settings sources, MCP) cannot be changed by it. The CLI's own tool-permission state could be, in principle. A post-submit check (the measured `don't ask on` footer, no dialog) detects a mode change and kills the session, but cannot prevent a tool call inside 300 ms. The spec accepts this as Frontloaded Decision 6, versus the status quo of no confined session ever running under `force`.
- The completion sentinel can be spoofed with probability 2^-32 per attempt by pre-written report text. Correctness rests on effects-based judgment, not on completion.
- Trust entries accumulate in the config home's `.claude.json` (about 2,000 a year at the default cadence).

## 3. Level-of-abstraction fit

- Confinement stays in SessionManager (one shared adapter for both lanes).
- The startup protocol is a pure module plus a thin driver.
- Capacity is handled at the executor's existing admission and error-mapping seams.
- The executor's sandbox policy and canary are untouched.

## 4. Signal vs authority compliance

- [x] Deterministic floor holding blocking authority, by design: the decision is "may an unattended process press a key in a security dialog". An exact allowlist with refusal on any deviation is the only acceptable policy, and an LLM there would be the defect.
- [x] Every other addition removes authority (D3) or only defers (admission).

## 5. Interactions

- **Reroute cap/gate:** confined spawns count toward `maxRerouted` like any reroute.
- **PromptGate/AutoApprover and every other pane writer:** on the operated host the PromptGate is enabled with `autoApprove`. Without D3 its Enter on the trust dialog would select `No, exit`. D3 removes that race at the chokepoints, so the `/compact` context-wall recovery, the stuck-input recovery keys, the generic consent auto-accept, paste retries and the server's message delivery all refuse a confined session (a stuck one is ended by its lifetime cap or `killSession`, never nudged). Allowlisted by name, each with its reason beside it: the driver's own fixed-line send; the operator `/interrupt` Escape (a non-typing key that cancels, never accepts); the setup-time login pane; `C-c` to the agent's own server pane.
- **OrphanProcessReaper:** cleans an untracked pane left by a crash between the tmux spawn and the first save.
- **Restart adoption:** headless confined sessions are untouched by the new boot kill; it applies to the rerouted lane only.

## 6. External surfaces

- Operator: none new. Each failure kind has a degradation report class (`SessionManager.confinedSession`, `SessionManager.runConfinedStartup`, `FeedbackExecutor.rerouteCapacity`).
- Install base: only agents running the executor under `force` or `auto` are affected. Every other spawn is byte-for-byte unchanged (pinned by tests).

## 7. Multi-machine posture

- Spawns and `confinedDeliveredAt`: machine-local by design (`physical-credential-locality`: the confined session runs under one machine's Claude login).
- `execution_refunds`: in the canonical drain DB, owner-fenced, backed up with it.

## 8. Rollback cost

Revert the commit. Before downgrading, disable the executor and end live sessions with `confinedConfigHome`, because the reverted code lacks D3. The remaining state is inert.

## Evidence

- **Unit:**
  - `confined-startup-dialogs.test.ts`: measured frames, precedence, the exact-path match, composer shape, state machine.
  - `session-manager-confined-reroute.test.ts`: argv/env pins G1–G9, D1 file delivery, typed refusal, driver echo-then-Enter and post-submit check, D3 exclusion, restart boundary.
  - `execute-reroute-capacity.test.ts`: deferral, typed mapping, exactly-once capped refund, cross-midnight refund.
  - `session-manager-confined-spawn.test.ts`: updated; the forced refusal is gone.
- **E2E:** `confined-reroute-lifecycle.test.ts`. Real tmux, production-shaped config, and a fake TUI that draws the measured dialogs.
- **Live (Mac Studio, 2026-10-19):** the executor's session canary, run through this branch's built `SessionManager` under `force`, in a fresh untrusted workspace with a planted project hook and planted MCP server.
  - The trust dialog was answered, the task was delivered by file, and `confinedDeliveredAt` was recorded.
  - 16/17 probes passed. The planted hook did not run and the planted MCP server did not start (G1/G3 by effect).
  - The one failing probe, `session-git-status`, fails because every Bash command exits 1 on Claude Code 2.1.303's cwd bookkeeping write to `/tmp/claude-501/`, which the executor's sandbox policy does not allow (it allows `/tmp/claude`). That is a sandbox-policy issue independent of the lane, out of this change's scope, and reported as the next executor blocker.

---

## Second-pass review (independent reviewer, run by the coordinating session, 2026-10-19)

**Verdict: Concern raised, otherwise strong.**

Concern: the D3 "refusal enforced at the chokepoint" claim was not true as written. `confinedWriteRefused` guarded `sendKey` and `rawInject`, but raw `tmux send-keys` writers bypassed both: `injectInternalControlCommand` → `performTmuxInjectionEffect` (the `/compact` context-wall recovery), `detectClaudePrompt`'s Down+Enter consent auto-accept, `performStuckInputKeyEffect` (StuckInputSentinel), and the server's `tmuxOps.sendKeys` (MessageDelivery). Practical reach was narrow (a confined session has no topic binding), but the real text chokepoint is `performTmuxInjectionEffect` and the real key chokepoints are those raw execs.

Confirmed without change: launch parity (shared `applyClaudeConfinement`; `--settings` + local source; strict MCP; `dontAsk` + fixed tools; `env -i` allowlist filtered by `isCredentialEnvName`; `CLAUDE_CODE_TMPDIR`/`TMPDIR`; `--session-id` from the executor), the 0600 `wx` task file and the fixed typed line, the startup machine's exact-match answers and bounded failure, the race's bounded persistence, the executor lease/hard-cap bounds; 46/46 tests. Pre-existing note (not new to this change): `anthropicEnvFlags` still put a configured API key into the tmux session env on both lanes while `env -i` keeps it out of the CLI.

**Fix applied (same branch):** the guard now refuses every write to a confined session, before or after delivery, from any writer except the D2 startup driver while it holds that session (`confinedStartupHolders`), and it is consulted at the real chokepoints: `performTmuxInjectionEffect`, `sendKey`, `sendKeyAsync`, `performStuckInputKeyEffect`, `detectClaudePrompt`, and the server's `tmuxOps.sendKeys` (via the public `isConfinedWriteRefused`). `tests/unit/confined-send-keys-chokepoints.test.ts` enumerates every raw `send-keys` / `buildLiteralSendArgs` site in `src/core/SessionManager.ts`, `src/commands/server.ts` and `src/server/*.ts` and fails on any site that neither consults the guard in its enclosing function nor carries a `confined-write-allowed: <reason>` comment. The four allowlisted sites are named above. The artifact and spec now say "every Instar writer through SessionManager or the server's tmux operations". Known limits, by name: the exclusion is time-scoped (any caller is admitted during the driver's ≤120 s hold, not only the driver); the ratchet matches the quoted `send-keys` argv forms and the shell-string `send-keys -t` form, not an arbitrarily constructed argv, and scans only those files; writers outside the scan, which resolve targets from their own handles and are practically unreachable for a confined session, are the provider adapters (`anthropic-headless`, `anthropic-interactive-pool`, `openai-codex` control and canary paths), `ServerSupervisor`, `cli.ts` and `codexHookArm` (Codex only). `MessageDelivery` is gated through `tmuxOps.sendKeys`.

**Re-check of 3a0aa3496 (same reviewer): Concur** (49/49 across 6 files), with the three wording corrections above applied.

---

## Addendum — D3 guard crashed the stuck-input recovery under a constructor-less harness (2026-10-20)

**What was found after the PR's required checks finally ran.** `Unit Tests (shard 1/4)` went red on
BOTH node versions with `tests/unit/session-multishot-recovery.test.ts` — 4 tests, first assertion
`expected 0 to be greater than or equal to 4`. That test is PRE-EXISTING on main; this PR broke it.

**Root cause.** `performStuckInputKeyEffect` opens with the D3 guard
`if (this.confinedWriteRefused(...)) return;`. `confinedWriteRefused` reads two **class-field
initialisers** — `confinedStartupHolders` and `confinedWriteRefusals` — which exist only when the
SessionManager constructor ran. The multishot test builds its manager with
`Object.create(SessionManager.prototype)`, so both are `undefined` and `.has()` threw a TypeError.
**Both enclosing catches swallow it** (`fireStuckInputRecovery`'s try/catch, and `verifyInjection`'s
"never throw from a background verification"), so the symptom was not an error but SILENCE: zero
stuck-input recovery keys instead of the escalating four. Confirmed from the test output:
`[SessionManager] fireStuckInputRecovery error ... Cannot read properties of undefined (reading 'has')`
on all four attempts.

**Fix.** Optional chaining on both Set reads. This PR already anticipated the identical hazard one
method up — `fireStuckInputRecovery` reads `this.strandedDraftMarkers?.get(...)` with a comment
saying "legacy harnesses may instantiate this narrow recovery surface without running the full
SessionManager constructor" — and simply missed the same case inside the guard.

### 1. Over-block
Before the fix the guard over-blocked absolutely: it refused EVERY stuck-input recovery key in any
harness that had not run the constructor, which is the opposite of D3's intent (D3 refuses writes into
*confined* sessions, not all sessions). After the fix it blocks exactly what the design says.

### 2. Under-block
None introduced. The refusal verdict is unchanged and still derives from
`session.confinedConfigHome` read out of durable state. A genuinely confined session is still refused.
What degrades when the Sets are absent is (a) the startup-driver ALLOW-list — absence makes the guard
*more* restrictive, never less — and (b) the once-per-session dedupe of the warning log. Both are
additive, and both only degrade in a harness, never in production where the constructor runs.

### 3. Level-of-abstraction fit
Correct layer. The alternative — stubbing the Sets in the test — would hide a real fragility in
production code behind test scaffolding, and would leave the next prototype-built caller crashing in
the same silent way. Making the guard tolerant of its own optional state is the lower, more durable fix.

### 4. Signal vs authority compliance
Compliant, and strictly improved. `confinedWriteRefused` IS an authority (it blocks writes), so its
logic must not be brittle. A `.has()` on possibly-undefined state is exactly the brittleness the
principle warns about: the guard's crash was silently converted into "refuse everything" by the
surrounding catches. Removing that crash path makes a blocking authority less brittle without widening
or narrowing what it decides.

### 5. Interactions
- The two swallowing catches are left as they are, deliberately. They exist so a background verifier
  can never throw into the caller, and that is right. The defect was the crash, not the catching.
- No interaction with the confined startup driver: `confinedStartupHolders?.has()` returning undefined
  for an un-constructed harness fails toward refusal, which is the safe direction.
- Verified no shadowing of the other four `confinedWriteRefused` callsites (`sendKey`, `rawInject`,
  `isConfinedWriteRefused`, the text path) — all keep identical behaviour in production.

### 6. External surfaces
None. No route, no message, no config, no state shape changes. The only externally visible difference
is that a stuck session gets its four escalating recovery nudges again instead of none — which is the
behaviour main already had before this PR.

### 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local BY DESIGN.** Stuck-input recovery acts on a tmux pane on the machine that owns the
session; both Sets are in-process state about local panes. There is nothing to replicate: a pane on
another machine is recovered by that machine's own SessionManager. No durable state, no generated URL,
no user-facing notice is involved, so there is no transfer-stranding or one-voice concern.

### 8. Rollback cost
Near zero. Revert two `?.` operators to `.` and the prior behaviour returns. No migration, no data
change, no agent-state repair. The lockfile half reverts by restoring the previous `pnpm-lock.yaml`.

## Second-pass review (Phase 5 — required: touches session-lifecycle recovery and a guard)

**Performed by the implementing agent as a deliberate adversarial pass, NOT by an independent reviewer
subagent.** Recording that honestly rather than claiming concurrence that did not happen: this session
operates under a standing constraint against spawning subagents unrequested, so the independent audit
Phase 5 asks for was not run. The trace records `secondPass: true, reviewerConcurred: null` so the gap
is visible rather than papered over.

Adversarial questions asked and answered:
- *Does optional chaining weaken D3 for a real confined session?* No — tested. The refusal comes from
  `session.confinedConfigHome`; `tests/unit/confined-send-keys-chokepoints.test.ts` and
  `tests/unit/confined-startup-dialogs.test.ts` still pass 23/23 after the change.
- *Could the undefined ALLOW-list now let a write into a confined session?* No. An undefined
  `confinedStartupHolders?.has()` is falsy, so the early `return false` (allow) is NOT taken — control
  falls through to the confined check. The failure direction is toward refusal.
- *Is this really a harness-only problem, or is production affected?* Production runs the constructor,
  so the Sets exist; and `confinedWriteRefused` already fails OPEN for a non-confined session
  (`if (!session?.confinedConfigHome) return false`). So no production session lost recovery keys. The
  defect's reach was the test harness — but it was a REAL defect in production code, found by a real
  pre-existing test, and the fix belongs in the production code.
- *Is the lockfile change in scope?* It is a pre-existing drift on main (`@sagemindai/threadline-core`
  added to `package.json` without `pnpm-lock.yaml`) that makes THIS PR's `UX assertions (messaging
  E2E)` check fail on `ERR_PNPM_OUTDATED_LOCKFILE`. Bundled deliberately so one merge clears both this
  PR's red checks; the diff is +11/-0 and purely additive.
