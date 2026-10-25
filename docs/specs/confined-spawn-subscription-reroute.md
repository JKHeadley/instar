---
title: Confined spawns on the subscription path — the interactive reroute carries the confinement adapter
status: converged
created: 2026-10-19
owner: echo
parent-spec: docs/specs/feedback-triage-and-execution.md
related-spec: docs/specs/june15-headless-spawn-reroute.md
parent-principle: "Bounded Blast Radius"
eli16-overview: confined-spawn-subscription-reroute.eli16.md
tracked: ACT-111
review-convergence: "2026-10-19T18:58:31.216Z"
review-iterations: 12
review-completed-at: "2026-10-19T18:58:31.216Z"
review-report: "docs/specs/reports/confined-spawn-subscription-reroute-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "the coordinating desk session (topic 18330 run run-mvfjbluq-1520f04e, 2026-10-19): a desk-level process decision under the operator's standing direction that only constitution changes need his separate sign-off; the operator was not asked"
approved-date: "2026-10-19"
---

# Confined spawns on the subscription path

## Problem

Terms used below (from the parent spec):
- **Confinement canary**: the must-fail/must-succeed sandbox self-test the executor runs before every attempt, half through the sandbox runtime and half in a confined Claude Code session. Its stamp includes the Claude Code version, so a new version re-runs the full check.
- **Approver-independence tap**: the operator's one-time dashboard acceptance that lets the executor run while this agent could itself act as the repository's approver.
- **Pane scraping**: Instar reads a session's terminal with `tmux capture-pane` and types with `tmux send-keys`. `❯` is Claude Code's selection and prompt glyph. `injectAfterReady` is the reroute's generic "wait for a prompt, then type". `tailShowsMenu` is the generic menu detector, which requires `1.`-style numbered options.
- **Pane / lane / degradation report**: a pane is the tmux terminal a session runs in; a lane is how a Claude session is launched (headless `-p`, or rerouted interactive); a degradation report is Instar's audited record of a fallback or failure (`DegradationReporter`), surfaced on `/health` and the degradation digest.
- **SDK-pot pressure**: the June-15 `auto` mode's signal that the Agent SDK credit pot is unknown or near-empty, which also triggers the reroute.

The feedback executor (`docs/specs/feedback-triage-and-execution.md` §4) runs two kinds of Claude Code session, both **confined** (`SessionManager.spawnSession({ confinement, omitAuthEnv, cwd })`):

- the session half of the confinement canary, before every attempt;
- the build session itself.

The June-15 headless reroute (`docs/specs/june15-headless-spawn-reroute.md`) moves every claude-code `claude -p` one-shot onto the interactive subscription lane when `intelligence.subscriptionPath.mode` is `force`, or `auto` under SDK-pot pressure. The confinement adapter was only built for the headless lane. So `spawnSession` refuses outright:

```
confinement-reroute-unsupported: the subscription-path reroute would launch an unconfined interactive session
```

The refusal is correct, since it never launches an unconfined session. But on an agent running `mode: force`, which includes the operated host today (verified 2026-10-19 in `.instar/config.json`), every executor attempt stops at the canary. The approver-independence tap the operator owes the executor would buy nothing. This was found during the Task E pre-tap readiness check (ACT-111).

The choice not taken is to run confined spawns as headless `claude -p` regardless of the mode. `force` exists to guarantee zero `claude -p` traffic (spec 04 Rule 1, `specs/provider-portability/04-anthropic-path-constraints.md`, locked by the operator: Claude work must run on the subscription path, never the per-call Agent SDK pot, once that pot bills separately). Carving out an exception changes that billing policy, and that is the operator's decision. (That `claude -p` draws on the separate Agent SDK pot after 2026-06-15 is the premise of the approved `june15-headless-spawn-reroute` spec, the operator's directive this agent runs under. This spec does not re-litigate it. It is recorded as a reviewable assumption: if a Claude Code release changes which lane bills which pot, the June-15 spec's owner re-checks it, and option B may then become free.) This spec keeps the policy and gives the interactive lane the same confinement.

## Goal

A confined spawn that the subscription-path policy routes to the interactive lane launches confined. Every guarantee the headless confined launch FIXES AT LAUNCH (G1–G9) is identical, and a launch where one cannot be met is refused, as today.

One property differs and is stated rather than hidden: the CLI's own tool-permission state. It lives inside the Claude Code process, so an interactive UI choice could in principle change it, while `claude -p` never shows a UI. In the confined interactive lane, keys are pressed only during startup (at most three: Down and Enter on the trust dialog, Enter on the browser offer) plus the one submitting Enter, each on a frame verified a moment earlier. A change is DETECTED after submission (the post-submit check) and ends the session, but it is not PREVENTED. That residual, before delivery and on known frames only, is Frontloaded Decision 6, accepted because the alternative is the status quo (no confined session can run under `force`).

Non-goals: changing the executor's sandbox policy (`buildClaudeSandboxSettings`); changing when the reroute applies; Codex or other frameworks (confinement stays claude-code only).

## The guarantees (headless confined launch today → interactive confined launch)

Every row is enforced in code and pinned by an argv test. A missing one is a thrown `confinement-adapter-missing:*`, never a silent launch.

