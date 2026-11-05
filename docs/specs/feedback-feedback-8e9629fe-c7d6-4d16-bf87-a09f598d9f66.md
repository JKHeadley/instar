---
title: "Session startup compatibility: surface and bound the instant-400 loop when Claude Code cannot run the pinned model"
slug: "feedback-feedback-8e9629fe-c7d6-4d16-bf87-a09f598d9f66"
author: "echo"
status: "draft"
parent-principle: "Signal vs. Authority"
---

# Session startup compatibility and terminal API failure reporting

**Initiative:** feedback-8e9629fe-c7d6-4d16-bf87-a09f598d9f66
**Cluster:** cluster-session-silently-fails-every-turn-when-claude-code-binary-is
**Severity:** critical
**Component:** session startup compatibility and failure reporting

## 1. Problem

A session can be launched on a Claude Code binary that cannot run the model it
was pinned to. Every turn then fails at once with API 400. The session process
stays alive and sits at its prompt, so it looks healthy. The user's message goes
unanswered and nothing explains why.

Two things are missing:

- **Prevention.** Nothing compares the Claude Code version with the model before
  launch. Codex already has this check; Claude does not.
- **Classification.** A permanent 400 is treated as a transient blip, or is not
  noticed at all.

## 2. Evidence

### 2.1 The report

One report, received 2026-10-25, reporter-written and scrubbed:

| Time (2026-10-25) | Event |
| --- | --- |
| 17:49:22 | Session for topic 128732 spawned for a forwarded message (Mama PC) |
| 17:49:28 | Message injected; every turn then failed instantly with API 400 |
| 18:00 | Operator updated to Claude Code 2.1.310 and refreshed; this fixed it |

The reporter asks that spawn check binary/model compatibility, or detect the
instant-400 loop, and update or fall back automatically.

**What the report does not contain:** the exact 400 text, the old binary version,
the pinned model id, where the pin came from, and any server log lines. This
draft was written with no network and without that host's logs, so the incident
was **not reproduced**. Section 2.3 is derived from reading the code at
`e5f88b0fe`, which is newer than the code running on the incident date.

### 2.2 What the code does today (verified by reading)

- **No Claude version floor.** `resolveModelForFramework` passes raw ids straight
  through to `--model` (`src/core/frameworkSessionLaunch.ts:45`).
  `src/core/Prerequisites.ts` reads the Claude version only for display.
- **The allowlist has no version dimension.** `KNOWN_CLAUDE_MODEL_IDS`
  (`src/core/ModelTierEscalation.ts`) records in comments that ids were verified
  on specific CLIs (`claude-fable-5-1` on 2.1.263, `claude-opus-5-5` on 2.1.281).
  The validator cannot use that information.
- **Codex has the check Claude lacks.** `codexSupportsGpt61Sol`
  (`src/core/codexCapabilities.ts:20`) gates `gpt-6.1-sol` on CLI version, in both
  `TopicProfileResolver` (`modelSource: 'older-codex-cli-fallback'`, with a
  once-per-topic notice) and `SessionManager.resolveCodexLaunchModel`.
- **The launch binary's version is already readable.**
  `resolveSessionClaudeVersion` (`src/core/nativeHookEventsGate.ts:58`) reads the
  configured path, or the retained copy, and never PATH.
- **Every idle API error is treated as transient.** `TERMINAL_ERROR_PATTERNS`
  includes `invalid_request_error` (`src/core/SessionManager.ts:466`), and
  `server.ts:14631` reports all of them with `errorClass: 'transient-api'`.
- **Only two 400 shapes count as permanent.** `ContextWedgeSentinel` matches the
  thinking-block 400 and the Usage Policy rejection. An incompatible-model 400
  matches neither. Its escalation also goes through `SentinelNotifier`, which by
  default writes to logs and sends nothing to Telegram.
- **instar has no Claude Code updater.** The only references are install hints
  (`Prerequisites.ts`, `commands/setup.ts`, `install/doors.ts`).

### 2.3 Why the user can hear nothing

These defects are visible in the code. Which one, or which combination, happened
on 2026-10-25 is **unconfirmed** until the logs in section 8 are checked.

