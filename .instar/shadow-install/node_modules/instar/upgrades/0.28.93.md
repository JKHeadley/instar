# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

### Project-scope Phase 1b PR 1 — the drift checker

The first signal-producing piece of the project-scope feature lands in
this release. `ProjectDriftChecker` is a hardened, prompt-injection-aware
class that takes a spec + the files it claims to depend on and asks the
agent's intelligence provider whether the spec's premises still match
what's on disk. It returns one of four verdicts:

- `no-drift` — every premise still holds.
- `minor-drift` — naming or structural shift but the spec is still
  implementable as written.
- `premise-violated` — load-bearing premise no longer holds; spec needs
  revision before build.
- `manual-review-required` — the checker can't trust its own answer
  (over-budget, missing files, timeout, schema fail, fabricated
  citations). Routes to user attention instead of soft-passing.

Hardening matches PROJECT-SCOPE-SPEC § Phase 1.4: path-jailed file
reads, content wrapped in `<UNTRUSTED_SPEC_BODY>` and
`<UNTRUSTED_FILE_CONTENT>` delimiters that the system prompt explicitly
distrusts, structured-JSON output validated against an enum schema,
and — critically — every LLM-claimed citation is re-verified against
the bytes on disk before display. If the model fabricates evidence,
the verdict is downgraded; the digest never shows model-claimed text.

The drift checker is a **signal source**, not authority. Nothing calls
it yet — the round-runner (next PR) is the first consumer, and the
round-runner combines the drift signal with deterministic artifact
checks (`gh pr view`, CI status, frontmatter re-validation) before
deciding to start a round.

### Server supervisor — no more git-credential restart loop

Fixed a defect where the supervisor would enter an infinite restart
loop if its startup git operations (auto-pull, git-sync) hit a
credential problem. The supervisor sets `GIT_ASKPASS=/usr/bin/false`
to prevent interactive prompts, but when that failed git was falling
through to a terminal prompt — which hangs the bash command behind
"Username for 'https://github.com':" forever. The fix passes
`GIT_TERMINAL_PROMPT=0` to the tmux session env (`-e` flag on
`new-session`), which is the only path that survives an existing
tmux server.

Discovered on the author's running agent during Phase 1a gate
verification — the server had been restart-looping for several hours
silently behind a degradation note.

### Stuck Telegram messages — persistent recovery sentinel

The v0.28.92 multi-shot `verifyInjection` (Enter at 500/1500/3500/6500ms after every injection) closed the in-process race, but it stands on the in-process timer. When the server process dies inside the 6.5-second recovery window — crash, OOM, lifeline-forced restart — every armed timer dies with it, and any message injected just before the crash sits at the `❯` prompt indefinitely. The 2026-05-11 reproduction was exactly this shape: a 30+ minute server restart loop driven by a better-sqlite3 ABI rebuild failure left three of echo's sessions with messages from the user that never submitted. The in-process recovery had fired and was lost when the server crashed before its own timer could finish.

This release adds `StuckInputSentinel` — a persistent, restart-resilient backstop. It runs as a long-lived `setInterval` on the server, scans every running tmux session every 10 seconds, and decides per session: is the `❯` prompt holding text? Has it held that exact text across two ticks (≈20s) without changing? Is the pane idle (no `esc to interrupt` / `ctrl+t to hide tasks` footer hint)? If all three: fire the same escalating recovery the in-process path uses (Enter, Enter, C-m, Enter+sleep+Enter), bounded at four attempts per stuck event, then mark the record exhausted until the prompt text changes.

The "is idle" check intentionally keys ONLY on the footer activity hints, NOT on line-start spinner glyphs (`✻ ✶`). Past-tense markers like `✻ Brewed for 14m 11s` and `✻ Churned for 1m 16s` persist as visible pane content long after the turn finished; keying on them would silently exclude exactly the cases this sentinel is meant to recover. Live reproduction on echo's 2026-05-11 stuck sessions confirmed both held a stale Brewed/Churned line.

The sentinel is decoupled from injection time — it observes panes purely from `tmux capture-pane`, not from any injection event. A server restart simply starts the sentinel fresh and it picks up any still-stuck session on its next tick. The in-process `verifyInjection` still owns the fast path (≤6.5s); the sentinel only fires past that window, so the two never race on the same event.

Each fire writes one row to `<stateDir>/stuck-input-events.jsonl` (`{ts, session, promptText, attempt, action, outcome}`) for operator audit and `DegradationReporter` consumption.

## What to Tell Your User

