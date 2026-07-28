---
name: test-as-self
description: Deploy the current instar dist into a throwaway agent home and verify the deploy is healthy — clean evidence instead of post-hoc log forensics. Use BEFORE shipping a change that touches the deploy/lifeline/server path; AFTER landing such a change; or to reproduce a crash observed in the wild.
metadata:
  user_invocable: "true"
---

# /test-as-self — Throwaway-Deploy Harness (Part 2.1)

> Spec: `docs/specs/SELF-PROPAGATION-HARNESS-SPEC.md` + the Track F section of `docs/specs/MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.md`. Part 1 (the structural poll-ownership lease) ships alongside. Part 2.1 folded the manual recipe below into a single command — use that first; the manual recipe is the fallback for fine-grained control.

## The one-button path (Part 2.1 — use this first)

```bash
instar test-as-self --no-roundtrip                  # deploy + verify only (no bot)
instar test-as-self --bot-token <secret-drop-id>    # + a real Telegram round-trip
instar test-as-self --keep                          # leave it running for inspection
```

The command runs the seven gated steps automatically (bot-acquire via Secret Drop / target-prep with Bob+canonical-home guards / dist-deploy / process-start + wait for /health + lease / Telegram-Bot-HTTP-API round-trip / `verify.mjs` / signal-safe teardown) and emits a single JSON report; exit 0 = all PASS. Structural guards make it impossible to target your real agent home or Bob, and it refuses a raw bot token on the command line (Secret Drop only). The round-trip uses the Telegram Bot HTTP API directly (not Playwright) — no browser, no flake.

Fall back to the manual recipe below only when you need step-by-step control or to debug a single step.

## When to use

- **Verifying Part 1 of the spec** — does the server actually auto-demote to send-only when the lifeline owns the poll slot? (Run this skill against any deploy that bundles Part 1.)
- **Before shipping a change** to the deploy / lifeline / server-startup path — clean evidence beats guessing.
- **Reproducing a crash** observed in the wild — the verifier captures crashes deterministically (server.log + lifeline.log tail for FATAL / OOM / heap signatures), so you get the real signature instead of post-hoc forensic guessing.

## Why a runbook, not a one-button command (v1 scope)

The deploy itself involves operator-specific choices (which throwaway dir? which bot token, if any? skip the bot? reuse a prior bot?) that resist a one-size-fits-all `instar test-as-self --go` for v1. The skill's `verify.mjs` script is the **deterministic** half (no operator judgment — just reads the artifacts and reports). The deploy steps are documented below as a tight, repeatable recipe. Follow-up Part 2.1 will fold the recipe + bot minting into a single CLI command.

## Recipe — deploy + verify

### 1. Pick a throwaway agent dir

Use a fresh path, NEVER your real agent home or Bob:

```bash
TEST_DIR="$HOME/.instar/agents/test-as-self-$(date +%Y%m%d-%H%M%S)"
```

### 2. Initialize the throwaway agent

```bash
node /path/to/instar/dist/cli.js init --dir "$TEST_DIR"
```

This sets up `.instar/`, `.claude/`, allocates a port, generates an auth token. The deploy includes the current instar dist (Part 1's lease module shipped with it).

### 3. (Optional) Configure a bot token

Required ONLY if you want to verify Part 1's lease behavior (the lifeline must poll Telegram to write the lease). Add a real test bot token to `.instar/config.json` → `messaging[*].config.token`. **NEVER paste a real production token; use a throwaway test bot.**

Skip this step if you just want to verify the deploy starts cleanly + capture crashes.

### 4. Start the lifeline (only when step 3 was done)

```bash
node /path/to/instar/dist/cli.js lifeline start --dir "$TEST_DIR"
```

The lifeline begins polling Telegram. On its first successful tick it writes the poll-ownership lease at `$TEST_DIR/.instar/state/telegram-poll-owner.json`.

### 5. Start the server

```bash
env -u INSTAR_SESSION_ID -u INSTAR_JOB_SLUG \
  node /path/to/instar/dist/cli.js server start --foreground --dir "$TEST_DIR"
```

(The `env -u` strips parent-session vars so the server doesn't think it's running inside an existing session. The `--foreground` keeps it attached for easy stopping.)

**With Part 1 wired:** the server reads the lease on startup. If a live lease for the same bot token is present, it auto-demotes to **send-only** mode with the log line `Telegram send-only mode (lifeline owns polling (lease detected))`. No 409 Conflict possible regardless of `--no-telegram` flag.

### 6. Verify

After ~30 seconds (give the lifeline a few poll ticks):

```bash
node /path/to/instar/.claude/skills/test-as-self/scripts/verify.mjs --dir "$TEST_DIR"
```

The verifier prints a JSON report with PASS/FAIL per check:
- `lease.present` — is `state/telegram-poll-owner.json` on disk?
- `lease.fresh` — is the heartbeat within the staleness window?
- `lease.wellFormed` — pid + tokenHash + heartbeatTs + v match the schema?
- `lease.tokenHashOnly` — security check: the on-disk file does NOT contain the raw token.
- `server.demoteLogged` — does `logs/server.log` show the "lifeline owns polling" line? (Proves Part 1 fired.)
- `crashes.found` — are there FATAL / OOM / heap-exhaustion lines in `logs/server.log` or `logs/lifeline.log`? (Surfaces the signature deterministically.)

Exit code `0` = all PASS; `1` = at least one FAIL or a crash was detected.

### 7. Teardown

```bash
# Stop the server (Ctrl-C if foreground) and the lifeline daemon
node /path/to/instar/dist/cli.js lifeline stop --dir "$TEST_DIR"
# Optionally preserve the dir as crash evidence, otherwise:
rm -rf "$TEST_DIR"
```

## What this v1 does NOT do (tracked for Part 2.1)

- Auto-mint a bot (currently you supply or skip).
- Drive a full Telegram round-trip via the Playwright profile (the lifeline polls; the verifier checks the lease — but it doesn't yet send a probe message and assert a reply).
- Bundle the deploy + start + verify + teardown into one command (the recipe above is the manual orchestration).

These ship next under the same approved spec.