| # | Guarantee | Headless (today) | Interactive confined (this spec) |
|---|---|---|---|
| G1 | No user or project settings, hooks or MCP config from disk; only the policy file plus the project-LOCAL settings file, which cannot exist | `--settings <file> --setting-sources local`; the executor deletes the workspace's `.claude/` before spawn, and the policy write-denies `.claude/` (Bash sandbox `denyWrite` + `Edit` deny), so `.claude/settings.local.json`, the one file the `local` source would load, can never be present | same flags appended to the interactive argv; assert present; the same workspace precondition |
| G2 | No permission bypass; `dontAsk`; file+shell tools only | remove `--dangerously-skip-permissions`, add `CLAUDE_CONFINED_PERMISSION_ARGS` | the interactive builder always emits `--dangerously-skip-permissions`: remove it, add `CLAUDE_CONFINED_PERMISSION_ARGS`; assert absent / present |
| G3 | No MCP servers | `--strict-mcp-config --mcp-config {"mcpServers":{}}` | same (`disableProjectMcp` forced on) |
| G4 | Empty environment plus allowlist | `/usr/bin/env -i` + PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_ALL, TERM, CLAUDE_CONFIG_DIR, CLAUDE_CODE_TMPDIR, TMPDIR, INSTAR_SESSION_ID, INSTAR_SESSION_NAME; credential-shaped names dropped | identical allowlist and filter, prefixed to the interactive argv |
| G5 | No agent authority in the tmux env either (defence in depth under G4) | INSTAR_AUTH_TOKEN blank; origin token blank (no origin session minted); no bind token; no vault GitHub token; credential-shaped vars blanked; GH_TOKEN, GITHUB_TOKEN, INSTAR_BIND_TOKEN, INSTAR_FENCING_TOKEN blanked | the rerouted path today mints an origin token, sets INSTAR_AUTH_TOKEN and adds the vault GitHub token. Under confinement each becomes the headless confined value. `linkAgentOwnedMemory` is skipped, as in headless |
| G6 | Temp directory is the attempt's | CLAUDE_CODE_TMPDIR/TMPDIR = confinement tmpDir | same |
| G7 | Fixed transcript location | `--session-id <uuid>` + `confinedConfigHome` on the session record | the interactive builder already emits `--session-id` when `options.sessionId` is set, and the executor's `spawnConfined` always sets it (a fresh uuid per spawn); the session record carries `confinedConfigHome` (pinned home, else default), and a test pins that it equals the `CLAUDE_CONFIG_DIR` the CLI starts with |
| G8 | cwd under `<projectDir>/.worktrees/` | validated at the top of `spawnSession` (shared) | unchanged: the same validation runs before either lane |
| G9 | Account pin | pinned home becomes CLAUDE_CONFIG_DIR | same (the rerouted lane already pins); the pinned home flows into G4's allowlist |

## Three interactive-only differences

`claude -p` takes its prompt as an argument, skips the workspace trust dialog, and is never watched by the pane auto-answerers. The interactive lane differs on all three, and each difference is a new attack or failure surface the confined lane must close.

### D1. Prompt delivery must not type untrusted text into the REPL

The file indirection closes one thing only: untrusted text acting as REPL input (commands, early submits). The model still READS the untrusted triage text from the file and may follow it, and the parent spec's safeguard against that is confinement plus the diff, secret and human-review gates, not prompt hygiene (`feedback-triage-and-execution.md` §4 step 6).

The rerouted lane delivers its prompt by typing it into the pane (`injectMessage`). A build prompt embeds the triage `summary` and `brief`, which derive from untrusted external reports. Text typed into an interactive REPL is input to the REPL itself: a line beginning with `/` is a slash command (`/add-dir`, `/permissions`, `/mcp`, …), and an embedded newline submits early. The headless lane never had this surface, because its prompt is one argv element.

