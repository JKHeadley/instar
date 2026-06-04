# The listSessions Hot-Loop — A Debugging Success Story & Its Lessons

*2026-06-03. A systemic agent-server CPU hot-loop that bouncing never fixed, pinned to a single function, fixed with a cache, proven live, and shipped — plus the deploy pipeline it unjammed on the way. This is the postmortem + the lessons, tactical and meta. It is the earned-from artifact behind the **Distrust Temporary Success** and **Friction Is a Spec** standards in `docs/STANDARDS-REGISTRY.md`.*

## The arc (what actually happened)

1. **Symptom:** Three agent servers (gemini, ai-guy, sagemind) each burning 50–67% CPU; machine load spiking to 66/16-cores; new sessions at risk of "spawn denied."
2. **The false fix:** Bouncing the hot servers dropped the load — for ~80 seconds. It always re-spiked. (Telling, in hindsight.)
3. **The blind tools:** macOS `sample`, lsof snapshots, `gh run --log` (0 bytes here), port-grep, log-diffing — all said "busy" but none could name the function. `sample` literally cannot symbolicate a node process's JS frames.
4. **The lens that worked:** `SIGUSR1` to the running node process opens its inspector; a CDP CPU profile over that inspector reports the exact JS stack. Result: **30% of CPU in `readFileUtf8`, under `StateManager.listSessions`.**
5. **The root:** `listSessions()` re-read + re-parsed *every* session file from disk on *every* call — and the reaper + sentinels call it each tick. O(sessions × pollers × tick-rate) disk reads.
6. **The fix:** a 1-second TTL cache, invalidated on every session write. (#728)
7. **The deploy wall:** #728 merged but wouldn't reach the agents — the release pipeline was jammed (a release-note fragment had inline code that the publish gate rejects). Fixed that too (#729).
8. **Proven live:** hot-patched the cache onto all three agents → 58→2%, 41→1.4%, 53→6%, holding flat 8+ minutes (vs the 80-second bounce). Load 26→11. v1.3.227 published.
9. **Productized:** the profiling technique became `instar dev:profile-node`. (#730)

## Tactical lessons

- **`sample` can't see JS; the node inspector can.** `kill -USR1 <pid>` → `127.0.0.1:9229/json/list` → a CDP CPU profile. This is now `instar dev:profile-node`.
- **A read on a hot path needs a cache.** `listSessions` re-reading the whole directory per tick was O(N×pollers×rate). A short-TTL, write-invalidated cache collapses it with no staleness for the callers that matter.
- **Verify swap + `memory_pressure`, not raw free %, before calling a memory crisis.** macOS caches aggressively; "7% free" was 50% real free with zero swap. The real tell is swap.
- **Ground process identity before any kill.** The "Chrome/Playwright leak" was the user's actual browser; a blind kill would have closed his tabs. `ps -o pid,ppid,command` first, always.
- **No inline code in an upgrade fragment's "What to Tell Your User."** It hard-jams the whole fleet release. (I made this exact mistake mid-run; the pre-push gate caught it.)
- **A coverage matcher keyed on file names misses colon-commands.** `devProfileNode.ts` ≠ `dev:profile-node`; match a normalized form.

## Higher-order / meta-level insights

**1. A system's own resilience hides its root cause.** Every bounce "worked" because the servers self-heal (respawn). The resilience that keeps things running is exactly what masked the rot and made a code-level bug look transient. *Distrust temporary success.* When a fix keeps working but the problem keeps returning, the system's resilience is hiding the root — that recurrence is the signal, not the noise. *(Crystallized as the **Distrust Temporary Success** standard.)*

**2. Symptom-reset feels like progress; encode "it doesn't count" into the goal, not your willpower.** The completion criterion for this run explicitly said *"a bounce that re-spikes within the hour does NOT count as done."* That one structural sentence is what kept the work honest and drove it to the real fix instead of stopping at the third bounce. Don't rely on remembering to distinguish a patch from a fix — bake the distinction into the definition of done.

**3. The biggest risk in incident response isn't slow diagnosis — it's confidently fixing the wrong thing.** Two near-misses (declaring a memory crisis from raw free %; "killing the Chrome leak" that was the user's browser) were both caught by *grounding before asserting.* Grounding costs seconds; a confident-wrong action costs trust and real damage. The user's own question — *"is it actually blocking us?"* — was the highest-leverage move of the whole episode, because it forced verification of the premise before acting on the urgency.

**4. When every observability tool is blind, the answer is a different modality, not a louder version of the same tool.** `sample`, lsof, grep, logs — all blind to the JS frame. The breakthrough wasn't trying harder with them; it was the process's *own introspection* (the inspector). When you're stuck, stop re-running the blind tools and ask what fundamentally-different vantage point can see what they can't.

**5. "Merged" ≠ "fixed in production." The delivery path is part of the fix.** #728 was correct and merged, and the machine was still on fire — because the deploy was independently broken (a jammed publish). The unit of "done" is the whole chain (code → review → release → deploy → verify-live), and any link can be the actual blocker. A fix you can't ship isn't a fix yet.

**6. Friction is a spec for tooling. Productize the workaround.** This run kept turning its own pain into permanent capability: `dev:ci-failures` (when `gh log` was empty), and now `dev:profile-node` (when `sample` was blind). A hard-won trick that lives only in a transcript is lost; as a command, it's compounding leverage for everyone after you. The meta-rule: *when a workaround saves the day, the next move is to make it a tool.* *(Crystallized as the **Friction Is a Spec** standard.)*

**7. The gates that "slowed me down" were the system working — Structure > Willpower, validated under fire.** The pre-push gate caught my inline-code mistake; the docs-coverage gate caught (and made me fix) a real matcher bug; the dangerous-command guard stopped a force-push until authorized. Each felt like friction in the moment and was, every time, correct. A well-designed gate doesn't trust the author to remember — and the author *did* forget, three times. That's not the gate being annoying; that's the gate being load-bearing.

**8. In a long autonomous run, trust is built by correcting yourself loudly, not by never being wrong.** I made two confidently-wrong claims and reversed both openly, with the data, the moment I had it. The reversals were trust-*building*, not trust-eroding — because the alternative (quietly papering over them) is how an autonomous agent becomes unsafe. Honesty about a mistake is cheaper than the mistake compounding.

**9. The cheapest 10x in debugging is the right vantage point, found early.** Hours went into blind tools; the answer took ~5 seconds once the inspector was pointed at the process. The lesson isn't "the inspector is magic" — it's *"spend your first effort on getting a vantage point that can actually see the answer, before grinding on ones that can't."* Diagnosis speed is dominated by visibility, not effort.

## The durable artifacts this produced

- **#728** — the fix (the cache), shipped in v1.3.227.
- **#729** — unjammed the release pipeline (task #42).
- **#730** — `instar dev:profile-node`, so the technique is one command forever.
- **The constitution amendment** — the **Distrust Temporary Success** and **Friction Is a Spec** standards in `docs/STANDARDS-REGISTRY.md`, with P14/P15 in `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`.
- This document — so the *reasoning* survives, not just the diffs.
