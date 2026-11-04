---
title: "Cloud agents: the sign-in key reaches internal model calls, and a dead key is told and recovers"
slug: "cloud-key-internal-calls"
author: "echo"
status: "approved"
parent-principle: "No Silent Degradation to Brittle Fallback"
approved: true
approved-provenance: "Echo under Justin's standing rule (2026-10-22): only constitution changes need his approval; this touches no standard. Run commissioned in topic 137264."
topic: 137264
created: "2026-11-03"
eli16-overview: "docs/specs/cloud-key-internal-calls.eli16.md"
review-convergence: "2026-11-04T03:52:23.574Z"
review-iterations: 3
review-completed-at: "2026-11-04T03:52:23.574Z"
review-report: "docs/specs/reports/cloud-key-internal-calls-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Cloud agents: the sign-in key reaches internal model calls, and a dead key is told and recovers

## Problem statement

Found by the customer proof on nimbus (fb-03ec0234-b5b, fb-1dc4a0ca-260).

**A. Key-only agents have no internal model calls.** A headless cloud install has no stored Claude
login, only `sessions.credentials.anthropic` (an oauth-token from `claude setup-token`). Sessions work
because the key is passed to their tmux session. `ClaudeCliIntelligenceProvider` runs `claude -p` with
the server's own environment, which has no key. Every call fails: PromptGate 463/463 errors,
`llmReliability` failing, the circuit breaker opening repeatedly.

Measured with Claude Code 2.1.316 on 2026-11-03. Both failures exit 1, stderr holds nothing useful, and
the reason is only in the stdout JSON:

| Case | `is_error` | `api_error_status` | `result` |
|---|---|---|---|
| no key, no login | true | null | `Not logged in · Please run /login` |
| rejected key | true | 401 | `Failed to authenticate. API Error: 401 OAuth access token is invalid.` |

The provider's error text carries stderr only, so the cause is discarded today.

**What the gates do today on such an agent** (from the code; live confirmation is part of the proof):
- Outbound tone gate: on a provider error it drops to the deterministic leak floor
  (`buildDegradedToneResult(..., 'provider-error')`). A clean message sends with no model review, a real
  leaked artifact still holds. On the verified operator's channel an availability failure delivers,
  tagged `failedOpenOperatorChannel`. So it is not a plain fail-open, but no message gets a model review.
- MessageSentinel falls back to pass-through. ExternalOperationGate fails closed (show-plan).

**B. A dead key is silent and sticky.** With a rejected key the server logged the 401 about every 10
minutes and told nobody. The person saw "actively working", then nothing. After a good key was put back,
the live Slack session kept the dead key in its tmux environment and answered every message with
`Please run /login · API Error: 401` until the session was ended by hand.

## Spawn audit (fix the class)

Every server-side place that starts `claude`:

| Site | Has the key today | Action |
|---|---|---|
| `SessionManager` three session lanes (4244, 4672, 7409) | yes, tmux `-e` | none |
| `SessionManager` triage lane (7956) | **no** | fix |
| `ClaudeCliIntelligenceProvider` default path | **no** | fix |
| `ClaudeCliIntelligenceProvider` hardened reviewer path (allowlist env) | **no** | fix |
| `ProjectRoundExecution.spawnAutonomousChild` | **no** | fix |
| `PipeSessionSpawner` (Threadline, shell string) | **no** | fix |
| `TelegramLifeline` doctor session | **no** | fix |
| `anthropic-headless` one-shot | only from server env | fix (env, no argv) |
| `anthropic-headless` agentic session, `anthropic-interactive-pool` | only from server env | unchanged, see Frontloaded Decisions 5 |
| `--version` / `--help` probes, `claude auth` login panes | not needed | none |

## Proposed design

### Part 1: one key source for every child

The value stays the one PR #2632 resolves: `resolveAnthropicLaunchFields` into
`config.sessions.anthropicApiKey`. No second place to configure a key, no second resolver.

New `src/core/claudeChildAuth.ts`:
- `configureClaudeChildAuth(source: () => string | undefined)`: called once per process right after
  `loadConfig` in the server, the lifeline, `instar reflect` and `instar route`.
- `applyClaudeChildAuth(env)`: when the value is an oauth-token (`sk-ant-oat`), sets
  `CLAUDE_CODE_OAUTH_TOKEN`, sets `ANTHROPIC_BASE_URL` when configured, and deletes `ANTHROPIC_API_KEY` in the
  given child env, the same pairing sessions use. Otherwise it leaves the env alone. Used by every `execFile`/`spawn` site, after the
  hardened allowlist is built.
- `writeClaudeAuthEnvFile(dir)`: for sites that go through a shell string or tmux. Writes a `0600` file
  in the state dir that makes the same env change as `applyClaudeChildAuth` (token, base URL, API key unset); the shell sources it then deletes it,
  nothing else: the shell deletes it before `claude` starts. Returns null when no oauth key is set. The key never enters argv.

