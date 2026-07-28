---
title: Secret Drop — Sliding Retrieval Window + Atomic Use-and-Consume
parent-principle: "Structure beats Willpower"
status: approved
approved: true
approver: justin
approved-at: "2026-06-03T05:33:00Z"
approval-basis: "standing preapproval — operator actively directing this work in topic 18330"
review-convergence: "2026-06-03T05:33:00Z"
review-iterations: 1
review-completed-at: "2026-06-03T05:33:00Z"
review-report: "docs/specs/reports/secret-drop-sliding-window-convergence.md"
created: 2026-06-02
owner: echo
companion-eli16: secret-drop-sliding-window.eli16.md
eli16-overview: secret-drop-sliding-window.eli16.md
---

# Secret Drop — Sliding Retrieval Window + Atomic Use-and-Consume

## Problem

Secret Drop is the cornerstone mechanism for collecting a credential from a user
without it touching chat history or disk. On 2026-06-02 it failed repeatedly in a
real multi-step credential handoff (Bitwarden login, then a GitHub token), forcing
the operator to resubmit the same secret roughly six times. Two compounding flaws
in `src/server/SecretDrop.ts`, plus one consumer-side foot-gun, caused it:

1. **Fixed-window self-destruct.** After submission the value was stored for a hard
   `RECEIVED_TTL_MS = 5 minutes`, then a `setTimeout` deleted it unconditionally —
   even while a consumer was actively retrieving it. Any handoff (or debugging) that
   ran past 5 minutes lost the secret mid-flow.
2. **Retrieval did not extend the window.** `peekReceived` was already
   non-destructive (a 2026-05-20 hardening), but reading the value did not reset the
   5-minute timer, so being actively in-use did not keep the secret alive.
3. **Consume was a separate, agent-fireable step decoupled from success.** The agent
   could (and did, twice) run `--consume` after a step that had not actually
   succeeded — destroying the secret on a failure with no recovery but resubmission.

The user's requirement: "submit once, never dropped." Per **Structure > Willpower**,
the mechanism — not agent discipline — must make a premature drop impossible.

## Goals

- A submitted secret cannot expire while it is being actively retrieved.
- A secret is destroyed only on (a) an explicit consume after verified success, or
  (b) a bounded absolute lifetime cap.
- An agent cannot destroy a secret by consuming on a failed handoff.
- No weakening of the existing security guarantees: in-memory only, one-time
  submission, CSRF, sender-verification (R1a), XSS-safe form.

## Non-goals

- Surviving a full server restart. Today the store is in-memory only, so a bounce
  loses an unconsumed secret and the user must resubmit; this spec does not change
  that. Making it survive a restart means encrypting the submission at rest, which
  changes the never-on-disk guarantee and is its own review — out of scope here and
  tracked separately. <!-- tracked: fb-391a4a30-de9 --> Until then the contract is:
  a secret is durable across retrieval activity and time (up to the cap) but NOT
  across a server restart.
- Changing the request-link TTL (`DEFAULT_TTL_MS`, 15 min) or the submission flow.

## Design

### 1. Sliding idle window (server — `SecretDrop.ts`)

Replace the single fixed `RECEIVED_TTL_MS` timer with a **sliding idle window**
bounded by an **absolute cap**:

- `RECEIVED_IDLE_TTL_MS = 15 min` — the cleanup timer (re)arms for this long on
  submit and on **every** `peekReceived`. An actively-retrieved submission therefore
  never expires.
- `RECEIVED_ABSOLUTE_MAX_MS = 30 min` — a per-token `receivedDeadline` map records
  `now + 30 min` at submission. Each re-arm fires after
  `min(RECEIVED_IDLE_TTL_MS, deadline − now)`, so the window can extend up to but
  never past the cap. Even a relentlessly-polled secret is purged at 30 min.

A private `armReceivedCleanup(token)` centralizes the timer math; `submit()` and
`peekReceived()` both call it. `consumeReceived()` and `shutdown()` clear the new
`receivedDeadline` map alongside the existing timers.

