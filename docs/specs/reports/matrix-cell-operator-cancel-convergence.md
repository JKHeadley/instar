# Convergence Report — Operator-Cancel for an In-Flight Account×Machine Matrix Cell

## Cross-model review: codex-cli:gpt-5.5

A real GPT-5.5 external pass ran through the agent's codex CLI on both rounds
(gemini-cli was available but degraded/timed-out on both attempts — a successful
codex pass per round means the spec received genuine cross-model review). Round-1
codex: MINOR ISSUES. Round-2 codex: MINOR ISSUES (all addressed in-spec).

## ELI10 Overview

The account×machine matrix is the dashboard grid where you log one of your accounts
into one of your machines. Today, once you tap "Set up," the cell spins for up to 15
minutes with no way to stop it — a wrong tap leaves a real login window open on the
target machine with no undo. This spec adds a **Cancel** button on the spinning
cell: tap it, and the leftover login window is shut down and the in-progress record
is marked "abandoned" so the cell frees up to re-tap cleanly. It works for a cell on
your current machine OR another of your machines, exactly like the rest of the grid.

The interesting story is what the review changed. The first draft *looked* simple —
"call abandon(), kill the pane, done" — but a five-reviewer internal pass plus a
GPT-5.5 external pass found that the simple version was quietly broken in four ways,
all verified against the real code before any code was written. The converged design
fixes all four, and the tradeoffs (Bearer-auth not PIN; no credential-folder wipe;
no mandate-revoke) are decided in the spec with grounded rationale, not left open.

## Original vs Converged

1. **The pane-teardown call did nothing.** Originally the spec killed the login pane
   via `sessionManager.killSession`. The enroll pane is a *raw* `tmux new-session`
   that SessionManager never registers — so `killSession` returns false and kills
   nothing, while the route reports success. Converged: raw `tmux kill-session`, the
   exact teardown enroll-start itself uses.
2. **Cancel would have broken re-enrollment.** Marking a record "abandoned" left its
   id slot occupied; since follow-me uses the account id as the login id, the next
   "Set up" for that account threw "already exists" → 500. Converged: `issue()`
   replaces a terminal/expired same-id record (still rejects a genuine live
   duplicate), fixing re-enroll generally.
3. **Cancel could have un-done a successful login.** `abandon()` had no terminal
   guard, so a Cancel a split-second after sign-in completed would flip
   `completed`→`abandoned`. Converged: a store-level terminal guard + a route-level
   idempotent terminal read + a 409 "a sign-in is being completed" guard that makes
   cancel stand aside during the credential write.
4. **Self-only was a half-feature.** The original scoped cancel to the current
   machine and deferred peer cells. But the grid is cross-machine everywhere else,
   and the relay pattern to reach a peer already exists. Converged: a fronting relay
   `follow-me/cancel` (≈20 lines mirroring `follow-me/submit-code`) so one tap
   cancels a self OR peer cell — no deferral.

The auth posture also flipped from PIN-gated to **Bearer-only**, not as a shortcut
but because a per-machine PIN mechanically cannot cross the mesh — so peer cancel
*requires* the Bearer-forwarding posture that submit-code already uses.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, adversarial, integration, decision-completeness, lessons-aware, codex-cli:gpt-5.5 | 5 (no-op kill; re-enroll break; completed-clobber; self-only half-feature; stranded-slot decision) | Full rewrite: raw tmux teardown; `issue()` replace + `transition()` terminal guard; submit-in-flight 409; peer relay added; Bearer-only posture; D1–D4 frontloaded; response-shape + id-validation fixes |
| 2 | security/adversarial (verify), lessons/decision (verify), codex-cli:gpt-5.5 | 0 material (2 new-minor: replace-while-pane-live teardown reliance; single-event-loop atomicity invariant — both folded in as doc/test refinements) | Added edge-note + atomicity invariant to store-changes; operational-vs-audit clarification; ownership invariant in D1 |
| (converged) | — | 0 | none |

Standards-Conformance Gate: ran round 1 (degraded: error — fail-open, registry
canary OK 51/51), advisory only.

## Full Findings Catalog

**Round 1 — material (all resolved):**
- **[CRITICAL, security] `killSession` no-op** — enroll pane is raw `tmux new-session`
  (server.ts:10715), unregistered → killSession kills nothing. *Resolved:* raw
  `execFileSync(tmuxPath,['kill-session','-t','=<pane>'])` (server.ts:10713 pattern).
- **[CRITICAL, adversarial] expired logins 404** — `pending()`=`active()` excludes
  live-expired. *Resolved:* resolve via `getById`→`store.get()` (includes expired).
- **[MATERIAL, adversarial] re-enroll id-occupied** — abandon leaves id, `issue()`
  throws on re-enroll → 500. *Resolved:* `issue()` replaces terminal/expired same-id.
- **[MATERIAL, security+adversarial+decision+lessons] completed-clobber** — `abandon()`
  has no terminal guard. *Resolved:* store terminal guard + route idempotent terminal
  read + 409 submit-in-flight guard.
- **[HIGH, integration] self-only half-feature** — grid proxies peers everywhere
  except cancel. *Resolved:* fronting relay `follow-me/cancel` added (no deferral).
- **[MATERIAL, decision] stranded configHome slot** — kill mid-write could strand a
  partial credential. *Resolved (decision D3):* don't wipe the slot; 409 guard avoids
  mid-write; slot hygiene is the existing coherence path's job.
- PIN-vs-Bearer (decision D1), order abandon-first (D2), mandate-not-revoked (D4),
  response-shape clarity (codex #1), id-validation, @silent-fallback-ok tag,
  E2E-alive test, dashboard durable-cell button (integration MED) — all resolved.

**Round 2 — minor (all folded in):**
- replace-while-pane-live relies on next-spawn pre-clean (added edge-note).
- single-event-loop atomicity is load-bearing (added invariant + test-plan line).
- `issue()` replace could erase completed history (clarified: PendingLogin is
  operational, not audit state — pool is the system of record).
- auth framed by consistency not ownership (added ownership invariant to D1).

## Convergence verdict

Converged at iteration 2. No material findings in the final round; both internal
verifier passes returned "Converged — no new material issues," and the codex
external's round-2 points were minor and are addressed in-spec. Zero unresolved
`## Open questions`. Spec is ready for review and approval.
