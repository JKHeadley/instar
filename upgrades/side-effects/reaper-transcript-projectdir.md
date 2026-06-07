# Side-Effects Review - Reaper transcript-resolution fix (projectDir)

**Version / slug:** `reaper-transcript-projectdir`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

The SessionReaper transcript probe (and the StaleSessionBackstop probe) were called with `projectDir: ''`, so `resolveFrameworkTranscriptPath` built `~/.claude/projects//<sessionId>.jsonl` — an empty-encoded dir that never exists → every transcript read as `resolved:false` → keptBy `transcript-unresolved` for EVERY session → the reaper could never prove a session idle (kept everything). Fix: pass the agent's session-launch cwd (`config.projectDir`), which Claude Code encodes into the transcript path. Adds a `transcriptProjectDir?: () => string` dep to `SessionReaperDeps` (wired to `config.projectDir` in server.ts) used by the fallback `probe()`; fixes the StaleSessionBackstop probe to use `config.projectDir` directly.

## Decision-point inventory

- `SessionReaper.probe()` fallback: `projectDir` now `this.deps.transcriptProjectDir?.() ?? ''` (was `''`).
- `SessionReaperDeps.transcriptProjectDir?` (new, optional) — wired in server.ts to `() => config.projectDir`.
- `server.ts` StaleSessionBackstop `snapshot()`: `projectDir: config.projectDir` (was `''`).

## 1. Behavior change / gating

No gate/flow change. This only lets the reaper RESOLVE the transcript so its existing idle-proof (transcript-growth + positive-idle) can run. It changes the reaper from "structurally unable to verify idle (keeps all)" to "can verify idle." The reaper is opt-in + dry-run-first; nothing it kills changes without an operator enabling it, and the safe default (unresolved → KEEP) is preserved whenever projectDir is absent/wrong.

## 2. Over/under-signal

The risk is UNDER-keeping (reaping something it shouldn't) only if the WRONG projectDir resolved to a DIFFERENT session's transcript — impossible, because the path also includes the unique `<claudeSessionId>` filename; a wrong projectDir yields a non-existent path → unresolved → KEEP. So the change can only resolve the correct transcript or fail safe. Prior UNDER-signal (never reaps) is the bug being fixed.

## 3. Blast radius

Two probe call-sites; reuses the existing `resolveFrameworkTranscriptPath`. No new I/O beyond the stat that was already attempted (just at the right path now). No API route, no persistent state, no migration. `transcriptProjectDir` is optional → absent in any caller that doesn't wire it → '' → unresolved → KEEP (old safe behavior).

## 4. Failure modes

A wrong/empty projectDir → non-existent path → `resolved:false` → `transcript-unresolved` → KEEP (the conservative default, never reap). `probeTranscript` already swallows stat errors to `resolved:false`. The dep is optional so existing constructions (and the unit harness) compile and run unchanged.

## 5. Migration parity

No agent-installed file changes; internal reaper wiring. The dep is wired in server.ts at construction from the already-present `config.projectDir` — every existing agent gets the corrected probe on its next server start, no `PostUpdateMigrator` entry needed. The reaper remains opt-in (enabled:false default) so behavior only changes for operators who enable it.

## 6. Scope honesty (what this is NOT)

- Keystone of the resource chain (#952 → #955 → #958 → this): WITHOUT this the reaper can never verify idle, so the prior three unblocks couldn't take effect. WITH it, the dry-run can finally show genuinely-idle sessions as reap-eligible.
- Does NOT address the transcript pile-up it surfaced (echo: 151,814 files / 5.9 GB across 132 project dirs) — that is a separate retention/pruning task, flagged for follow-up.
- Does NOT flip the reaper live — still dry-run on echo, validated by observation first.

## 7. Causal autopsy

Origin: **latent**. The `projectDir: ''` probe argument has been wrong since the probe was introduced — a standalone pre-existing bug, independent of any prior PR. It went unhit only because the reaper's earlier KEEP-guards (open-commitment, then active-process) short-circuited before the transcript check ever ran; the #955/#958 fixes peeled those layers and made the reaper REACH the transcript probe, which is when the latent `''` bug surfaced as the universal `transcript-unresolved`. The transcripts always existed at the correct (non-empty) path; the probe simply never pointed there.
