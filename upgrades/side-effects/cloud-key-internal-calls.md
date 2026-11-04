# Side-Effects Review — cloud agents: sign-in key for internal calls, dead-key handling

**Version / slug:** `cloud-key-internal-calls`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `independent general-purpose reviewer agent`

## Summary of the change

Every server-side `claude` child now gets the configured oauth key through one helper (`claudeChildAuth`), reading the value PR #2632 already resolves. New `ClaudeKeyHealth` confirms a dead key with a direct probe, tells the operator and waiting people with fixed text, and restarts sessions stuck at the login screen once a working key is proven. New `instar set-claude-key`.

## Decision-point inventory

- Is the key dead — add — two 401s from Anthropic on direct probes.
- Notify operator — add — after the self-heal re-read and confirmation.
- Refresh a session — add — at the login screen, bounded per episode, through the ordinary work gate where it is on.
- Skip the pool swap on a key agent — add — an env key overrides any pool account.
- Tone gate, sentinel, external gate — pass-through — failure directions untouched.

---

## 1. Over-block

The new code blocks nothing inbound or outbound. `set-claude-key` refuses a value that doesn't look like a `claude setup-token` key; a valid key of a future shape would be refused until `looksLikeClaudeToken` is updated. The pool swap is skipped on key agents, which is correct because an env key overrides any pool account.

---

## 2. Under-block

A session that ended during an outage has its messages not replayed. A key-only agent with `subscriptionPath` set keeps today's behaviour on the opt-in tmux adapters. An API-key-only agent's internal calls stay failed, by the subscription-by-default rule. The three session lanes still pass the key in tmux `-e` argv.

---

## 3. Level-of-abstraction fit

The key travels through one small module beside the config, not a parameter on eight provider callers, so a new caller can't forget it. A structural test holds that. Recovery reuses `SessionRefresh` and the login-screen classifier, and adds no second restart path.

---

## 4. Signal vs authority compliance

Signals: internal call failures and the login screen. They only request a probe. Authority: Anthropic's own 401 on a real call, twice. A deterministic check is right here, because it reads a status code and judges no meaning. The refresh is further limited. Outside a recovery sweep, a matching launch key never refreshes. During the sweep after a proven outage, screen text is enough, once per session per key. The work gate applies where it is on, which is development agents. Elsewhere login text printed by a working session during that sweep can cost it one restart. That normally resumes the conversation; with no resume entry it starts fresh, and a failure mid-restart leaves no session until the next message. The worst case is one lost in-flight turn.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

All points are invariant: each reads a status code, a hash comparison or a counter. None weighs meaning.

---

## 5. Interactions

- Circuit breaker: the probe bypasses it on purpose; the spawn cap still applies.
- Pool swap: skipped on key agents through `prependInteractiveLoginExpiredSink`; unchanged elsewhere.
- Triage lane: previously had no key and hardcoded `credentialSource: 'store'`. It now reports `env` when a key is passed.
- Tone gate, sentinel and external gate start getting real answers on key agents, so messages that passed the fixed leak floor may now be held by a model verdict. That is the intended behaviour and a visible change for those agents.
- Agents with a key and a stored login: internal calls move to the key, matching their sessions.
- Stage-B release evidence: `claudeChildAuth.ts` is reached by import from the certified set, so it is listed as excluded with a reason. A Codex launch never reads it, and no certified file changed.

---

## 6. External surfaces

New CLI command. Authenticated `/health` gains `claudeKey`, and public `/health` may read degraded while dead. Fixed text goes to the Telegram hub, the Slack attention channel and session channels. The probe makes one small authenticated call, and in `ok` state at most one per 5 minutes when signals arrive.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The notice says what happened, what it means and the exact steps, in plain words. Restoring needs a computer, because `claude setup-token` has no phone form. This is stated in the spec's limits.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local, a stated limit. The key lives in each machine's `config.json`, and sessions are local processes. Each machine notices and reports its own key and the operator restores each. `state/claude-key-health.json` is not replicated. Key-only installs today are single-machine.

---

## 8. Rollback cost

Revert the PR, or set either off switch; both are read live. Config is not migrated. Leftovers are an unused state file and a CLAUDE.md note.

---

## Conclusion

Safe to ship. The behaviour change for key agents is the fix itself. The live proof on nimbus is still required before calling it done.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer agent, four passes over the code diff
**Concurred:** yes, after the fixes listed below

Independent reviewer, on the code diff. Found no credential leak and nine defects: a replaced key could be paged about, a restored key could go unprobed after a long outage, the refresh loop was not re-entrant, the confirm delay could be bypassed, a removed key was ignored, the off switch and base URL missed three entry points, env files stayed after a failed launch, late-bound Telegram topics were missed, and background promises had no catch. All nine fixed with tests. A second read found three more: the stated restart bound was inaccurate, recovery could still act after the key was removed, and the lifeline read its off switch from a frozen copy. All three fixed. A third read found the Slack respawner renames a session, so the once-per-key record missed it; fixed. The fourth read concurred.

---

## Evidence pointers

`tests/unit/ClaudeKeyHealth.test.ts`, `tests/unit/claudeChildAuth.test.ts`, `tests/unit/ClaudeCliIntelligenceProvider-key.test.ts`, `tests/unit/claude-spawn-auth-class.test.ts`, `tests/integration/claude-key-health-route.test.ts`, `tests/e2e/claude-key-alive.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`**: `unbounded-self-action`
- **`closure`**: `guard`
- **Citation**: `tests/unit/self-action-convergence.test.ts` (controller `claude-key-session-refresh`)
- **Enforcement**: `ratchet`
- **How caught**: `decideKeyRefresh` caps a session at 3 attempts, then it leaves the pending list and is reported. Nothing re-adds it within the episode, and a session already moved onto this key is skipped, so the count settles. Dead-key probes back off to a 1-hour ceiling and stop after 24 hours.

The separate class this change closes, a server-side child that needs a credential but inherits only the server's own env, is held by `tests/unit/claude-spawn-auth-class.test.ts`.