**Rule:** a confined interactive session is never typed anything but trusted fixed text. Trusted code writes the full prompt, including the completion-sentinel instruction in its split-piece form, to `<confinement tmpDir>/confined-prompt-<sessionId>.md` (mode 0600; the tmpDir is inside the session's write scope and read scope). It then types one fixed line built only from that path: `Your task is in <path>. Read that file with the Read tool and follow it exactly.` The path is trusted-built (attempt dir + uuid, `[A-Za-z0-9/._-]` only, checked before typing; anything else fails closed). This applies to EVERY confined interactive spawn, whatever the caller's prompt contains.

### D2. Startup dialogs: a deterministic startup state machine

An interactive launch shows dialogs `claude -p` skips. Measured 2026-10-19 on Claude Code 2.1.300 and 2.1.303 with the exact G1–G6 argv, in a fresh attempt workspace:

1. **Workspace trust**: "Quick safety check: Is this a project you created or one you trust?", the absolute workspace path, `❯ No, exit` (focused) and `Yes, I trust this folder`, then the affordance `Enter to confirm · Esc to cancel`. Trust is NOT inherited from the trusted agent home: the dialog appeared although the agent home is trusted in the same config home.
2. **Browser tools offer**: "Claude in Chrome extension detected", `❯ No, keep browser tools off` (focused) and `Yes, use my browser`, `Enter to confirm · Esc to keep browser tools off`.

Neither dialog has numbered options, so the existing menu detector (`tailShowsMenu`, which requires `N.` options) classifies BOTH as a **ready prompt** (the `❯` glyph). The rerouted lane's `injectAfterReady` would therefore type into the trust dialog, and its Enter selects `No, exit`. Readiness for a confined session must be decided by its own classifier, not the generic one.

**The classifier** (`src/core/confinedStartupDialogs.ts`, pure). Its input is the VISIBLE screen (`capture-pane` without scrollback, so a dialog that scrolled away is not current) plus the expected workspace path. Its output is one observation, decided in this precedence:
1. a footer of any other permission mode (`bypass permissions on`, `accept edits on`, `plan mode on`, `auto mode on`) → `dialog-unknown` (not a confined session);
2. both known dialog markers on one screen → `dialog-unknown` (an unmeasured state);
3. the trust question → `trust-dialog` only if `Yes, I trust this folder` and the exact absolute workspace path are present. The path matches as a whole: one trimmed line equal to it, or up to four consecutive trimmed lines joining to it (a wrapped path). A path that merely starts with the workspace never matches, and the workspace itself must contain no whitespace (executor attempt paths never do; a confined spawn under a whitespace path is refused at spawn by name, `workspace-path-whitespace`, never left to fail as `dialog-unknown`). Otherwise `dialog-unknown`. The browser-offer text → `browser-offer` only if `No, keep browser tools off` is present; otherwise `dialog-unknown`;
4. any other dialog affordance (`Enter to confirm`, `Esc to cancel`, `Esc to keep`), a numbered menu (`tailShowsMenu`), or login-required text → `dialog-unknown`;
5. the POSITIVE composer shape: the confined footer `don't ask on` (live proof that G2's `dontAsk` is active), directly above it a rule, above that the `❯` input line (possibly wrapped over several lines), above that another rule (measured idle and working on 2.1.300/2.1.303) → `ready`. Footer and glyph alone are not enough, so an overlay without that frame is never `ready` and is never typed into;
6. otherwise `starting`.
Focus is checked separately at each answer: the browser offer is accepted only when its focused line (the `❯` line) reads `No, keep browser tools off`, and the trust Enter only when the focused line reads `Yes, I trust this folder`. Fixtures include the measured frames, the footer, mixed frames (trust plus browser), a stale-dialog-in-scrollback frame, and a wrapped path.

**The state machine is the authority** (deterministic, a floor; the classifier is its detector). One subsection per state. Within a state, rules apply top to bottom, EXCEPT that the precedence rule and the state's own deadline are evaluated before its observation rules, so a persistent dialog fails at the state's deadline, never at the whole-run budget.

**Precedence (every state):** another permission mode on screen → `failed`. The whole-run budget (120 s: the reroute's measured ~90 s ready-gate worst case plus 30 s for two dialogs) spent, or the driver's iteration cap reached → `failed`. Timing constants and their basis: 500 ms poll (a dialog redraws within one poll on the measured host), 5 s focus budget and 10 s dismissal budget (a dismissal rendered within ~2 s), 3 post-submit samples 300 ms apart (the measured working frame appears within 300 ms). They were measured on one host (the Mac Studio, 2026-10-19) and are constants in one module.

**`starting`** (the initial state; re-entered after each dismissal)
- `starting` → wait (poll 500 ms).
- `ready` → type the fixed D1 line WITHOUT Enter; re-capture; if the screen is still `ready` and shows the typed line (whitespace-insensitive, so a wrapped line matches), press `Enter` → `awaiting-post-submit-check`; otherwise → `failed` (nothing submitted).
- `trust-dialog`, not yet answered → send `Down` → `awaiting-trust-focus`. Already answered once → `failed`.
- `browser-offer`, not yet answered, focused line `No, keep browser tools off` → send `Enter` → `awaiting-browser-dismissal`. Already answered, or focus elsewhere → `failed`.
- `dialog-unknown` → first consecutive frame: wait (a redraw can show a half-drawn frame); second consecutive frame → `failed`. The consecutive counter resets on any other observation. This two-frame tolerance exists ONLY in `starting`.

**`awaiting-trust-focus`** (≤ 5 s; deadline first)
- the 5 s budget → `failed`.
- not `trust-dialog` (the whole rule-3 match) → `failed`.
- focused line `Yes, I trust this folder` → send `Enter` → `awaiting-trust-dismissal`.
- focused line `No, exit` (the Down not yet rendered) → wait, sending no key.
- any other focused line → `failed` at once.

**`awaiting-trust-dismissal` / `awaiting-browser-dismissal`** (≤ 10 s; deadline first)
- the 10 s budget → `failed`.
- the same dialog still shown, or a blank/starting frame → wait, sending no key.
- the dialog gone → `starting`, evaluating this same frame there (it may show the next dialog or the prompt).
**`awaiting-post-submit-check`** (≤ 3 samples over ~1 s)
- a frame with the `don't ask on` footer, no other mode, no dialog → save `confinedDeliveredAt` → `delivered`.
- a frame with another mode or a dialog → `failed` at once.
- three unclear (half-drawn) frames → `failed`.

**`failed`**: inject nothing; kill this session; report a degradation with the observed state, the rule applied and the first line of the unrecognised dialog (bounded to 120 chars, scrubbed).

**`delivered`**: terminal; nothing is ever pressed again.

**The residual race, named, and what bounds it.** A check-then-press can never be atomic against a screen another process draws. A dialog that appears in the milliseconds between the final capture and a key would receive that key. What that key can and cannot change is not uniform, so the claim is split:
- **Fixed at launch, unreachable from any in-session UI choice:** the empty environment plus allowlist (`env -i`: no INHERITED environment credential; the CLI still authenticates through its own config home's login, which no model-run tool can reach because the Bash sandbox denies the keychain and the home config files, as the runner and session canaries check); the OS sandbox for Bash and every child process (loaded from the `--settings` policy at launch); `--strict-mcp-config`; `--setting-sources local`.
- **NOT fixed at launch:** Claude Code's own tool-permission state (the Read/Edit/Write rules and the permission mode) lives in the CLI process and could in principle be changed by a UI choice. A stray Enter could therefore loosen the file tools (not the Bash sandbox and not the environment).
- **The mitigation is detection, not prevention:** 300 ms after the submitting Enter, the driver re-captures. The session must still show the `don't ask on` footer, no other permission mode, and no dialog. That frame was measured: on 2.1.303 the footer stays during work, reading `don't ask on (shift+tab to cycle) · esc to interrupt`, and it is a test fixture. Anything else ends the session at once (`post-submit-mode-or-dialog-check`). Nothing stops the model starting a tool inside those 300 ms, so this is detection of a changed mode, not a barrier. `confinedDeliveredAt` is saved only after this check passes, so a restart between the Enter and the check kills the session at boot.
- **What remains:** a change that leaves the footer and screen identical but loosens a rule. No such dialog has been observed, and for the canary session the effect probes would catch it. This last residual is accepted by name.

Repeated identical frames never cause another key. Each dialog type is answered at most once; seeing it again after its dismissal was observed fails closed. Every transition is logged (session name, state, observation, action). That log is the record of what the authority saw and did.

Why answering the trust dialog is sound here: the dialog protects against a folder's own configuration (project settings, hooks, MCP servers) running with the user's authority. Trusted executor code created this folder itself (a clone at a known base SHA, `.claude/` removed). The confined launch already refuses that folder's configuration independently: G1 loads the `local` source only, the policy write-denies `.claude/`, and G3 disables MCP. The trust decision was made by the executor when it built the workspace, and the dialog would ask a person to repeat it with no person present. Precedent: `detectClaudePrompt` already auto-accepts the ToS consent dialog by the same Down+Enter. Claude Code records the acceptance in the config home's `.claude.json` through its own write path. Instar never writes that file, because it is shared with every live session on that config home. A later attempt reusing the same path (`feedback-<id>-a<n>`) is again a workspace trusted code built, so the persisted entry grants nothing new. That accumulation is accepted by name. It is bounded by attempts (at most `maxStartsPerDay`, default 6, plus one canary per attempt sharing the path), roughly 2,000 entries a year; the operated host's `.claude.json` already holds over 22,000 project entries from ordinary use.

Answers happen only BEFORE delivery. Nothing the session prints later can be answered, because the state machine has ended (`delivered` or `failed`), so a model printing dialog-like text cannot make Instar press a key. A dialog that appears AFTER delivery (an asynchronous offer, a login expiry) is therefore never answered. Instead, the monitor loop reports it once per session as a degradation (`SessionManager.confinedSession`) naming its first line, with login-required named distinctly. So the caller's eventual timeout has a named cause and is not a silent 10–45 minute stall.

Dialog text is version-dependent. A Claude Code update that rewords either dialog lands in `dialog-unknown`: a visible degradation and a failed canary, never a wrong answer. The fixtures are the measured pane captures.

### D3. No generic auto-answerer may answer a confined session

The monitor loop feeds every running session's pane to two auto-answerers: the always-on `PermissionPromptAutoResolver` (pre-gated on `Esc to cancel` / numbered options), and, when `monitoring.promptGate` is enabled (it is on the operated host, with `autoApprove`), the PromptGate `InputDetector` → `AutoApprover`, which answers an `Esc to cancel` confirmation with `Enter`. On the trust dialog, `Enter` selects `No, exit`. That races the state machine and kills the session. Worse, after startup an auto-approver answering a permission prompt inside a confined session would loosen confinement by policy-outside-the-policy.

**Rule, enforced at the real chokepoints:** no Instar writer may press a key or type into a confined session (any session whose record carries `confinedConfigHome`, before or after delivery) except during the D2 startup driver's hold on that session. The exclusion is TIME-scoped, not identity-scoped: while `confinedStartupHolders` holds a session (at most the 120 s startup budget) the guard admits any caller, not only the driver; that is acceptable because the monitor loop already skips both auto-answerers for every confined session, so no other writer is evaluating that pane during the hold, but "the only writer" would overstate it. The guard (`confinedWriteRefused`) is consulted at every raw `tmux send-keys` path: the text chokepoint `performTmuxInjectionEffect` (every `injectMessage`, the `/compact` control command), `sendKey` and `sendKeyAsync` (prompt answers, paste retries), `performStuckInputKeyEffect` (the stuck-input recovery keys), `detectClaudePrompt`'s consent auto-accept, and the server's `tmuxOps.sendKeys` (message delivery) through the public `isConfinedWriteRefused`. Four raw sites are allowlisted by name with their reason beside them: the driver's own fixed-line send; the operator `/interrupt` Escape (a non-typing key that cancels, never accepts, a dialog); the setup-time login pane; `C-c` to the agent's own server pane. A test enumerates every `send-keys` / `buildLiteralSendArgs` site in `src/core/SessionManager.ts`, `src/commands/server.ts` and `src/server/*.ts` and fails on any site that is neither guarded in its enclosing function nor allowlisted, so a new raw writer cannot appear unnoticed in those files. Known limits of that ratchet: it matches the quoted `send-keys` argv forms and the shell-string `send-keys -t` form, not an arbitrarily constructed argv; and it scans those files only. Writers outside the scan, which resolve their targets from their own handles and are practically unreachable for a confined session: the provider adapters (`anthropic-headless`, `anthropic-interactive-pool`, `openai-codex` control and canary paths), `ServerSupervisor`, `cli.ts`, and `codexHookArm` (Codex sessions only). `MessageDelivery` is gated through `tmuxOps.sendKeys`. Killing the session stays allowed.

## Restart boundary

The D2 state machine is in memory. A server restart during startup must neither resume it nor leave a half-started confined session for anything else to answer. Two rules:
- **Identity first.** The monitor loop and both auto-answerers act only on sessions present in the state store (`listSessions({status:'running'})`). The confined session's FIRST save already carries `confinedConfigHome` and `launchLane: 'rerouted-interactive'`, and the state machine starts only after that save. So there is no window in which a generic answerer can see the pane without also seeing the exclusion: before the save, the session is invisible to the monitor; from the save on, it is excluded. This holds across restarts. A test pins the ordering: the state machine's first capture happens after `saveSession` with the field set. The record gains `confinedDeliveredAt` (ISO), saved only AFTER the submitting Enter AND the post-submit check passing. The save re-reads the live record and adds only that field, so a completion reap that already landed (a sentinel printed within the ~1 s check window) keeps the record `completed`; the two can never contradict, and the executor judges the outcome from artifacts either way. Precedence at boot, for a surviving rerouted session: (1) dead → purged; (2) confined and undelivered → killed; (3) a rerouted JOB (`jobSlug` set) → killed, by the June-15 adopt-or-kill rule, whether or not it is confined or delivered; (4) otherwise kept. A confined executor spawn never carries `jobSlug`, so rule 3 never applies to it in practice; if both ever held, the kill wins (the safe direction).
- **Boot reconciliation kills undelivered confined sessions.** `purgeDeadSessions` already kills surviving rerouted job sessions (june15 finding O3). It additionally kills any surviving session with `launchLane === 'rerouted-interactive'`, `confinedConfigHome` set and `confinedDeliveredAt` absent (reason `boot-reconcile-confined-undelivered`). Headless confined sessions, which also carry `confinedConfigHome` but are never 'delivered', are untouched, and the executor's restart adoption of them is unchanged. No startup state is ever resumed, and no prompt is ever typed twice. A delivered confined session is kept: the executor already re-adopts a running build after restart, and an orphaned canary session ends at its sentinel or its 10-minute cap.
The window between `tmux new-session` and that first save is synchronous: no `await` runs between them in `spawnReroutedInteractive`. A process death inside it leaves an untracked pane named with the project prefix. That pane holds no prompt and no credentials (G4), and the existing `OrphanProcessReaper` ("instar-orphan: in a tmux session matching project naming but not tracked") already cleans exactly that shape. No new mechanism is added for it.
Crash points tested: after Down; after the trust Enter; after the browser Enter; after typing but before the submitting Enter; and after that Enter but before `confinedDeliveredAt` is saved. Each of these leaves no `confinedDeliveredAt`, so each is killed at boot. The last is ambiguous (the task may have been submitted), and killing is the answer for ambiguity: the executor judges whatever the session wrote by its effects, and nothing is ever re-sent into it. The worst case is a canary or attempt that fails and retries, never a double delivery.

## Completion provenance

The reroute's completion detection scans the pane for the assembled sentinel `INSTAR_JOB_COMPLETE_<id8>`. In the confined lane that literal never appears in anything Instar types or writes: the D1 line contains no sentinel piece, and the prompt file carries only the three pieces, never their concatenation (the reroute's split-piece rule, `reroute-sentinel-echo-collision`). The suffix is 32 random bits of a `randomUUID()` generated at spawn, after every report was authored, so pre-written report text matches only by a 1-in-2^32 guess per attempt: improbable, not impossible. Hence the invariant this spec relies on is the narrow one: **completion alone never authorizes success.** The executor judges every outcome from artifacts (the canary's report file and transcript; the build's result file and the verification gates). An early reap therefore ends the session early; whatever it had written by then is judged on its own merits. Tests pin exact matching (an evidence file with the prefix and another suffix does not reap), and the typed line and prompt file never contain the assembled literal.

## Shared adapter

Both lanes apply G1–G6 through ONE helper, `applyClaudeConfinement(argv, envOverrides, confinement, ids) → { argv, envFlags }`, with one set of assertions. The headless lane is refactored onto it byte-for-byte; its existing argv-pin tests must pass unchanged. Two copies of a security adapter drift. One helper makes "the same guarantees" structural.

## Lifetime

The rerouted lane reaps on the completion sentinel or `maxLifetimeMinutes` (config `subscriptionPath.maxReroutedLifetimeMinutes`, default 45). A confined caller passes its own `maxDurationMinutes`: 10 for the canary, up to the lease for a build. For confined spawns, `maxLifetimeMinutes = options.maxDurationMinutes ?? configured`. A build must never be reaped by the reroute's generic job cap, and the caller's own bound is the contract it already relies on. Non-confined reroutes are unchanged.

## Gate and accounting

A confined reroute passes through the same `evaluateRerouteGate`, with the same cap and memory-pressure gate. Under `force` it refuses loudly as before; under `auto` it degrades to the headless confined lane (unchanged). It counts toward `maxRerouted` like any reroute. `launchLane: 'rerouted-interactive'`, `completionMode: 'pattern'`.

Sequence, for one confined attempt under `force`: admission (lane full → claim nothing) → claim (debits one daily start) → canary spawn → [gate refuses → `stopForRerouteCapacity`: stop + refund, one transaction] → canary judged → build spawn (same refusal handling) → build.

**Cap contention.** Under `force`, a saturated reroute cap refuses a confined spawn exactly as it refuses any job. The gate files a `SessionManager.spawnReroutedInteractive` degradation report and throws. The cap is shared with jobs, A2A and other rerouted spawns, so the executor's own concurrency does NOT bound how long it can be refused: starvation is possible for as long as other traffic holds every slot. The executor must therefore neither burn its allowances on a refusal nor churn while refused:

- **Admission pre-check (the normal path).** `SessionManager.confinedRerouteCapacity()` returns `'available' | 'saturated' | 'not-rerouted'`. `saturated` ONLY under `force` with the cap full or memory pressure elevated (same counters as `evaluateRerouteGate`). Under `auto` a full lane falls back to the headless confined lane, so admission never holds a claim back there (`not-rerouted`); under `off`, likewise. The executor's existing admission port gains `rerouteSaturated()`. When saturated, the tick claims nothing: no attempt row, no daily start consumed, no clone, no spawn. It records `wouldStart` / admission reason `reroute-capacity`. The next opportunity is the next tick, so the job cadence (30 min) is the loop's bound, and nothing repeats faster than the scheduler already runs it (No Unbounded Loops).
- **Typed refusal (the race path).** The gate throws a `RerouteRefusedError` (`code: 'reroute-refused'`, carrying the reason) rather than a bare `Error`. The executor maps it by class, never by message text, to: attempt `stopped`, reason `reroute-capacity`; no `afterFailure` (the item is not at fault); and the daily start this attempt consumed is refunded EXACTLY ONCE. `FeedbackExecuteStore.stopForRerouteCapacity(attemptId)` does, in ONE owner-fenced transaction: the attempt becomes `stopped` / `reroute-capacity`; the refund is keyed by attempt in its own ledger (`execution_refunds`); and the debit is reversed on the UTC day the attempt was CLAIMED (not today). A crash before that transaction (a process kill inside a synchronous stretch: no `await` runs between the spawn throw and the transaction) leaves a `claimed` attempt. The executor's existing restart path ends it as `stopped` / `interrupted`, which by design does not count against the item (no `afterFailure`). That one start is not refunded: one lost start per crash, bounded by crashes. A crash after it leaves a complete, consistent record. There is no state between the two. Debiting later (reserve at claim, confirm after the spawn gate admits) was considered: it changes the parent's CAS claim, which already guards concurrent claims, while the race it addresses is the rare one the admission pre-check leaves. So the smaller change is to reverse the debit, not to restructure the claim. It allows at most `maxStartsPerDay` refunds per claim day: past that, a race refusal keeps its start, so gross claims, and therefore canary launches, are bounded by 2 × `maxStartsPerDay` per UTC CLAIM-day cohort (12 at the default), and build sessions by `maxStartsPerDay` per claim day. The bounds are per claim-day cohort, not per calendar day of execution: preparation, a canary (up to 10 minutes) and a build can run past midnight after a late claim, and their refusal and refund still book to the claim day (Capacity Safety). A test drives repeated refusals to that bound (at the canary spawn; the build spawn goes through the same `prepareAndSpawn` catch). The enforced quantity is therefore charged claims minus permitted refunds (the `execution_daily` counter), not build launches: a claim is charged before its canary, a refusal at the canary or the build spawn is refunded within the cap, and a crash before the refund or a refusal past the cap keeps its charge. Actual build launches are visible separately (`counts.running` and the attempt rows). Tests pin the class mapping (a reworded message cannot change it), the final attempt state, the item's failure counters and the daily balance after repeated refusals, a duplicate call, a refund across UTC midnight, and the cap.
- **Visible, not silent, and braked.** A saturated tick is not a retry loop: it is the existing scheduled tick evaluating admission and taking NO action. It only holds the claim back. It claims, clones and spawns nothing, so there is no repeated self-action to brake beyond the job's own cadence. Each saturated tick shows `reroute-capacity` in `GET /feedback-factory/execute/status` (`admission`), and each race refusal files the gate's degradation report. A sustained episode is told once: after 12 consecutive saturated admission checks, one `FeedbackExecutor.rerouteCapacity` degradation report; the episode resets on the first free check. At the scheduled 30-minute cadence that is about 6 hours. Manual ticks (rate-limited) also count, which only makes the report come sooner. A reserved slot or fair-share admission was not chosen: the cap bounds host memory for every lane, and on the operated host (`maxRerouted` 6, executor `maxConcurrent` 2) no starvation has been observed. If it is observed, these records are the evidence for building fair admission then.

## What changes in code

- `src/core/SessionManager.ts`:
  - `spawnSession`: the `confinement-reroute-unsupported` throw is removed, and confined spawns take the normal reroute decision.
  - New `applyClaudeConfinement` helper used by both lanes (Shared adapter).
  - `spawnReroutedInteractive`: under confinement it uses the helper (G1–G6), skips origin/bind/GitHub/memory-link, blanks INSTAR_AUTH_TOKEN, records `confinedConfigHome`, sets the lifetime, writes the prompt file (D1), and delivers via `runConfinedStartup` (D2) instead of `injectAfterReady`. The non-confined path is byte-for-byte unchanged.
  - Monitor loop: both auto-answerers are skipped for sessions with `confinedConfigHome` (D3).
  - `purgeDeadSessions`: kills surviving confined REROUTED sessions without `confinedDeliveredAt` (Restart boundary). `Session` gains optional `confinedDeliveredAt`.
- `src/core/SessionManager.ts` also: `RerouteRefusedError` thrown by the force-mode gate; `confinedRerouteCapacity()`.
- Executor (`FeedbackExecutorService`, `buildFeedbackExecutor`, `FeedbackExecuteStore`): admission `rerouteSaturated()` (no claim while saturated); `RerouteRefusedError` → `stopped` / `reroute-capacity`, no `afterFailure`, daily start refunded. These are the only executor changes; its sandbox policy and canary are untouched.
- `src/core/confinedStartupDialogs.ts` (new, pure): the classifier and the state-machine transition function `stepConfinedStartup(state, observation) → { next, action }`.
- No change to the executor's sandbox policy, the canary, or the reroute policy.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| `spawnSession`: confined spawn + reroute decision (was: refuse) | `invariant` | Deterministic routing: the existing reroute policy decides the lane. This spec only removes the blanket refusal and makes the interactive lane carry the same adapter; it adds no judgment. |
| Confined interactive adapter assertions (G1–G7) | `invariant` | Safety floor: each guarantee is a structural property of the argv/env, checked by assert-or-throw. A floor must be deterministic. |
| D2 startup state machine (may an unattended process press a key in a confined session's startup dialog) | `invariant` | Safety floor with a bounded action space: answer trust only on exact path + verified focus, answer the browser offer only with its focused safe default, wait without keys, or refuse-and-kill this session. No competing signals are weighed, and a deterministic refusal on any deviation is the floor. |
| Executor admission `rerouteSaturated()` (claim nothing while the reroute lane is full) | `invariant` | Reads the same counters the reroute gate enforces; it only holds a claim back until the next scheduled tick (conservative), never grants anything. |
| D3 auto-answerer exclusion for confined sessions | `invariant` | Removes authority (no generic answerer may act on a confined session); it never grants any. |
| Confined reroute lifetime (`maxDurationMinutes ?? configured`) | `invariant` | The caller's declared bound is the contract; no weighing. |

## Multi-machine posture

Machine-local BY DESIGN: a spawn is a process on the machine that runs it, and the trust entry Claude Code writes lives in that machine's config home.
machine-local-justification: physical-credential-locality — the confined session runs under a Claude Code login (config home) that physically lives on one disk; its trust entry and transcript live in that same config home.
New state, by kind:
- `Session.confinedDeliveredAt`: a field on the session record, which is machine-local like every session record (a session is a process on one machine). Old code ignores the field.
- `execution_refunds`: a table in the executor's canonical drain database (`CREATE TABLE IF NOT EXISTS`). It is written only through the owner-fenced `stopForRerouteCapacity`, so only the canonical owner writes it. It is backed up with that database by the existing drain backup cadence, and is replicated or proxied exactly as the parent spec's executor tables are. Old code ignores it.
- One degradation report class per failure kind.
No notices, no URLs.

## Frontloaded Decisions

1. **Option A over option B.** The interactive lane carries the confinement adapter. Confined spawns do NOT bypass the `force` policy into `claude -p`, because that would change the operator's locked billing policy (spec 04 Rule 1). Not cheap-to-change-after: it is a billing posture.
2. **Answer the trust dialog (exact path, verified focus) rather than pre-writing trust or using a per-attempt config home.** Checked first: Claude Code 2.1.303 `--help` documents no flag, setting or environment variable that pre-trusts a directory or suppresses these dialogs in interactive mode (the only documented skip is `-p` / non-TTY output, which is the billing path `force` forbids). Pre-writing `projects[<path>].hasTrustDialogAccepted` races Claude Code's own writes to the config file shared by every live session on that login. A per-attempt config home has no login: on macOS the OAuth credential is keyed to the config directory, and copying it would relocate a subscription credential (forbidden by the Subscription & Auth Standard) and race its refresh. Answering in the pane uses Claude Code's own write path. Precedent: `detectClaudePrompt`'s consent auto-accept.
3. **Fail closed by killing the session** on any unrecognised startup state, so the caller is released at once and the degradation names the dialog.
4. **Lifetime follows the caller's `maxDurationMinutes`** for confined reroutes only.
5. **No Claude Code version allowlist for the trust answer, and no pinned binary for confined spawns.** What answering the trust dialog grants is exactly what `claude -p` grants implicitly: the CLI's help states that the trust dialog "is skipped when Claude is run in non-interactive mode (via -p ...)". The headless confined lane has always run trusted in that sense, and the interactive answer adds no reliance the headless lane did not already have. What keeps either lane confined is split in two, and the claim is narrowed to match:
   - **Effects the canary measures before every attempt**, version-stamped: reads of the agent config, a secret nonce and the home directory (Bash, node and the Read tool); outbound network; keychain; writes outside the workspace, to system temp, to `.git/config` and through `node_modules`; the publish clone; hard and symbolic links. A Claude Code release that weakened any of these would fail the canary.
   - **Properties the canary does NOT measure** and that rest on Claude Code honouring its own flags, asserted at spawn and pinned by argv tests: G1 (`--setting-sources local`: no user or project settings; the one local file it would load cannot exist, see the G1 row), G3 (`--strict-mcp-config`: no MCP servers), G4/G5 (`env -i`: no inherited credentials; this one is enforced by `/usr/bin/env`, not by Claude Code). This is the same reliance the headless confined lane has today.
   A version allowlist or pinned binary would add a manual step to every update (or freeze security fixes) without measuring G1 or G3 either. A reworded dialog fails closed (`dialog-unknown`), and the fix is a fixture update. Operationally, a Claude Code release that rewords a dialog or the footer fails the next canary. That raises the executor's existing `profile-unenforceable` Attention item, and the instar-developing agent owns the fixture update, on the same day it is told (expected time to repair: same day; the executor waits, nothing is lost). It also does not blame feedback items: the confinement canary runs through this same launch path before every build, so a dialog change fails the canary first, which the executor already treats as an environment fault (`profile-unenforceable`, item untouched). A D2 failure on the build session after a passing canary counts as one ordinary failure. The canary and the build use the identical launch path, config home and workspace path, and the canary runs immediately before the build on every attempt, so an environmental dialog would hit the canary first (an environment fault, item untouched). A dialog that appears only on the second launch in quick succession is not a shape that has been measured; if one ever shows up it is the next fixture, and two such failures holding an item is the parent's existing policy for an unexplained failure. Completion stays pane-sentinel based (inherited from the reroute, and the executor judges by effects), and a documented interactive trust-skip upstream would retire D2: both are recorded as residuals in ACT-111, including whether to file the upstream request (a public post, decided by the coordinating session) and whether to put the `claude -p` carve-out (option B) to the operator as an explicit question. This spec does not need it; its cost is the TUI automation above. The live proof (Tests) adds one G1/G3 effect check the canary lacks: a planted project hook and a planted `.mcp.json` server in the workspace must not run or connect.
6. **Accept the pre-delivery UI residual (Goal).** Keys go only to frames verified a moment earlier, only before the model has the task, and a mode change is detected after submission and ends the session. Refusing instead (the status quo) means no confined session can ever run on an agent under `force`. Not cheap-to-change-after in the sense that it is a security posture, so it is named in the PR and ACT-111 for the coordinator to surface if the operator should see it.

## Detector declarations (Verify the State, Not Its Symbol)

| Detector | Symbol read | State claimed | Corroboration | When unmeasurable |
|---|---|---|---|---|
| Trust-dialog match | question text + exact workspace path + `Yes, I trust this folder` on the visible screen | the CLI is asking to trust exactly this executor-built folder | focus verified after Down (the screen must then show `❯ Yes, I trust this folder`); dialog dismissed within budget | unreadable or partial screen → `starting` (wait) then `failed` at budget; never a key |
| Browser-offer match | offer text + focused `No, keep browser tools off` | the CLI offers browser tools with the safe default focused | dismissal observed within budget | as above |
| Ready / post-submit check | `don't ask on` footer, no other mode, no dialog | the CLI is in the confined permission mode with nothing pending | NOT a proof of the full tool-permission state (Goal; Frontloaded 6). For the canary session the effect probes are the corroboration; for a build, the verification gates and the diff gate judge every output | unreadable → not `ready` → `failed`; nothing typed |
| `confinedDeliveredAt` (restart) | a saved timestamp | the task was submitted AND the post-submit check passed | written only after both, in that order | absent → killed at boot (ambiguity is killed, never resumed) |
| Executor `rerouteSaturated()` | the reroute counters + memory pressure | a confined spawn would be refused now | the gate itself still decides at spawn (race path typed) | an unreadable count is treated by the gate's own rules; admission only holds the claim back |

## Signal vs authority

The authority is the D2 startup state machine. It is a deterministic floor with a bounded action space: two known safe answers, wait, or refuse-and-kill this session. The pane classifier is its detector. Deterministic authority is correct here: the decision is "may an unattended process press a key in a security dialog", and the only acceptable policy is an exact allowlist with refusal on any deviation. A model weighing signals at that point would be the defect. The kill is scoped to the confined session this spawn just created, which no other caller references, and it is audited (D2 transition log plus degradation). Compared with today's blanket refusal, the confined rerouted lane can now run, but only through this floor.

## Framework scope

Confinement remains claude-code only. That is the parent spec's existing, stated gap against Framework-Agnostic (`feedback-triage-and-execution.md` §4 step 4: "Eligibility is decided by the canary, not by framework name ... This is an accepted, stated gap against Framework-Agnostic"). This spec neither widens nor narrows it. It removes a lane-specific refusal for the one framework that has an adapter. Other frameworks still join through the canary.

## Rollback

Revert the commit: confined spawns refuse on the rerouted lane again, exactly as today. **Rollback procedure:** the reverted code no longer excludes confined sessions from the generic auto-answerers (D3). So before downgrading, disable the executor (`feedbackFactory.execute.enabled: false`, which also disarms its PRs) and end any live session whose record carries `confinedConfigHome` (`POST /sessions/<name>/kill`). Then downgrade. The executor's existing `disabled` refusal (pinned in `execute-service.test.ts`) guarantees no new confined spawn is made meanwhile. What remains after a revert is inert: Claude Code's own trust entries for attempt paths, `confinedDeliveredAt` on old session records, and the `execution_refunds` table (refunds already applied stay applied; no code reads the table).

## Tests

- **Unit** (`tests/unit/session-manager-confined-reroute.test.ts`, mocked tmux like `session-manager-confined-spawn.test.ts`), under `subscriptionPathMode: 'force'`, for a confined spawn:
  - argv has `--settings <file> --setting-sources local`, `dontAsk`, `--tools Bash,Read,Edit,Write,Glob,Grep,TodoWrite` and `--strict-mcp-config`;
  - no `--dangerously-skip-permissions` and no `-p`;
  - the `/usr/bin/env -i` prefix with exactly the allowlist;
  - no credential-shaped variable, INSTAR_AUTH_TOKEN and INSTAR_ORIGIN_TOKEN blank, and no vault GitHub token;
  - the session record has `launchLane: 'rerouted-interactive'`, `confinedConfigHome`, and `maxLifetimeMinutes` equal to `maxDurationMinutes`;
  - the prompt file exists (0600) and holds the prompt with the split sentinel pieces but never the assembled literal;
  - a non-confined reroute's argv is unchanged, and the headless confined argv is unchanged (helper refactor).
- **Unit** (`tests/unit/confined-startup-dialogs.test.ts`): the measured captures classify as `trust-dialog`, `browser-offer` and `ready`. The following classify as `dialog-unknown`:
  - a trust dialog naming a DIFFERENT path;
  - the ToS consent menu;
  - a rate-limit options menu;
  - a `bypass permissions on` footer;
  - an unknown un-numbered dialog with `Enter to confirm`.
  State-machine cases:
  - trust → browser → ready types the fixed line once;
  - a repeated identical frame sends no extra key;
  - delayed rendering inside the deadline succeeds;
  - a dialog reappearing after dismissal fails;
  - a focus mismatch after Down fails;
  - the 90 s budget fails;
  - the typed line is the only text ever sent.
- **Unit** (restart boundary): `purgeDeadSessions` kills a live confined rerouted session without `confinedDeliveredAt`, keeps a delivered one, and keeps a headless confined session (three separate cases). The crash points above, simulated by dropping the in-memory state machine, never type the line twice.
- **Unit** (executor): with `rerouteSaturated()` true, a tick claims nothing and the daily start count is unchanged. A `RerouteRefusedError` from `spawnConfined` ends the attempt `stopped` / `reroute-capacity`, refunds the start, does not increment `failedSince`, and does not hold the item. A plain `Error` with the same message still maps to `prepare-failed` (the class decides, not the text). Six consecutive refusals followed by free capacity: the seventh tick starts the attempt.
- **Unit** (monitor loop): a session with `confinedConfigHome` never reaches the PermissionPromptAutoResolver or the PromptGate detector, while a normal session still does.
- **E2E** (`tests/e2e/confined-reroute-lifecycle.test.ts`): a production-shaped `SessionManager` under `subscriptionPathMode: 'force'` performs a REAL `spawnSession` with confinement against a fake `claude` binary. The fake prints the measured trust and browser dialogs, reacts to keys, records its argv and environment, then reads the typed line and prints the assembled sentinel. The test asserts:
  - the live tmux argv and env (G1–G6);
  - the exact keys sent;
  - that the prompt was delivered via the file;
  - that the sentinel reap ends the session;
  - a second variant where the fake shows an unknown dialog ends `failed`, with the session killed and nothing typed.
- **Live proof** (recorded in the PR, not CI): on the operated host, the executor's session canary run through the built `SessionManager` under `mode: force` reaches a verdict with every session probe judged. In the same confined interactive launch, a planted PROJECT settings file (`.claude/settings.json`, a SessionStart hook that writes a marker) and a planted `.mcp.json` server must leave no marker and no connection (G1/G3 by effect). The `local` source's own file cannot be planted under the policy, and the proof asserts that too: a Bash or Write attempt to create `.claude/settings.local.json` is refused.

## Maturation plan

- **test-agent-live:** done before merge on the operated host, recorded in the PR: the executor's own session canary, run through this branch's built `SessionManager` under `mode: force`, in a fresh, never-trusted workspace with a planted project hook and a planted MCP server. It is the throwaway-workspace equivalent of a throwaway agent, since the change has no agent-level state.
- **dev-agent-live:** live on the development agent from the release that carries it. It is reached only through the feedback executor, which is itself dev-gated and dry-run until the operator's approver tap and a deliberate `dryRun: false`. So the first real use is the executor's first real attempt.
- **fleet:** the same release. On the fleet the executor is dark, so no confined spawn happens and the change is inert there. The non-confined paths are byte-for-byte unchanged (pinned by tests).
- **graduation criterion:** over the first five real executor attempts on the development agent:
  - every session canary reaches a verdict with all session probes judged;
  - zero `dialog-unknown` and zero `post-submit-mode-or-dialog-check` failures that a fixture or the sandbox `/tmp` fix does not explain;
  - zero auto-answerer events on a confined session (the server log and the PromptGate audit).
  A count of zero attempts is not a pass.
- **dark-window:** tied to the executor's own rollout. If five attempts have not happened within 30 days of the executor going live on the development agent, the reason and a new date are recorded on ACT-111.

## Open questions

*(none)*
