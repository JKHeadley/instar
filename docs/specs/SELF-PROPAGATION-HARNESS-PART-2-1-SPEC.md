---
approved: true
review-convergence: justin-approved-option-A-2026-05-27 (Telegram greenlight for full Part 2.1 — auto-mint via Secret Drop + Playwright Telegram round-trip + one-button CLI; conformance pass against the six Instar standards: no-manual-work / structure>willpower / signal-vs-authority / near-silent / 3-tier-testing / migration-parity)
parent-spec: SELF-PROPAGATION-HARNESS-SPEC.md
---

# Spec — `instar test-as-self` Orchestration (Part 2.1)

## Context

Parent spec [`SELF-PROPAGATION-HARNESS-SPEC.md`](./SELF-PROPAGATION-HARNESS-SPEC.md)
is approved + landed. **Part 1** (poll-ownership lease) shipped (PR #446)
and is verified live on Echo. **Part 2 v1** shipped (PR #448) — a runbook
(`.claude/skills/test-as-self/SKILL.md`) + a deterministic post-deploy
verifier (`scripts/verify.mjs`) that asserts the Part 1 lease, greps the
server log for the demote line (proves Part 1 fired), and tails for real
crash signatures (heap-OOM, `CheckIneffectiveMarkCompact`, Abort trap,
libc++abi, SIGABRT).

v1 explicitly deferred — and SKILL.md lists as "NOT YET" — the three
moving parts that turn the runbook from "if a human does the recipe
right, the verifier will tell you the answer" into "one command runs it
end-to-end and tells you the answer":

1. **Auto-mint** of a throwaway test bot via Secret Drop.
2. **Full Playwright Telegram round-trip** (Echo logged-in profile sends
   the probe AS Justin; verifier confirms the throwaway agent replied to
   the right topic with the right body).
3. **One-button `instar test-as-self` CLI command** that orchestrates the
   whole seven-step deploy → verify → teardown loop with idempotency and
   crash-safe restore.

This sub-spec defines Part 2.1 precisely so that:

- Task 5 (close out PR #428 — cross-machine seamlessness) has a clean,
  repeatable two-machine deploy harness to run the live test through.
- The 2026-05-27 hand-done mmtest failure mode (ad-hoc deploy, unclear
  crash provenance) cannot recur.
- A future agent — Cursor, Aider, Gemini — gets the same harness for
  free, because the command is generic.

## Goal

`instar test-as-self [--target <dir>] [--bot-token <secret-drop-id>]`
runs the full seven-step harness from the parent spec, idempotent, with
deterministic crash capture, restoring cleanly on any exit path. Exit 0
= round-trip passed and no crash; exit ≥1 = a specific failure (each
step has a distinct exit code).

## CLI surface (locked)

```text
instar test-as-self [options]

Options:
  --target <dir>           Throwaway agent home (default: ~/.instar/test-deploys/<isoTs>/)
  --bot-token <drop-id>    Existing Secret Drop ID for a test bot token (skips mint flow)
  --keep                   Skip teardown after run (for forensics on failure)
  --no-roundtrip           Run lease/log verifier only (skip Playwright step)
  --report-json <path>     Write per-step JSON report (default: <target>/test-as-self-report.json)
  --timeout-s <secs>       Overall timeout (default: 600)
```

Forbidden inputs:
- `--target` resolving to the canonical agent home or to "Bob" (mini :4040)
  → exit 11 with a clear message; SourceTreeGuard-style block.
- `--bot-token` value that looks like a raw Telegram token (matches
  `^\d+:[A-Za-z0-9_-]{20,}$`) → exit 12, refuses to accept the token on
  the command line; must use a Secret Drop ID.

## The seven steps (verified gating between each)

Implementation lives in `src/commands/test-as-self.ts` as a Tier-1
LLM-supervised step machine (Haiku judging each step's evidence before
the next runs). Each step writes a row to the JSON report; failure of any
step aborts subsequent steps and triggers teardown (unless `--keep`).

1. **Bot acquisition.** If `--bot-token` given, validate the Secret Drop
   ID is live + retrieve via the hardened `secret-drop-retrieve.mjs`
   (stderr-names-only, value to a chmod-600 tmp file). Else: open a new
   Secret Drop request titled "Test-as-Self bot token (one-time)" and
   block until the operator submits, with a 5-minute soft timeout. The
   token never appears in argv, env, or chat.
2. **Target preparation.** Create the throwaway agent home (mkdir -p,
   chmod 700); write a minimal config (port, bot token reference, no
   relayed channels, `multiMachine: { enabled: false }`); refuse to
   continue if the target dir is non-empty unless `--keep` from a prior
   run is present (idempotent resume).
3. **Dist deploy.** Symlink (not copy) the current `dist/` into the
   target, run `npm rebuild better-sqlite3` inside the target with the
   correct node version. Capture rebuild log to the report; abort if
   the rebuild errors.
4. **Process start.** Start the throwaway server with `--no-telegram`
   (Part 1 makes this belt-and-suspenders) and a dedicated lifeline as
   sole poller. Wait for `/health` 200 + the lease file to appear,
   bounded by `--timeout-s / 4`. PID + log paths recorded in the report.
5. **Round-trip smoke test.** Drive the existing Playwright Telegram
   profile (Echo's logged-in browser) to:
   a. Send a probe message ("test-as-self <isoTs> <nonce>") AS Justin to
      a designated test topic.
   b. Wait up to `--timeout-s / 4` for a reply that contains the same
      nonce, scoped to the same topic, from the throwaway agent.
   c. Record the round-trip latency + Telegram message IDs.
   On `--no-roundtrip`, skip this step.
6. **Crash + lease verification.** Run the existing
   `scripts/verify.mjs --dir <target>` against the running deploy
   (Part 2 v1's deterministic verifier). Fold its JSON into the report;
   any FAIL aborts.
7. **Teardown.** Stop processes (SIGTERM then SIGKILL after 5s), revoke
   the bot's webhook, remove the symlink, delete the throwaway home —
   unless `--keep`. Always-run finally block; signal-safe.

## Structural guardrails (structure>willpower)

- **Bob protection.** Hard-coded reject of `--target` matching the
  mini's home; same primitive as `SourceTreeGuard`.
- **Canonical protection.** Hard-coded reject of `--target` matching the
  agent's own home directory.
- **Token hygiene.** Token never goes into argv, env, or stdout; only
  written to chmod-600 tmp file consumed by the throwaway server's
  config loader.
- **Crash capture.** `NODE_OPTIONS=--unhandled-rejections=strict` +
  `node --report-on-fatalerror --report-directory=<target>/crash-reports/`
  on the throwaway server — V8 writes a structured crash report on any
  fatal error, which the verifier ingests.
- **Lease lock-in.** Refuses to proceed past step 4 if `lifelineOwnsPoll()`
  doesn't return true within `--timeout-s / 4` — proves Part 1 actually
  took effect on the throwaway, not just shipped.

## Test plan (all three tiers)

- **Unit:** `src/commands/test-as-self.ts` argument validation
  (rejects Bob, rejects raw tokens, rejects canonical-home target, default
  target paths well-formed); each step function in isolation with
  injected dependencies (fake bot client, fake spawn, in-memory health
  check); JSON-report shape stable across step orderings.
- **Integration:** with a real throwaway agent home in a tmpdir
  (no real Telegram), run steps 2-4 + 6 + 7 end-to-end; assert health
  comes up, lease appears, verifier passes, teardown is clean
  (no orphaned processes, no leftover dirs).
- **E2E / live:** real `instar test-as-self --bot-token <drop>` on this
  machine; assert round-trip passes AND verifier passes AND teardown is
  clean AND the JSON report is consumable.

## Migration parity

- New CLI command → must register in `src/commands/index.ts` cli table
  AND in `src/scaffold/templates.ts` (`generateClaudeMd()` — Agent
  Awareness Standard). No existing-agent file change otherwise.
- The skill at `.claude/skills/test-as-self/SKILL.md` (already shipped
  in v1) gets an updated "Step 1: just run `instar test-as-self`" intro
  with a fall-back to the v1 manual recipe.
- Built-in skills are non-destructive on update so v1's SKILL.md gets
  patched via a `PostUpdateMigrator.migrateTestAsSelfSkill()` migration
  (per the Migration Parity Standard, item 5b).

## Rollback

Single new command + one new file (`src/commands/test-as-self.ts`) + one
migrator method + a CLAUDE.md template addition. Revert the PR.

## What this is NOT

- Not a CI hook (developer-driven, not automatic).
- Not a substitute for the seamlessness E2E in `tests/e2e/` (which uses
  fakes); this is the real-deploy backstop.
- Not Bob-touching, ever.
- Not a bot-leak risk: token only flows through Secret Drop + chmod-600
  tmp file; never logged.

## Open question for Justin (scope)

- **A) Build all of Part 2.1 now** (full auto-mint + Playwright
  round-trip + one-button command), then run the live two-machine test
  for PR #428 once machine 2 is provisioned. ~1 day of focused work.
- **B) Ship just the one-button command** (steps 1-4 + 6 + 7 — no
  Playwright round-trip), and rely on the existing logged-in profile for
  manual round-trip verification. ~0.5 day; lets PR #428 close sooner
  but doesn't fully retire the "ad-hoc deploy" failure mode.
- **C) Reorder:** unblock PR #428's merge first (rebase + manual
  two-machine test with v1's verifier), Part 2.1 ships after as a
  standalone follow-up.

Leaning **A** — the original parent spec's argument was that hand-done
deploys are the failure mode; (C) preserves that failure mode for the
exact test we're trying to use to close PR #428.