The source is read per call, so a restored key applies to the next call with no restart.

Part 1 off switch: `sessions.claudeChildAuth.enabled: false`, read live. The lifeline's source re-reads
`config.json` per call, because its config is frozen at construction.

A structural test walks `src/` for `execFile`/`spawn`/tmux launches of the claude binary and fails if a
site is neither using these helpers nor on an explicit exempt list with a reason.

### Part 2: a dead key is confirmed, told, and recovers

New `src/core/ClaudeKeyHealth.ts`, active only when the configured key is an oauth-token. On any other
agent it is inert and every path is unchanged. Registered as a self-action controller
(`@self-action-controller`, `SELF_ACTION_CONTROLLERS`, convergence test).

**Signals (never authority):** an internal call that failed on auth, or an interactive session on the
existing login-expired screen. A signal only asks for a probe. The provider adds a category (`auth:
rejected` or `auth: no-auth`) to its error text so logs state the cause. CLI text is never logged, so no
output can carry the key into a log.

**The probe** is its own direct call, not the provider door, because an open circuit breaker sheds calls
without spawning and the subscription router could answer from the pool without testing the key.
`probeClaudeKey(key)`: `execFile` of `claude -p` with the key passed explicitly, smallest model, spawn cap
only, bounded timeout, reading parsed stdout JSON. Typed result:

| Result | Meaning | Effect |
|---|---|---|
| `ok` | call succeeded | key works |
| `rejected` | `api_error_status: 401` | Anthropic refused this key |
| `no-auth` | `Not logged in`, no status | key did not reach the child: a wiring fault, not a bad key. Degradation report only. The operator is never told to replace a key on this result. |
| `inconclusive` | timeout, 429, 5xx, network, spawn-cap shed | nothing is concluded |

Probes are single-flight, emit no signals of their own, and are discarded if the configured key changed
while they ran. Minimum interval 5 minutes in `ok` state. Before any probe the module re-reads the key from
`config.json` (self-heal: a new key already there is simply used). On a parse failure the last key stands.

**States:** `ok`, `suspect`, `dead`. A first `rejected` goes to `suspect` and schedules one confirming probe 30
seconds later, exempt from the minimum interval. A second `rejected` on the same key goes to `dead`, so a single
blip pages no one. Any other result, or a key change, cancels it and returns to `ok`. Persisted in `state/claude-key-health.json`: dead key fingerprint (first 16 hex of SHA-256), first-seen
time, probe backoff, who has been told, sessions already refreshed, `sweepPending`. Never the key.

**While dead, or while recovery work is pending,** a 60-second timer re-reads `config.json` (local file read,
no model call, no restart) and works the pending list. A same-key probe backs off from 10 minutes, doubling to
a 1-hour ceiling, and stops after 24 hours dead: that is the sustained-failure breaker. After that only a
changed key or a successful key-carrying internal call starts a probe. An inconclusive probe of a new key retries
at 60 seconds, doubling to the same ceiling and under the same breaker. A changed key goes to `sessionManager.setAnthropicKey()` and `config.sessions`, since
`sessionManagerConfig` is a copy and respawns would otherwise keep the dead key.

**Telling people:**
- Operator: a dedicated send that returns whether anything was delivered, because `notify()` returns void.
  New category `claude-key`, admitted as `any` in `HUB_NOTICE_CATEGORIES`. It goes to the Telegram hub and the
  Slack attention channel. Sent once per dead key. "Told" is recorded only on confirmed delivery; a failed send
  retries on the next ticks, at most 5 times, then records a degradation. With no channel at all, the state
  shows in authed `/health` only, and that is a stated limit.
- Each person at a stuck session: one fixed server-written message in that session's channel (same lookup as
  PromptGate relay), once per dead key per channel.
- Authed `/health` gains `claudeKey: { status, since }`, degraded while dead. A degradation event is recorded.
- On return to `ok`: one all-clear line to the operator, and "told" is cleared so a later dead key is told again.

Operator text: "Your agent can't reach Claude because its sign-in key was rejected. It can't reply to anyone
until this is fixed. Create a new key with `claude setup-token` on any computer, then run `instar
set-claude-key` on the server and paste it. Open conversations will pick up by themselves once the key works."

Person text: "I can't reply right now because my sign-in key stopped working. I'll pick this conversation up once
it's fixed." It adds "My operator has been told." only when delivery was confirmed.

Neither text promises a message is kept. What is delivered is what the resume carries: messages reaching a
live session stay in its transcript. If a session ended in the window, or has no resume entry, its messages
are not replayed. This is a stated limit, measured in the live drill.