**D1. The error check runs once per idle episode and can run too early.** The
check sits inside `if (!this.idlePromptSince.has(session.id))`
(`SessionManager.ts:3725`), so it runs only on the first idle tick. `rawInject`
clears the idle clock (`:9124`) before the paste is submitted, and Enter follows
about 500ms later. The monitor ticks every 5s. A tick landing between the clear
and the error appearing re-seeds the clock on a clean pane. The next tick takes
the `else` branch at `:3829`, and the error is never classified. Normal turns are
safe because a working session is seen as active, which resets the episode. An
instant failure may finish between ticks and never be seen as active.

**D2. The per-episode guard is not re-armed by new input.** `errorNudgedSessions`
is cleared only at `:2222` and in the "Session is active" branch at `:3879`.
`rawInject` does not clear it. A session that fails instantly may never reach the
active branch, because the prompt footer that `IDLE_PROMPT_PATTERNS` matches can
stay on screen. After the first report, later failed turns can then go unreported
until the session ends.

**D3. Recovery may declare false success (needs live confirmation).**
`RateLimitSentinel.verify()` treats any transcript growth as recovery. If Claude
Code writes the nudge and the failed reply to the JSONL, a turn that failed with
400 reads as "Back online — the API error cleared". This code path is verified.
Whether Claude Code writes those entries on this failure is not.

**D4. When the notice does fire, it is wrong.** The user is told it is "likely a
brief server-side blip" and "You haven't been dropped". After the full budget of
6 attempts (530s of backoff plus 6 × 25s verify windows, about 11 minutes), the
final notice says "This is on Anthropic's side" and points to a status page. None
of that is true here, and none of it names the fix. Each attempt also spends a
request that cannot succeed.

**D5. Nothing reaches the user through a dependable route for this class.** Any
reuse of the `ContextWedgeSentinel` route would inherit the logs-only default
described in section 2.2.

Ruled out: the simple theory that the idle clock stays set across injection, since
`rawInject` does clear it. D1 is the narrower race that remains.

## 3. Goals and non-goals

**Goals**

1. A permanent startup or request failure produces one visible, actionable
   message in the user's topic, or a recorded audit event if no channel is
   reachable.
2. The message names the real cause: binary version, model, where the pin came
   from, and the next step.
3. Recovery is bounded and cannot loop.
4. Model configuration stays authoritative. No pin or config is ever rewritten,
   and any substitution is explicit, disclosed and limited to one session.
5. The user's unanswered message is not lost.

**Non-goals**

- Automatic Claude Code updates in this slice (see section 5.5).
- Replacing pane parsing with a structured harness signal. That is already a
  tracked follow-up of `idle-error-tailgate-corroboration.md`.
- Changing transient, throttle or wedge handling beyond the classification split.
- Codex, Gemini and other frameworks. The classifier takes a `framework` argument
  so they can be added later.

## 4. Proposed design overview

| Layer | Change | Default |
| --- | --- | --- |
| A. Detect | Fix D1 and D2; add a pure terminal-failure classifier | On |
| B. Route | Send permanent failures to a new owner, not `RateLimitSentinel` | On |
| C. Notify | Immediate fixed-template notice on the topic route | On |
| D. Prevent | Launch preflight using a learned compatibility memo | On, warn or refuse per section 5.4 |
| E. Recover | One bounded respawn; opt-in same-family fallback | Respawn on, fallback dark |

A through C are the fix for the reported silence and can ship alone. D and E build
on them.

## 5. Detailed design

### 5.1 Detection

**New pure module `src/core/TerminalApiFailureClassifier.ts`.** It follows the
`IdleErrorClassifier` and `LoginExpiredSignature` rules: no I/O, tail-gated,
frame-discriminated, and a signal only. It reuses `paneTail` helpers.

```ts
type TerminalApiFailureKind = 'model-incompatible' | 'request-rejected';
interface TerminalApiFailure {
  kind: TerminalApiFailureKind;
  status?: number;        // parsed from the `API Error: <status>` frame
  matchedLine: string;    // clamped, lead-stripped, for audit and the notice
}
function classifyTerminalApiFailure(paneText: string, opts?: {
  framework?: IntelligenceFramework; tailLines?: number;
}): TerminalApiFailure | null;
```

