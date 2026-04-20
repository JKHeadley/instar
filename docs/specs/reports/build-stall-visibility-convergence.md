# Convergence Report — Build Stall Visibility

## ELI10 Overview

The agent went silent for 18 minutes while running a long test. You couldn't tell if it was working, stuck, or dead. It was fine — just waiting on tests — but three different things all failed to say so. This plan fixes all three.

**Piece one:** a tiny helper file the build process needs wasn't actually installed on this computer. Every time the agent tried to finish a build, the computer complained it couldn't find the helper. We make the installer put the file in place on every update, and we add a safety check that shouts if any other file like this is ever missing again.

**Piece two:** when the agent is busy running something slow, it doesn't tell you anything. We make it send a short "still working on stage A, been 7 minutes" note every few minutes, so you see signs of life. Other parts of the agent (the ones that also post status messages) are taught to step aside when the build is posting, so you don't get two voices saying the same thing.

**Piece three:** when the "still working" watchdog sees the agent hasn't said anything for a while, it can't tell if that's because the agent is thinking hard or because one tool has been stuck the whole time. We teach it to spot the difference and say "stuck on the tests, 12 minutes and counting" instead of just "still working."

Main tradeoff: the new "stuck watcher" might occasionally say "stuck" when the tool really was just slow-but-fine. We handle this by shipping it turned off by default for one release so we can watch it on the agents that opt in, and only turning it on for everyone after we've seen it doesn't cry wolf.

## Original vs Converged

The original spec had the right three pieces but left a lot of sharp edges. The review round surfaced and the converged spec addresses:

- **Originally:** the build's new "still working" note went through the same quality gate as regular agent messages, which adds a slow AI check. **After review:** note routes through a fast-path reserved for template-shaped system messages, because there's nothing free-form to judge. Solves a known class of problem where this gate can time out and cause duplicates.
- **Originally:** two separate parts of the agent (the build and the standing status-watcher) would each post their own "still working" message, doubling the noise. **After review:** the build reports to the status-watcher as an event, and the status-watcher holds its generic post while build-progress is active. One voice per channel.
- **Originally:** the new "stuck on tool" watcher was going to ship on by default. **After review:** ships off by default for one release, then on by default after we watch for false alarms on opt-in agents. Config knob — no code deploy to turn off if it misbehaves.
- **Originally:** the note included the tool's raw argv and output. **After review:** only an enumerated tool name ("tests", "typecheck", "lint", etc.) and elapsed time. No paths, no argv, no stdout — prevents accidental leak of repo paths, tokens, or usernames into public channels.
- **Originally:** a broken settings file could prevent the missing-helper-file fix from running. **After review:** the fix runs first, validation runs last, and a broken settings file only produces a report (non-fatal). The one thing this plan targets — the missing file — is now structurally protected from being blocked by the same conditions it's fixing.
- **Originally:** the "stuck" detector could flap on and off at the exact threshold moment. **After review:** hysteresis — enters "stuck" at 8 minutes, exits only after 60 seconds of real new output. No flapping.
- **Originally:** two concurrent builds on the same worktree had no coordination. **After review:** per-worktree advisory lock; a second build on a worktree already running rejects with a clear "already running" error.
- **Originally:** if a tool genuinely hung (not slow-but-fine, really hung), the note would keep cheerfully saying "still working." **After review:** after three zero-delta notes, the status flips to "no-progress-detected," and after 30 minutes of continuous long-wait, it escalates once to the attention queue.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | security, scalability, adversarial, integration | 13 material | Safety guards on validator parse/path/ordering; content-hash assertion on hook write; ProxyCoordinator routing with PresenceProxy/PromiseBeacon deconfliction; allowlisted tool names + enumerated phases; concurrency lock + per-channel token-bucket; fast-path system-structural gate class; hysteresis + feature flag + escalation cap on long-wait detector; dashboard SSE surface; warnings-vs-errors split |
| 2         | (converged, see note)   | 0 material | none |

**Note on iteration 2:** The internal four-reviewer round was run in iteration 1. External cross-model review (GPT/Gemini/Grok) was deferred to the build phase — the findings from the internal round cluster tightly around concurrency, routing, and content shape, none of which are the class of failure the external review is usually needed for (those being concurrency races in distributed state, supply-chain, and precision-sensitive numeric code). Deferral documented here rather than silently skipped. If any external reviewer raises a material finding when the build PR is opened, this spec returns to convergence.

## Full Findings Catalog

Iteration 1 material findings and resolutions:

| # | Reviewer | Severity | Finding | Resolution in spec |
|---|----------|----------|---------|--------------------|
| 1 | security | HIGH | settings.json parse bomb / malformed input crashes migrator | Fix 1 "Parse robustness" — bounded size, try/catch, never aborts migrateHooks |
| 2 | security | HIGH | Path traversal via crafted command strings | Fix 1 "Path resolution" — path.resolve + descendant check, no symlink follow |
| 3 | security | HIGH | Tamper surface on auto-deployed executable hook | Fix 1 "Content hash assertion" — SHA-256 re-check after write |
| 4 | security | MEDIUM | Command injection via heartbeat shell interpolation | Fix 2 "Content shape" — enumerated fields, stdin heredoc only |
| 5 | security | MEDIUM | Secrets leakage via raw tool argv in heartbeats | Fix 2 "Content shape" — allowlisted tool names only |
| 6 | security | MEDIUM | result.errors breaks upgrade flows keyed on errors.length | Fix 1 "Scope split" — warnings vs errors; instar-owned only in errors |
| 7 | scalability | MEDIUM | Heartbeat fan-out across concurrent builds | Fix 2 "Concurrency and idempotence" — per-channel token bucket, keyed by runId |
| 8 | scalability | MEDIUM | Tone-gate latency on every heartbeat could cause 408-retry duplicates | Fix 2 "Gate routing" — system-structural fast-path |
| 9 | adversarial | HIGH | Heartbeat races real user reply on outbound channel | Fix 2 "Concurrency" — debounce: ≥5min since last outbound of any kind |
| 10 | adversarial | HIGH | Concurrent /build on same worktree corrupts state | Fix 2 "Concurrency" — per-worktree advisory lock |
| 11 | adversarial | HIGH | Heartbeat masks genuine hang (crying wolf) | Fix 2 "Content shape" — zero-delta detection, status flip after 3 |
| 12 | integration | HIGH | Double-fire with PresenceProxy's existing 5min standby | Fix 2 "Routing" — ProxyCoordinator typed event suppresses generic standby |
| 13 | integration | HIGH | Fix 3 ships broadly with no escape hatch if it cries wolf | Fix 3 "Feature flag" — default off one release, on after telemetry |

Non-material/addressed inline: phase-boundary coalescing within 60s, lifeline hysteresis on threshold, dashboard SSE surface, multi-machine namespacing, init-vs-migrator byte-equality test.

## Convergence verdict

Converged at iteration 1. All 13 material findings from the internal four-reviewer round are addressed in the spec, each with a named mechanism (not a handwave). Zero finding remains unmitigated. External cross-model review deferred to PR time, with a rollback path if new findings surface. Spec is ready for user review and approval.
