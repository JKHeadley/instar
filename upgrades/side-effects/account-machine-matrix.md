# Side-effects review — Account × Machine matrix

Spec: `docs/specs/account-machine-matrix.md` (converged @ iter 4, approved) · ELI16: `docs/specs/account-machine-matrix.eli16.md`
Parent principle: Operator-Surface Quality

## What the change is

A machine × account matrix on the Subscriptions tab (rows=accounts, cols=machines; each cell ✓ active / ⟳ needs-reauth / ▢ Set-up button / ◷ in-progress / — offline / ✗ can't-resolve / ⚠ held). "Set up" runs the whole cross-machine sign-in IN the dashboard. One new PIN-gated backend route `POST /subscription-pool/matrix/start-cell` orchestrates the EXISTING PIN→mandate→enroll-start chain; code entry + completion reuse the shipped `submit-code` relay. Files: `src/server/routes.ts` (start-cell), `dashboard/subscriptions.js` (buildMatrixModel/renderAccountMatrix + controller wiring), `dashboard/index.html` (matrix section + CSS), tests.

## 1. Over-block — legitimate inputs rejected
A correct PIN is required per Set-up tap; a missing/invalid PIN is 403 (the operator just re-enters it). The matrix only shows Set-up on empty cells of REACHABLE machines, so it never offers an action that can't proceed. Offline columns disable their buttons (no dead taps).

## 2. Under-block — failure modes still missed
- An operator could sign into the WRONG provider account at the auth page — caught by the existing S7 email-gate at completion (minted email ≠ expectedEmail → held, not added, HIGH attention). Confirmed.
- A deliberately weak operator (sharing their PIN) is out of scope — the PIN is the operator-presence proof; protecting the PIN itself is the operator's responsibility (same as every PIN-gated action).

## 3. Level-of-abstraction fit
Correct: the matrix is a frontend over existing reads (`?scope=pool`, `pending-logins?scope=pool`) + the shipped `submit-code` relay, plus ONE thin orchestrator route that reuses the existing PIN-gated mandate-issuance + mandate-gated enroll-start. No new authorization primitive; no duplicated enroll/code logic.

## 4. Signal vs authority compliance
The load-bearing authorization is the **PIN** (operator presence) — NOT the Bearer token (which the agent also holds; a Bearer-only gate was the first draft's flaw, caught + fixed). start-cell adds no new authority: it drives the existing PIN-gated chain. The account-safety is the existing full-context S7 email-gate at completion (gates the ADD, not the START). No brittle new blocking check.

## 5. Interactions
- Reuses the shipped `submit-code` relay unchanged for the code half; reuses the proven delivered-mandate cross-machine path (the adriana R4a flow) for the peer enroll-start.
- Idempotent: re-tapping a cell reuses an existing valid pending login (no duplicate logins, no stacked mandates); an unused mandate from a failed enroll-start lapses by its existing TTL.
- The matrix data is read-only over pool-scope + pending-logins; it adds no new durable state.

## 6. External surfaces
- New dashboard UI (the matrix grid on the Subscriptions tab) — operator-facing, in-dashboard auth (the auth link opens in the operator's browser; the code rides the authed API, never chat). No fingerprints/JSON/raw text shown (Operators-act-in-taps).
- New route is PIN-gated + dev-gated (503 on the fleet). No change visible to other agents.

## 7. Multi-machine posture (Cross-Machine Coherence)
Inherently cross-machine and correct: matrix data is the pool-scope fan-out (merges peers, dark-peer-tolerant via `failed`); start-cell + submit-code relay one authed hop to the target via the proven delivered-mandate / `resolvePeerUrls()` paths (self → loopback); the PIN is verified at the fronting machine, the peer hop carries the already-PIN-verified mandate (never a PIN), mirroring how submit-code carries an already-validated code. Offline machines render machine-level offline (no fabricated per-account ✓ — that data doesn't exist for a dark peer). Single-machine agents: a one-column matrix, a no-op difference.

## 8. Rollback cost
Cheap. Dev-gated (`multiMachine.accountFollowMe`), dark on the fleet. Back-out = revert routes.ts (one route), subscriptions.js, index.html, tests. No data migration, no new durable state (the only state touched is the existing per-machine pools + transient pending logins). Static dashboard files revert without a restart.

## Second-pass (high-risk: PIN gate / authorization)
The PIN gate was independently re-verified: `start-cell` calls the genuine `checkMandatePin` (the same one `issue-for-machine` uses — validates against `dashboardPin`, rate-limits, returns 403 "not an agent action") BEFORE any mandate issuance or enroll-start; the peer hop carries the already-PIN-verified mandate, never a PIN. Bearer-only was rejected because the agent shares the Bearer (Know Your Principal). S7 gates the add at completion. Concur.
