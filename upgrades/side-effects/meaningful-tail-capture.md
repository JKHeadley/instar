# Side-Effects Review — blank-fill-immune meaningful-tail capture (task #77)

**Version / slug:** `meaningful-tail-capture`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `self-review under the Tier-1 lite lane; direction-of-failure analysis below addresses the reaper-proximity risk signal explicitly`

## Summary of the change

Generalizes PR #818's blank-fill fix beyond PromptGate: `trimTrailingBlankRows` moves to a shared `src/core/paneText.ts` (PromptGate now imports it — zero behavior change there, drift-proofing only), and `SessionManager` gains `captureMeaningfulTail(session, n)` (capture `max(4n, 50)` physical rows → trim trailing blanks → last n meaningful rows). The two n=5 small-tail consumers migrate: the over-age activity gate and the idle-at-prompt check.

## Decision-point inventory

- `core/paneText.ts` — add — shared trim + meaningfulTail (PromptGate's exact semantics: interior blanks preserved, all-blank → `['']`/`''`).
- `PromptGate` — modified — local helper replaced by the shared import; behavior identical (its full 33-test suite passes unchanged, including #818's both-pane-shape regressions).
- `SessionManager.captureMeaningfulTail` — add — wider-capture + meaningful-tail windowing over the existing `captureOutput` transport.
- Age-gate check (`captureOutput(.., 5)` → `captureMeaningfulTail(.., 5)`) — modified.
- Idle-at-prompt check (same substitution) — modified.

## 1. Direction-of-failure analysis (the reaper-proximity question)

Both migrated checks decide "is this session idle?" from BOTH a text signal AND a process signal (`hasActiveProcesses`). This change fixes only the TEXT signal:

- **Pre-fix failure:** tall-pane idle sessions read blank → NOT idle-at-prompt → counted ACTIVE forever. Consequence: never idle-reaped, inflated active-session counts, deferred update restarts (#20/#47 family). Silent, unbounded.
- **Post-fix new behavior:** those sessions now correctly read idle → the EXISTING idle pipeline applies (idle threshold, then action). A genuinely-working session still cannot be killed by this change: working sessions have child processes, and `hasActiveProcesses` must ALSO be false for idle/age action. The process-level safety net is untouched.
- **Worst NEW case:** a session that is text-idle AND process-idle in a tall pane gets reaped per the normal idle policy where it previously leaked forever — that is the intended fix, not a regression.

## 2. Over-permit

None — no detection pattern, threshold, or action changed; only the rows the patterns can see.

## 3. Scope deliberately NOT taken

The 15/30/50-row consumers (paste-retry, error-nudge, PromptGate feed, watchdog reads) are less blank-fill-vulnerable (wider windows) and PromptGate now trims internally; migrating them is a follow-up candidate, noted here so the bound is explicit, tracked under task #77's close-out.

## 4. Migration parity

None — src-internal; no config/hooks/skills.

## 5. Token/cost impact

None. One slightly larger tmux capture (≤50 rows vs 5) per idle poll per session — microseconds, local.

## 6. Rollback

Revert the commit. PromptGate regains nothing to lose (shared helper is semantics-identical); idle checks return to the physical-tail behavior (the silent leak).
