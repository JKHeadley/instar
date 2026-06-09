<!-- bump: patch -->

## What Changed

Extends the `deferral-detector` hook (the signal-only PreToolUse guard that scans outbound messages) with a fourth category: **time/fatigue-based deferral**. It now flags framing that defers or winds down work because of the *hour* or to "avoid rushing" rather than a real constraint — "rather than rush at the tail of the night", "it's late", "wrap up", "do it tomorrow", "defer it to next session". Two design points: (1) these patterns are **deliberately NOT exempted by the infrastructure-backed anti-trigger** — having tracked the work as a commitment/PR does not legitimize "I'll do it rather than rush at the end of the night"; it just launders the deferral; (2) the injected checklist tells the agent to **quote the actual injected CURRENT TIME** (which is provided every turn) instead of a vibe word like "tonight", and states plainly that time-of-day is never a valid reason to defer. Source-of-truth is `getDeferralDetectorHook()` in PostUpdateMigrator.ts (the existing always-overwrite migration redeploys it to every agent on update). Still SIGNAL ONLY — never blocks.

## What to Tell Your User

If I ever start deferring real work with "it's late / let's not rush / I'll pick this up next session" — even when I've "tracked" it — there's now a structural guard that catches that framing before the message sends and forces me to check the actual clock and decide instead of winding down. This came directly from your correction that there's no such thing as "rushing at the tail of the night," and that the fix had to be in code, not willpower.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Deferral-detector flags time/fatigue-based deferral framing | automatic (signal-only hook); fires on outbound messages, not exempted by "tracked" work |

## Evidence

Reproduction (live, 2026-06-09): at **3:41 PM** the agent deferred a doable fix to "the next session, rather than rush at the tail of tonight." The existing deferral-detector did not catch it — it had no time/fatigue patterns, and its infrastructure-backed exemption suppressed the orphan-follow-up check *because* the work had been tracked as a commitment (CMT-1246), laundering the deferral.

After the fix: `tests/unit/deferral-detector-orphan-todo.test.ts` gains a `time/fatigue` describe block (9 cases) including the exact incident phrasing and the key "tracked work still fires" laundering case; the deployed hook was verified end-to-end to emit `TIME/FATIGUE DEFERRAL DETECTED` (`Detected: tail_of_period, avoid_rushing`) while correctly suppressing the orphan section on infra-backed input. 25/25 deferral-detector tests pass; migration-parity + pretooluse-parity + upgrade-guide (3964) tests green; tsc + lint clean.
