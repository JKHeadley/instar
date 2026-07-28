# Side-Effects Review - Reaper live-activity idle detection

**Version / slug:** `reaper-live-activity-idle`
**Date:** `2026-06-07`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

`SessionReaper.isPositivelyIdle` used `sig.toolCallOrSpinner` to decide "is this session active?", but that regex matches tool-call names (Read(/Write(/Bash(/…) and the bare word "claude" — both of which PERSIST in an idle session's 200-line scrollback. So every idle Claude session read as active → never positively idle → reaper kept everything (0 reaps in 9.5h live; the residual blocker after #961 made transcripts resolve). Adds a `liveActivity` regex to `FrameworkActivitySignal` (live-generation-only: spinner glyphs + "Working (Ns" + "generating") and uses it in `isPositivelyIdle`; removes the bare `claude|` from the Claude `toolCallOrSpinner` (the documented codex "do not match bare 'codex'" lesson).

## Decision-point inventory

- `FrameworkActivitySignal.liveActivity` (new field) on all 4 signals (claude/codex/gemini/pi) — live-only markers.
- `SessionReaper.isPositivelyIdle`: active-check now `sig.liveActivity || sig.escapeToInterrupt || sig.runningIndicator` (was `sig.toolCallOrSpinner || …`).
- `CLAUDE_CODE_SIGNAL.toolCallOrSpinner`: bare `claude|` removed (tool-names + spinner retained).

## 1. Behavior change / gating

This makes `isPositivelyIdle` correctly recognize idle sessions; it does not change any other gate. The only behavioral effect: the reaper can now reach reap-eligibility for genuinely-idle sessions (it previously could not). Removing bare "claude" from toolCallOrSpinner also makes OTHER consumers (silence/presence sentinels) stop mis-reading idle Claude sessions as working — strictly more correct, matching the existing codex behavior. No API/route/state change.

## 2. Over/under-signal

Direction of risk: a session genuinely working but whose captured frame momentarily shows no live marker (between tool calls) could read idle. Mitigations: (a) transcript-growth fires first and KEEPS anything whose JSONL is growing — a working session is growing its transcript; (b) confirmObservations (3 ticks / render-stasis) requires sustained idle; (c) 8h-silence + the full guard chain still apply. So a momentary live-marker miss cannot produce a wrong reap. UNDER-signal (the prior "never recognizes idle") is the bug being fixed. `liveActivity` deliberately keeps every genuine live marker per framework (spinner always; +Working-status for codex; +generating/thinking for gemini/pi).

## 3. Blast radius

Pure regex/classifier logic in the shared signal module + one call-site in the reaper. No I/O, no new deps, no persistent state, no migration. Other consumers of `toolCallOrSpinner` are unaffected except they no longer match the bare word "claude" (a correctness improvement, not a regression — no test depended on it; 57 unit tests incl. the framework-signal suite pass).

## 4. Failure modes

`liveActivity` is a required field with a concrete regex on every signal (tsc-enforced — a missing one is a compile error). A malformed frame is just text the regexes test against; no throw path. The reaper's downstream stateful checks (transcript-growth, positive-idle prompt match, confirmObservations) all still run after this gate.

## 5. Migration parity

No agent-installed file changes; internal classifier logic shipped in code, effective on next server start. No config surface. The reaper remains opt-in + dry-run-first, so nothing changes for an operator until they enable it.

## 6. Scope honesty (what this is NOT)

- Final functional fix in the chain (#952 → #955 → #958 → #961 → this). With it the reaper can distinguish idle from working and actually reclaim; validated by dry-run before any live flip.
- Does NOT touch the gemini/codex/pi live-marker sets beyond adding the live-only subset (codex/gemini/pi toolCallOrSpinner were already largely live-only or carefully tuned; only Claude carried the bare-word + tool-name-in-idle bug at the reaper call-site).
- Does NOT address the transcript pile-up (151k files / 5.9 GB) — separate retention follow-up.

## 7. Causal autopsy

Origin: **latent**. The reaper's idle-check has used the scrollback-matching `toolCallOrSpinner` (incl. bare "claude") since `isPositivelyIdle` was written — always wrong for the "is it active NOW" question, but never hit because the earlier KEEP-guards short-circuited before the positive-idle check ran. The 2026-06-07 #955/#958/#961 chain peeled those layers (and #961 made transcripts resolve), so the reaper finally REACHED the positive-idle check and the latent bug surfaced as 0 reaps / universal `no-positive-idle`. No prior PR regressed it; it is the deepest layer of the same conservatism stack. The bare-"claude" half is the exact analogue of the already-fixed codex bare-word bug.
