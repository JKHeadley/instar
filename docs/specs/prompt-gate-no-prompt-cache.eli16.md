# PromptGate NO_PROMPT Cache — ELI16 overview

## The short version

Every instar agent quietly watches its own terminal output to notice when Claude Code is stuck waiting for the user to answer a yes/no question. Most of that watching is done by simple text-matching rules that look for the obvious shapes (a "y/n" prompt, a numbered "1. Yes 2. No" menu, an "Esc to cancel" footer). When those rules can't tell, the watcher asks a small LLM (Haiku) to make the final call. That LLM call is what got expensive.

The problem: when a session is sitting idle, the agent's terminal shows the same `❯` prompt forever. The watcher was supposed to stop asking the LLM the same question over and over, but the part that stopped it was wired wrong — it only kicked in *after* the LLM said "yes, this is a real prompt," not after the LLM said "no, nothing's stuck." So idle sessions kept asking the LLM "is this stuck?" every 5 seconds, got "no" every time, and burned tokens forever.

On 2026-05-15 that one bug accounted for ~108,000 LLM calls and ~3 billion tokens in a single day across all agents on this machine — more than the rest of the machine's usage combined.

## What this change does

It adds a small "I already asked about this" notepad to each session's watcher. Every time the LLM says "no, this output is not a real prompt," the watcher writes down a fingerprint of that exact terminal output. Next time the same output shows up (which on an idle session is constantly), the watcher checks the notepad first: if the fingerprint is there, skip the LLM entirely and trust the prior answer.

The notepad has a cap of 32 fingerprints per session and uses oldest-first eviction, so it can't grow unbounded. The notepad is also wiped clean whenever the session receives any input (so post-input output is freshly checked) and whenever the session is cleaned up (so dead sessions don't leave stale entries).

## Why it's safe

The LLM is still the boss of every real decision. The notepad just records what the LLM already said. If the session shows new terminal output (anything different at all), the fingerprint won't match, the notepad is bypassed, and the LLM gets asked normally. There's no scenario where a real prompt gets missed because of the cache — a real prompt produces different output, which produces a different fingerprint, which misses the cache, which falls through to the LLM.

The worst-case failure mode would be: the LLM made a *wrong* "no, nothing's stuck" call on a specific output, that same exact output recurs, and the wrong answer gets reused for up to 32 cycles before being evicted. That's bounded, and the alternative (without the cache) was paying to repeatedly get the same wrong answer at full price.

## Why this matters

This is structural. Every agent that runs instar inherits this watcher. Without the cache, every agent on every machine burns tokens at this rate around the clock. With the cache, idle agents are nearly free — the LLM gets consulted only when the terminal output actually changes, which on a quiet session is a small number of times per hour rather than ~720.

## What you'd see if it goes wrong

A prompt that should have been forwarded to the user via Telegram either doesn't get forwarded (cache locked in a wrong "no, nothing's stuck" verdict) or gets forwarded later than expected. The rollback is a two-file revert. No data is stored anywhere — the cache is purely in-memory and disappears when the agent restarts. Nothing else changes about the rest of instar.

## How we know it works

The fix ships with nine regression tests that prove: idle sessions stop re-asking the LLM, different output still triggers a fresh LLM call, the cache clears on input and cleanup, the cache size is bounded, real prompts are still detected on first sight, mid-flight LLM answers don't repopulate a just-cleared cache, and ambiguous LLM responses aren't memoized. All 42 prompt-gate tests pass.