- `model-incompatible`: an `API Error:` frame whose status is 400 or 404 and whose
  text matches a model-compatibility phrase.
- `request-rejected`: any other `API Error: 400` frame that is not a known wedge
  signature. `classifyWedgeTail` is checked first, so wedges keep their owner.
- 429, 5xx, timeouts and connection failures return `null` and stay on the
  transient path unchanged.

The phrase list **must come from a real captured pane**, per the repo's Scrape and
Parser Fixture Realness lesson. No phrases are guessed in this spec. Until a
capture exists, these failures classify as `request-rejected`, which still gets
the safe behavior below, with a generic cause line.

**Fix D1: a bounded re-check window.** `rawInject` records
`lastInjectAt[session.id]`. While `now - lastInjectAt` is within
`terminalFailureRecheckMs` (default 120s), every idle tick runs the classifier,
not only the first. The cost is one capture per tick for that window, and only
for sessions that just received input.

**Fix D2: re-arm on input.** `rawInject` also clears `errorNudgedSessions` and
`idleErrorClassified` for the session. `errorNudgeTotal` stays as the lifetime
cap. Re-arming does not cause spam, because the sentinel's own dedupe and the
section 5.3 dedupe still apply.

**Freshness.** A stale error left over from an earlier turn must not count against
a new message. A hit counts only if the pane changed since the injection, using a
snapshot hash taken in `rawInject`.

### 5.2 Routing

`SessionManager` runs the terminal classifier before the transient path and emits
a new event:

```ts
terminalApiFailureAtIdle: [sessionName: string, failure: TerminalApiFailure];
```

- `model-incompatible` is confirmed when the pane is byte-identical across two
  consecutive ticks (the existing settle idea). No nudge is sent.
- `request-rejected` keeps today's retry, but only once. A second identical
  failure after that retry, or after the next user message, is terminal.
- Both are excluded from `apiErrorAtIdle`, so `RateLimitSentinel` never sends
  "transient blip" wording for them. That addresses D3 and D4 for this class.

**Also fix D3 for what remains on the transient path.** `verify()` should not
report recovery while the live tail still shows an `API Error:` frame. It is a
small change and is strictly more conservative.

**New owner `src/monitoring/TerminalApiFailureSentinel.ts`.** It owns notify,
memo write and recovery, using the injected-deps pattern. It holds no blocking
authority. While it is mid-recovery it joins the composed zombie-kill veto
(`server.ts:14607`) and the mutual `deferIf` with the other sentinels.

### 5.3 Notification

- **Route:** `buildRateLimitRecoveryDeps`-style delivery: topic first, then
  lifeline, then a `recovery-unreachable` audit event. **Not** `SentinelNotifier`,
  because its default is logs only (D5).
- **Timing:** on confirmation, target under 20s after the failed turn.
- **Dedupe:** one notice per session episode, plus a per-(binary version, model)
  window of 1 hour for sessions on the same host, so a bad update does not flood
  every topic. Suppressed notices are logged and counted.
- **Content:** a fixed template with no LLM involved. `matchedLine` is scrubbed
  before use, since pane text is untrusted.

Example for `model-incompatible`:

