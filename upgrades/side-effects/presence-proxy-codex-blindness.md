# Side-effects review — PresenceProxy Codex-blindness fix

**Change:** Two new framework-aware pure functions in `PresenceProxy.ts`
(`detectSessionFinished`, `deterministicStallAssessment`) replacing two
hardcoded-Claude detection paths; `agentFramework` added to `PresenceProxyConfig`
and wired from `_defaultFramework` at server boot.

## Over-block risk (false "finished" / false "stalled")
- **Finished-detection:** A false "finished" on Codex (`!looksActivelyWorking`
  + zero child processes) only *suppresses* standby heartbeats. The real reply
  path is independent of PresenceProxy — if the session is actually still
  working, the user still receives the eventual answer. Worst case is a missing
  "still working" nudge, which is the lesser harm and aligns with the
  near-silent-notifications standard. The `processes.length === 0` guard is
  unchanged and remains the authoritative second condition.
- **Stall-assessment:** A false "stalled" only fires when (a) session alive,
  (b) no active processes, (c) not long-running, (d) the LLM call failed OR
  returned an unparseable class, AND (e) the pane shows no active-work signal.
  That is precisely the population that *should* surface to the user. The user
  message is a soft "appears stuck — reply unstick/restart", not a kill.

## Under-block risk (missed stuck session)
- This is the bug being fixed. Previously a stuck Codex session was invisible
  forever (finished-check never fired → flood; LLM-fail fallback → "working"
  forever). Both now resolve to a user-visible state.

## Level-of-abstraction fit
- Pure functions live beside the existing `detectSessionIdle` (same module,
  same idiom, directly unit-testable) rather than buried in the tier methods.
- Framework is threaded as data (`agentFramework`), not branched on a global —
  same pattern the committed activity-signal fix used in `sentinelWiring`.

## Signal-vs-authority
- `looksActivelyWorking` is a deterministic structural detector (signal). The
  LLM tier-3 assessment remains the primary authority; the deterministic signal
  is only the *fallback* when that authority is unavailable. We are not letting
  a brittle filter gain blocking authority — we are giving the fallback a
  grounded default instead of a blind one.

## Interactions
- **Claude path:** `detectSessionFinished` keeps `detectSessionIdle` for
  claude-code and absent-framework (back-compat, asserted in tests).
  `deterministicStallAssessment` DOES change the Claude LLM-fail fallback from
  "working" to deterministic — intentional hardening, since "working forever"
  was itself the silently-stopped failure mode. `looksActivelyWorking` is the
  same detector ActiveWorkSilenceSentinel already trusts for Claude.
- **StallTriageNurse / silence sentinel:** unaffected — they consume the
  activity signal directly; this change is local to PresenceProxy tiers.
- **Build-heartbeat suppression / quota / context-exhaustion:** earlier in the
  tier flow, unchanged; their tests pass.

## Rollback cost
- Low. Revert the two function additions + four call-site edits + the one
  config-field wiring. No state-file or schema changes, no migration. Behavior
  returns to the prior Claude-only detection.

## Test evidence
- `presence-proxy-codex-blindness.test.ts` (10) — both functions, both
  frameworks, both sides of each boundary, plus the regression lock that
  `detectSessionIdle` alone missed the Codex idle pane.
- 86 existing presence-proxy unit tests pass. tsc clean. Build emits both fns.
- **Live verification (pending):** deploy to codey, confirm heartbeats stop
  after a Codex session finishes (no post-idle flood) on the real Telegram path.
