---
approved: true
review-convergence: internal-adversarial-2026-05-27 (single-reviewer conformance pass against the six Instar standards — no-manual-work, structure>willpower, signal-vs-authority, near-silent, 3-tier-testing, migration-parity — plus gameability/over-block sweep. Scope locked via Justin's AskUserQuestion answer + explicit "go" on the ELI16: harness + structural poll-ownership lease. /spec-converge not run: branded skill not installed on this checkout, same as prior specs this session.)
---

# Spec — Agent Self-Propagation Harness + Poll-Ownership Lease (Task 4 / CMT-560)

## Problem

Deploying "me" onto a second machine for a live test is currently a fragile, hand-done sequence (mint a bot, configure the agent, copy the dist, start the server, smoke-test, restore). The 2026-05-27 live test surfaced two failures, and the ad-hoc nature of the deploy made them hard to pin (diagnostics: `.instar/task4-self-propagation-diagnostics.local.md`):

1. **Telegram 409 dual-poll (structural gap, code-verified).** instar has two potential Telegram pollers — the lifeline (canonical, forwards to the server) and the server's own `TelegramAdapter` (`telegram.start()`). The server runs send-only ONLY when started with `--no-telegram` or on a standby machine (`server.ts:2888` vs `:2976`). Nothing structurally detects that a lifeline already owns the poll slot, so "lifeline = sole poller, server = send-only" is enforced by operator discipline. Start the server without `--no-telegram` while a lifeline polls the same token → guaranteed 409.

2. **A V8 heap OOM (mischaracterized as a "libc++ mutex crash" in CMT-560).** A Python-spawned node under the test agent exhausted the JS heap in ~83s. The mmtest server itself ran send-only correctly and survived past the crash, so the OOM was a *separate* spawned process. The evidence is muddy precisely because the deploy was hand-done — which is the core argument for the harness.

This blocks the Cross-Machine Seamlessness live test (PR #428, Task 5), which needs a clean, repeatable two-machine deploy.

## Goal

A single idempotent command — `instar test-as-self` — that deploys the current dist onto a target agent home, runs a Telegram round-trip smoke test, captures any crash deterministically, and restores cleanly; PLUS a structural fix so the 409 dual-poll cannot happen regardless of operator flags.

## Solution — two parts

### Part 1 — Poll-ownership lease (STRUCTURAL, structure>willpower)

The lifeline, when it owns the poll slot, writes a small lease under `state/` (`telegram-poll-owner.json`: `{ pid, tokenHash, heartbeatTs }`, refreshed each poll tick). The server's full-poll branch (`server.ts:2976`) checks for a live lease (heartbeat within N×tick) whose `tokenHash` matches its own bot token; if present, it auto-demotes to send-only with a clear log line ("lifeline owns the poll slot — send-only"). Then dual-polling cannot occur even if the server is started without `--no-telegram`.
- Fail-open: a stale/absent lease → server polls as today (no regression for lifeline-less setups).
- `tokenHash` (not the token) so the lease file never holds a secret.
- Migration parity: the lifeline-writes-lease + server-reads-lease both ship in the same version; no agent-installed-file change.

### Part 2 — `instar test-as-self` harness (operational, idempotent, Tier-1 supervised)

A CLI command + skill that runs the deploy as discrete verified steps, each checked before the next:
1. **Bot:** reuse an existing test bot (from a local, gitignored config) or mint one (operator supplies the token via Secret Drop — never on the command line / never in chat).
2. **Configure** a throwaway target agent home (isolated dir; never Bob, never the canonical home).
3. **Deploy** the current dist, handling node-version-specific native modules (`npm rebuild better-sqlite3`).
4. **Start** the server with `--no-telegram` (Part 1 makes this belt-and-suspenders) + the lifeline as sole poller.
5. **Smoke-test** the Telegram round-trip (send a probe, assert a reply) using the existing Playwright test-as-self profile.
6. **Capture** any crash deterministically (wrap node with a crash-report path; tail the agent's server.log for OOM/FATAL) and surface the real signature.
7. **Restore/teardown** on exit (stop processes, optionally `/deletebot`), idempotent and safe to re-run.

## Test plan (all three tiers)
- **Unit:** poll-ownership-lease decision (live lease + matching tokenHash → demote; stale/absent/mismatched → poll); harness step-state machine (each step's success/failure gating); tokenHash never equals the raw token.
- **Integration:** server startup with a freshly-written lease present → asserts send-only mode selected (no `telegram.start()` poll); lease absent → full-poll.
- **E2E / live (test-as-self):** run `instar test-as-self` against a throwaway agent home on this machine; assert the round-trip smoke passes AND no 409 in the agent log AND the crash-capture path is exercised (clean or real signature reported). This is also what unblocks Task 5 (PR #428 seamlessness live test).

## Migration parity
Part 1 is server + lifeline source (both ship together). Part 2 is a new CLI command + skill (new skill → installBuiltinSkills, non-destructive). No existing-agent settings/config change required for Part 1's default behavior (fail-open preserves current behavior).

## Rollback
Part 1: the lease check is additive + fail-open; revert the server-side check. Part 2: a new command; remove it.

## Open question for Justin (scope)
- **A) Harness only** (operational `test-as-self`), leaving the 409 to "always pass `--no-telegram`"; OR
- **B) Harness + the structural poll-ownership lease** (recommended — fixes the 409 class permanently, structure>willpower).
Leaning B. The native-OOM is diagnosed-not-yet-fixed: the harness's deterministic crash-capture is the vehicle to get the real signature before attempting a fix (don't claim a fix without reproduction — evidence bar).