- **Drift detection is here**: I can now check whether a spec I wrote
  for you a week ago still matches what we built. If the code drifted
  out from under the spec, I'll notice and tell you before I start
  building. If anything looks fishy in the check itself, I escalate
  it to you instead of pretending everything is fine.

- **Server stability is better**: I fixed a problem where, if my
  credential cache went stale, my server could get stuck restarting
  itself in a loop. You wouldn't have noticed unless you were
  watching the logs, but now it can't happen.

- **Stuck Telegram messages survive my server crashing**: The retry I shipped recently runs entirely in memory, so if my server crashes inside the 6.5 seconds after your message lands, the retry dies with it. Your message stays sitting at my prompt with no recovery attempt — exactly the pattern you saw on May 11 during my restart loop. I now run a second watcher that's not tied to any one message. Every 10 seconds it looks at every Claude Code window I have open: is there text waiting at my prompt that hasn't moved AND I'm not in the middle of doing something? If yes, it presses Enter for me. This watcher restarts cleanly with the server, so a crash in the recovery window stops being a permanent stuck-message anymore — worst case I recover ~20 seconds after the server is back up. Same Enter→Enter→C-m→double-Enter escalation as before, capped at four attempts so I can't loop forever.

## Summary of New Capabilities

- `ProjectDriftChecker` class — signal-only drift detection for
  project-scope rounds. Hardened against prompt injection and
  evidence fabrication. Returns `DriftVerdict` (no-drift /
  minor-drift / premise-violated / manual-review-required). Not
  user-callable yet — consumed by the round-runner in the next PR.
- `DriftVerdict` / `VerifiedCitation` types exported from
  `src/core/types.ts`.
- `IntelligenceOptions.timeoutMs` — additive option that providers
  may ignore; the drift checker enforces externally regardless.
- Server supervisor now passes `GIT_TERMINAL_PROMPT=0` to the tmux
  session env on every server spawn, preventing the credential-prompt
  restart loop.
- `StuckInputSentinel` — persistent, restart-resilient stuck-input
  recovery across all Claude Code tmux sessions. Ticks every 10s
  alongside `SessionManager.startMonitoring()`. Per-fire audit at
  `<stateDir>/stuck-input-events.jsonl`.

## Evidence

**Live reproduction (sentinel).** From echo's tmux sessions on 2026-05-11:
- `echo-exploring-slack-integration` had `❯ start the rewrite now`
- `echo-qalatra` had `❯ yes, that was the stuck-input bug`
- `echo-threadline-dev` had `❯ fix the orphan-commitment bug`

None of these messages reached the Claude Code transcripts (`grep -l "start the rewrite now" ~/.claude/projects/-Users-justin--instar-agents-echo/*.jsonl` returns empty). The server log shows a continuous restart cycle driven by the supervisor preflight's better-sqlite3 rebuild failing on Node v25.6.1 — every in-process `verifyInjection` timer that armed during this window died before its 6.5s schedule could complete.

**Verified after.**

- `tests/unit/StuckInputSentinel.test.ts` — 21 new tests covering:
  - `extractPromptText`: returns text after the last ❯, returns null on empty prompt, handles wrapped multi-line content, ignores box-drawing separator lines
  - `isPaneActivelyWorking`: detects footer activity hints (`esc to interrupt`, `ctrl+t to hide tasks`); does NOT flag stale `✻ Brewed for…` or `✻ Churned for…` past-tense markers as working (verified live-repro case); does NOT flag a present-tense `✶ Running…` line without a footer hint either
  - tick lifecycle: no-fire on first observation, first fire on second consecutive observation (minTicksBeforeFire=2), escalation across ticks (Enter→Enter→C-m→Enter-sleep-Enter), bounded at maxAttempts, refuses to fire while working, resets state on prompt change, drops record on prompt clear, GCs dead sessions, tracks multiple sessions independently
  - lifecycle hygiene: start/stop are idempotent, no throws
  - `actionForAttempt` matches `SessionManager.fireStuckInputRecovery` escalation exactly

- Regression coverage green: `tests/unit/session-multishot-recovery.test.ts` (12), `tests/unit/session-injection-verify.test.ts` (10), `tests/unit/SessionManager-injection.test.ts` (6) — 28 tests covering the in-process recovery path the sentinel composes with.

- Type-check: `tsc --noEmit -p .` clean across all 2000+ source files.

- Side-effects review: `upgrades/side-effects/stuck-input-sentinel.md` (signal-vs-authority compliance verified — no blocking surface; second-pass review on sentinel terminology and session-lifecycle interactions, with the spinner-glyph trade-off resolved before commit based on live evidence).