> I couldn't answer your message. This machine's Claude Code (2.1.2xx) can't run
> the model this topic is set to (`claude-opus-5-5`, from the topic's pin). Nothing
> is wrong on Anthropic's side and retrying won't help. Your message is safe.
> To fix it: update Claude Code on this machine, and I'll pick up your message.
> Or tell me to use a different model for this topic.

Every value comes from the session record and `resolveSessionClaudeVersion`. If
the version is unreadable, the template says so. It does not guess. The notice is
written for the user and does not expect them to run a command unless they are
the operator. The update command goes to the lifeline or attention item.

### 5.4 Prevention: launch preflight

New pure module `src/core/claudeModelCompatibility.ts`, called from both places
the Codex gate lives: `TopicProfileResolver` and a new
`SessionManager.resolveClaudeLaunchModel`, which covers interactive and headless
launches.

**The source of truth is a learned memo, not a hand-kept table.** The verified-on
versions in `ModelTierEscalation.ts` are upper bounds on the true minimum. Using
them as floors would falsely refuse working combinations.

- On a confirmed `model-incompatible`, the sentinel writes
  `{ cliVersion, modelId, observedAt, matchedLine }` to
  `.instar/state/claude-model-compat.json`.
- `checkClaudeModelCompat({ cliVersion, modelId, memo })` returns `compatible`,
  `known-incompatible` or `unknown`.
- `known-incompatible` applies to that exact version and any older version.
- An entry stops applying as soon as the binary version changes to something
  newer, so updating clears it with no manual step.
- CLI aliases (`haiku`, `sonnet`, `opus`, `fable`) are never gated.
- A seed floor may be added for a model only when a real refusal has been
  observed on a known version.

**Launch behavior:**

| Result | Behavior |
| --- | --- |
| `compatible`, `unknown`, version unreadable | Launch unchanged. A preflight defect must never block a spawn. |
| `known-incompatible`, fallback allowed (section 5.5) | Launch on the fallback, with a notice |
| `known-incompatible`, no fallback | Do not spawn into a dead session. Send the section 5.3 notice and keep the message queued for the update path. |

The first failure on any new pair still costs one failed turn. That is accepted:
detection makes it loud, and the memo stops it repeating.

### 5.5 Recovery policy

Ordered, and each step runs at most once per failure episode:

1. **Binary already newer.** If `resolveSessionClaudeVersion` now reports a newer
   version than the session launched on, do one continuity-preserving refresh
   with the same pin. The transcript is not corrupted, so `fresh` stays false.
   This automates what the operator did by hand at 18:00. A periodic low-frequency
   check while a failure is open catches an update made after the notice.
2. **Fallback, only if the operator allowed it.** See the table below.
3. **Stop.** No further automatic attempts. The session stays alive and the notice
   stands. Any new user message gets a short repeat of the cause and is not sent
   into the failing turn.

**Model-configuration rules:**

| Pin source (`modelSource`) | Automatic fallback |
| --- | --- |
| `profile-pin`, `profile-tier-pin` | Never by default. The user chose it, so they are asked. |
| `topicProfiles-config-default`, `group-config-default`, `frameworkDefaultModels` | Only if `sessions.claudeCompat.fallback.enabled` is true |
| `local-model-binding` | Never |

With fallback enabled, these invariants hold:

- The fallback is `sessions.claudeCompat.fallback.model` if set, otherwise the
  same-family CLI alias (`claude-opus-5-5` becomes `opus`). Whether an alias works
  on an old binary must be confirmed in reproduction before this default ships.
- It is never a higher or more expensive tier. `resolveTierModel` and the closed
  enum still apply.
- It lasts for one session. No pin or config is written.
- The session records `modelSource: 'older-claude-cli-fallback'`, mirroring Codex,
  and `GET /sessions` shows the model actually in use.
- The user is told in the same turn.

**Bounds:** at most 1 automatic respawn per episode and 3 per (binary version,
model) per hour, on top of the existing `SessionRefresh` limit of 5 per 10
minutes. Recovery calls use `callerClass` so the work gate still applies.

**New `SessionRefresh` option:** additive `modelOverride?: string`, set only by
server-internal callers, on the same terms as `callerClass` (invariant I11: no
route may populate it from request input).

**The unanswered message.** With `--resume`, the failed user turn is already in the
transcript. Recovery passes `followUpPrompt` as an internal message asking the
session to answer the last user message. It must not re-inject the text as if the
user had sent it again. Verify in reproduction that the resumed transcript really
holds that turn. If it does not, keep the text from the injection record and replay
it once.

**Automatic update is deferred on purpose.** The reporter suggested it, but it is
a different kind of action: it changes a shared global binary for every session
and agent on the host, runs package installs unattended, and needs its own failure
handling. `ClaudeBinaryRetainer` does make it safer for running sessions. It
deserves its own spec and an explicit operator decision. Until then, step 1 picks
up any update within a bounded time of it landing.

## 6. Configuration

```jsonc
"sessions": {
  "claudeCompat": {
    "detection": { "enabled": true, "terminalFailureRecheckMs": 120000 },
    "preflight": { "enabled": true },
    "autoRespawnOnNewerBinary": true,
    "fallback": { "enabled": false, "model": null }
  }
}
```

New keys need `ConfigDefaults` entries, and existing agents need a
`PostUpdateMigrator` entry plus agent-awareness text. Fallback ships dark, in line
with the Graduated Feature Rollout track.

## 7. Failure modes considered

| Risk | Mitigation |
| --- | --- |
| Agent quoting a 400 triggers the classifier | Tail gate, frame match, change-since-injection and settle checks |
| Stale error blamed on a new message | Pane snapshot taken at injection |
| Transient 400 marked permanent | `request-rejected` retries once; only a phrase from a real capture is immediately terminal |
| False memo entry blocks a healthy pair | Written only on confirmed `model-incompatible`; version-scoped; cleared by any newer binary; add a `GET` view and manual clear |
| Claude Code changes its error wording | Falls to `request-rejected`, which is still loud. Count classifier misses as an under-fire canary. |
| Preflight slows spawn | `resolveSessionClaudeVersion` probe is bounded and should be cached per binary; the memo is a small file |
| Notice flood across topics | Per-(version, model) dedupe window |
| Respawn loop | Hard limits in section 5.5, and step 3 stops |
| Pane text leaks secrets into a notice | Scrub and clamp `matchedLine` |
| Multi-machine: memo is per host | Intended, because the binary is per host. Do not sync it. |

## 8. Reproduction and validation

**Before implementation (needs a host with network and credentials):**

1. From Mama PC logs around 2026-10-25 17:49–18:00, pull `idle-error-classify`,
   `[RateLimitSentinel]`, and any `recovery-unreachable` events. Their presence
   or absence decides between D1, D2, D3 and a delivery failure.
2. Record the old binary version, the pinned model and its `modelSource`.
3. Run an older binary with that pin, inject a message, and save the real pane as a
   fixture under `tests/fixtures/captured/`. Repeat on 2.1.310 as the control.
4. Inspect the session JSONL after a failed turn to settle D3.
5. Confirm the same-family alias works on the old binary, and that a `--resume`
   after updating still holds the unanswered turn.

**Tests to add:**

- Unit: `TerminalApiFailureClassifier` using the real fixture, plus negatives for
  quoted errors, stale scrollback, wedge signatures, 429 and 5xx.
- Unit: `checkClaudeModelCompat` for exact, older and newer versions, aliases and
  unreadable versions.
- Unit: `RateLimitSentinel.verify()` does not report recovery while the tail shows
  an API error.
- Integration on the monitor tick, with a fake pane and clock:
  - D1: a tick lands between injection and error, and the failure is still caught.
  - D2: a second failed turn in the same session is still seen.
- Integration: failure produces exactly one topic notice with no nudge, and
  lifeline or audit fallback when there is no topic.
- Integration: recovery limits hold, and no pin or config file changes after a
  fallback.
- End to end with `tests/fixtures/fake-claude-confined-tui.mjs` or a similar fake
  CLI that fails every turn with the captured text.

**Done when:** the section 8 reproduction, rerun on the fix, shows a topic notice
naming the real cause within 20s, no retry loop, and a working session with the
message answered after updating.

## 9. Rollout

1. Reproduction and fixture (section 8).
2. Layers A to C: detection, routing, notification. These stop the silence and
   take no destructive action.
3. Layer D: memo and preflight.
4. Layer E: respawn on newer binary, with fallback dark.
5. Watch the counters for false positives before anyone turns fallback on.

## 10. Open questions for the operator

1. Should an explicit topic pin ever fall back automatically? This draft says no:
   ask the user, even though the topic waits until someone answers.
2. Should unattended Claude Code updates get their own spec, or stay manual?
3. When preflight refuses a spawn, is holding the message until the update right,
   or should the session use the account default model with a notice?
