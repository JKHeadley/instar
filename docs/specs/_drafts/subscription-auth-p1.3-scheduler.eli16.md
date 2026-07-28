# P1.3 — Quota-Aware Auto-Swap Scheduler — Plain-English Overview

> The one-line version: when one of your subscription accounts runs out of room, I move the session to a fresh account and keep going — the conversation never dies on a quota limit.

## The problem in one breath

You have several Claude subscriptions. Today a single session is stuck on one account; when that account hits its quota, the session just gets throttled or dies. We want it to switch to another of your accounts and carry on, automatically — and to use each account fully before its quota resets, so nothing is wasted.

## What already exists (merged)

- **Account registry (P1.1)** — remembers each account by nickname and where it logs in (its config home), never its tokens.
- **Quota poller (P1.2)** — reads each account's live usage (how much is left, when it resets) and how fast it's burning.

## What this adds

A **scheduler** that uses that quota data to make two decisions:

1. **Which account to use** — it prefers the account with the most room left that resets soonest, so each account gets drained before its quota resets instead of leaving unused quota to expire.
2. **When to swap** — the moment a session is about to hit (or has hit) its account's limit, it moves the session to another eligible account.

## The new pieces

- **QuotaAwareScheduler** — the decision-maker. It picks the best account and, on quota pressure, resumes the session on a different one. If there's genuinely no other account to use, it says so honestly (raises one alert) and leaves the existing back-off in place rather than pretending it swapped.
- **The swap mechanism** — a session is launched pointed at a specific account's login (its config home). Crucially, resuming a conversation is account-agnostic: the same conversation can pick up under a different account with nothing lost. So "swap accounts" = "resume the same conversation, just on a fresh account."

## The safeguards

- **The conversation never dies on a limit** — it either swaps before the wall, or resumes on another account after. This is the hard guarantee, proven by an end-to-end test that drives a session to a (mocked) quota limit and checks it resumes on another account.
- **Existing session restarts are unchanged** — the account-swap plumbing is purely additive; when no swap is requested (every session today), the restart path behaves byte-for-byte as before.
- **Automatic swapping ships OFF** — the scheduler's logic and a manual swap button are available, but auto-swapping a live session on rate-limit detection only happens when you explicitly turn it on (it's real authority over your running sessions, so it's opt-in).
- **No tokens, no API keys** — same as the rest of the standard: only login locations are stored, and accounts are driven through the real Claude Code client.