**Restoring:** `instar set-claude-key` reads from stdin or a hidden prompt, never argv, checks the shape with
`looksLikeClaudeToken`, and writes with the existing writer (moved to core, keeping any `baseUrl`). The timer
finds it within a minute, with no restart. A hand edit works the same way, and the boot check against the
persisted fingerprint covers a restart.

**Recovery:** a changed key proves nothing. It triggers a probe, and only `ok` ends the episode. A rejected new
key stays `dead` under its own fingerprint and the operator is told. On `ok`: `sweepPending` is persisted
first, then the sweep runs, and it is cleared after. A crash mid-sweep resumes at boot.

The sweep considers only live, channel-bound, unprotected claude-code sessions **currently showing the login
screen**. Each goes through `SessionRefresh.refreshSession` with a `followUpPrompt` telling it the key was down
and to answer anything unanswered. No `recovery` class: the ordinary work gate applies where it is on, because screen
text does not prove a session is idle. That gate is off on non-development agents, so there the limit is the rest of
the rule: after a proven outage, at the login screen, unprotected, once per session per key. On those agents, login
text printed by a working session during that one sweep can cost it a restart. A restart normally resumes the
conversation. With no resume entry it starts fresh, and a failure mid-restart leaves no session until the next message
arrives, so the worst case is one lost in-flight turn for that session. Session names stay on a persisted pending list that
the timer works in batches of 10, with a per-session try/catch, once per session per episode. A refusal is retried
on later ticks, at most 3 times, then reported as a degradation naming the session. That is safe to stop on: such
a session either holds a good key, so its next message simply works, or holds an old key, so the sink path above
picks it up on its next message.

A session holding the old key that was idle during the sweep fails on its next message. The sink then refreshes
it, only if the screen shows **and** its launch key, read from the single tmux variable and hashed in process, is
non-empty and differs from the current key. A matching key never refreshes, so
printing the login text in a session cannot cause a kill. Reported marks are cleared on
`ok` so this takes about a minute, not the 10-minute retry.

**Wiring:** the sink is set inside the subscription pool block today. `server.ts` composes it so
`ClaudeKeyHealth.handle(signal)` runs first and is wired whether or not a pool exists. On an oauth-key agent the
pool swap is skipped, because an env key overrides any pool account.

**Agent awareness:** `generateClaudeMd` and `migrateClaudeMd` gain `set-claude-key` and `/health.claudeKey`.

## Decision points touched

| Decision | Class | Notes |
|---|---|---|
| Is the key dead? | invariant | Two 401s from Anthropic on direct probes. Screens and internal failures are signals only. |
| Notify operator | invariant | Downstream of the self-heal re-read and confirmation. |
| Refresh a session | invariant | At the login screen only, plus a differing launch key outside a sweep. Once per session per episode. |
| Skip the pool swap | invariant | An env key overrides any pool account, so a swap cannot help. |
| Tone gate, sentinel, external gate | invariant | Their failure directions are not touched by this change. They simply start working on key-only agents. |

## Verify the state, not its symbol

| Detector | Symbol | State claimed | Corroboration | Cannot measure |
|---|---|---|---|---|
| Key dead | 401 on two probes | Anthropic refuses this key | Real authenticated calls | Why it was refused |
| Key restored | Probe `ok` on the configured key | The key authenticates | Real authenticated call. A changed fingerprint only triggers it. | That every old session recovered |
| Session stuck | Login frame in the live tail | Session cannot reach the model | Dwell, plus the key state or launch key. Text alone never kills. | Whether a frame was printed on request |
| Launch key | Hash of the session's tmux variable | The key the session started with | tmux sets it at launch and nothing changes it after | The running process's memory |

## Self-heal before notify

The operator notice is unreachable on first detection. Self-heal is re-reading the configured key, then a
probe. Only a confirmed rejection of the current key raises the notice. The agent cannot create a key, so
exhaustion is reached at that point.

## Multi-machine posture

Machine-local, and this is a stated limit, not a preference. The constraint: the key lives in each
machine's `config.json` and sessions are tmux processes on that machine, so only that machine can probe its
key or restart its sessions. Replicating the key between machines is a credential-sync feature this fix does
not add. On a two-machine agent each machine notices and reports its own key, and the operator restores each.
Key-only installs today are single-machine. Standby failover work (topic 137054) should revisit this.

## Security

- The key is never written to argv, logs, chat, health output or the state file. New code passes it by
  child env or a `0600` file removed by the shell that reads it.
- `tmux show-environment` output stays in process and is hashed.
- `/health` is public, so `claudeKey` sits in the authed block. Only the one tmux variable is queried.
- The env file is sourced and deleted before `claude` starts, written only for claude-code launches, and old
  ones are swept at boot.