The stuck-consumer event's `minutesUntilCleanup` is recomputed from
`receivedDeadline` (the value's true purge time) instead of the removed constant.

**Timing rationale.** 15 min idle matches the request-link TTL (`DEFAULT_TTL_MS`),
so the post-submit window is no shorter than the window the user already had to
open the link — and comfortably covers a real multi-step handoff (the 2026-06-02
Bitwarden-then-GitHub flow). 30 min absolute is a deliberately tight cap: long
enough that no realistic handoff hits it, short enough that an unconsumed secret's
in-memory plaintext lifetime is bounded to half an hour (vs. the old fixed 5 min —
a 6× worst-case increase, but only for a secret nobody consumes, which the cap then
purges). Both are constants, easy to retune if data shows otherwise.

**Structure > Willpower scope (honest limit).** The sliding window keeps a secret
alive only while the consumer uses the non-destructive `peekReceived` path; an agent
that erroneously calls `consumeReceived` mid-flow still drops it. The `--run` mode
(§2) is the real structural fix for that error class. The 30-min absolute cap is the
structural backstop that guarantees a bounded lifetime regardless of consumer
behavior. So: `--run` removes the consume-on-failure foot-gun structurally; the
sliding window removes the expire-while-in-use failure; the cap bounds the worst
case. Together they cover "submit once, never dropped" without relying on willpower.

### 2. Atomic use-and-consume (consumer — `secret-drop-retrieve.mjs`)

Add a `--run -- <cmd...>` mode to the hardened retrieve helper. It:

1. Peeks the field value (non-destructive — also slides the window, per §1).
2. Spawns `<cmd>` with the value piped to **stdin** (never argv, never stdout).
3. Consumes the submission **only if `<cmd>` exits 0**. On any non-zero exit or a
   launch failure, the secret is left intact and the helper exits with the command's
   code, so a retry is possible.

This makes "use" and "consume" a single success-gated operation — a failed handoff
can no longer destroy the secret. The standalone `--consume` flag remains for
back-compat but the agent-facing guidance (CLAUDE.md) now steers to `--run`.

## Signal vs Authority

This change does not add a decision point that gates information flow or blocks
actions. It is a lifetime/ownership change to an existing data store plus a consumer
ergonomics addition. No brittle-check-with-blocking-authority is introduced. The
`--run` mode's "consume only on exit 0" is a success gate on a local subprocess, not
an authority over agent behavior. (Ref: `docs/signal-vs-authority.md`.)

## Testing

- Sliding-window unit tests (`tests/unit/SecretDrop.test.ts`, vitest fake timers),
  covering both sides of each boundary: (a) stays alive past the idle window when
  retrieved before it lapses; (b) purged at the absolute cap despite continuous
  retrieval; (c) cleaned up when untouched after the idle window; (d)
  `consumeReceived` removes immediately. Full SecretDrop suite 37/37 green; tsc clean.
- Migration tests (`tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts`):
  the new `--run` CLAUDE.md awareness block inserts the bullet for an existing agent
  that already has the hardened helper, and is idempotent (no double-insert on
  re-run). 15/15 green.
- The `--run` helper itself (`secret-drop-retrieve.mjs`) is a Node script verified by
  `node --check` and arg-parse inspection. Its consume-only-on-exit-0 path is a thin,
  deterministic `spawnSync` wrapper; it is intentionally not given a dedicated unit
  test (it would require mocking a live server + a subprocess for low marginal
  assurance), and is exercised in practice by the documented `gh auth login` example.
  This is the single declared coverage gap and is judged acceptable.

## Migration / rollout

- `SecretDrop.ts` is compiled server code — ships to every agent via the normal npm
  auto-update. No migration needed.
- `secret-drop-retrieve.mjs` is an installed agent file. `PostUpdateMigrator`'s
  relay-script refresh **always overwrites** it from the template, so existing agents
  receive `--run` automatically on update — no new migration code required for the
  script itself.
- Agent awareness: the CLAUDE.md scaffold template (new agents) and a new idempotent
  `PostUpdateMigrator` CLAUDE.md block (existing agents) document `--run`.

## Rollback

Pure code revert — no data migration, no agent-state repair. Reverting restores the
fixed 5-minute window and removes `--run`; the standalone `--consume` path is
untouched throughout, so nothing depends on the new behavior to function.