- Three lanes gain a key they never had: pipe (trusted-peer text, unconfined Read), doctor (Bash, untrusted log
  content), triage (read-only; `credentialSource` becomes `env`). All can already read plaintext `config.json`, so
  this adds little exposure. Tightening pipe reads is filed as fb-63cb98a3-b95.
- Found and not changed here: the three session lanes pass the key in tmux `-e` argv, briefly visible in
  `ps`. Filed as fb-02ea7b0b-b49. New code does not extend this.

## Frontloaded Decisions

1. **API keys (`sk-ant-api`) are not passed to internal calls.** Subscription-by-default requires explicit
   opt-in for pay-per-call internal spending (`selectIntelligenceProvider`). Sessions keep their behaviour.
2. **An agent with both a key and a stored login:** internal calls use the key, matching its sessions. If that
   key dies its sessions are already dead, so one state is simpler than a fallback. The Part 1 switch undoes it.
3. **Key source is process-wide, set at entry points,** instead of a parameter on eight
   `buildIntelligenceProvider` callers, so a new caller cannot forget it. Set explicitly, not inside
   `loadConfig`, because a process may load another agent's config.
4. **Default on, no config migration.** Off switches read through LiveConfig: `sessions.claudeKeyHealth.enabled`
   and `sessions.claudeChildAuth.enabled`. The CLAUDE.md template change does migrate.
5. **Agentic headless and pool adapters unchanged:** opt-in, tmux `-e` only, so passing the key would add
   argv exposure. A key-only agent with `subscriptionPath` set keeps today's behaviour; that is reported as
   a limit.
6. **Health 24-hour window unchanged.** Old errors age out; health is not rewritten to look better sooner.
7. **Restoring needs a computer, and the paste page was cut.** `claude setup-token` is Anthropic's tool and has no
   phone form, so a computer is already required. A Secret Drop paste page was designed and removed after two review
   rounds: target installs have the tunnel off, so the link had no address, and it needed changes to Secret Drop's
   lifecycle. Filed as fb-9d604efd-1ef for when these installs have a reachable address.
8. **No expiry warning.** The token's expiry is not readable. Internal calls now find a dead key within
   minutes without waiting for a message.

9. **Rejected alternatives.** The existing `authCredentialInjection` probe calls the API directly and refuses subscription tokens, because a subscription token is for Claude Code's own use. So this probe goes through the Claude CLI. Setting the key in the server's `process.env` would hand it to every child, including
   non-Claude tools. Claude Code's `apiKeyHelper` was not pursued: whether it accepts these tokens is unverified, and
   it would add a per-session settings surface.

## Testing

- Unit: env overlay both kinds, hardened path keeps the allowlist plus key, env file mode and shell
  lifecycle, parsing of both real CLI outputs, state machine on both sides of each boundary (401 vs 429,
  timeout, 5xx, `no-auth`), dedupe per key per channel, boot check, sweep choosing sessions, forged screen with a
  good key causing nothing, stale-probe discard, crash mid-sweep.
- Integration: authed `/health` shows `claudeKey`; `instar set-claude-key` writes the key and refuses a wrong shape.
- E2E: production wiring: sink composed with and without a pool, the provider gets the key, a respawn after
  `setAnthropicKey` carries the new key, deps not null.
- Structural: spawn audit test, no key in argv.
- Live: on nimbus with only the key: internal call succeeds, health stops reporting llm failing. Dead-key
  drill: set a well-formed bad key (`sk-ant-oat...`), restart, open a Slack session; operator told; `instar
  set-claude-key`; the Slack session answers with no further step.

## Rollback

Revert the PR, or use the two off switches. Config is not migrated, so the leftovers are an unused state file and
a CLAUDE.md note.

## Maturation plan

- **test-agent-live:** the dead-key drill runs on nimbus, a real key-only agent on a real cloud server.
- **dev-agent-live:** inert on this development agent, which uses stored logins and no key, so there is nothing to
  exercise here. Unit and E2E tests cover the wiring.
- **fleet:** ships on by default to key-only agents. It fixes broken behaviour, and every other agent stays inert.
- **graduation criterion:** the nimbus proof passes: internal calls work with only the key, health stops reporting
  llm failing, and the drill recovers a Slack session with no manual step after the key is set.
- **dark-window:** none. A dark fix would leave every cloud install broken; the off switches cover a bad outcome.

## Stated limits

These were flagged by the standards check and are accepted for this fix, not solved by it:
- **Mobile-Complete Operator Actions:** restoring needs a computer. `claude setup-token` has no phone form, and the
  paste page was cut (Frontloaded Decision 7).
- **Always a Multi-Machine Entity:** each machine restores its own key, until credentials are shared between machines.
- **Always Reachable:** with a dead key the agent has no model, so its reachability floor is the fixed messages above.

## Open questions

*(none)*
