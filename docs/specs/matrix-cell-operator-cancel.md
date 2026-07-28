---
slug: matrix-cell-operator-cancel
title: Operator-cancel reversibility for an in-flight account×machine matrix cell
parent-principle: "Mobile-Complete Operator Actions"
status: approved
eli16-overview: matrix-cell-operator-cancel.eli16.md
approved: true
approved-by: echo (autonomous pre-approval — topic 13481, 24h run)
review-convergence: "2026-06-19T21:53:10.112Z"
review-iterations: 2
review-completed-at: "2026-06-19T21:53:10.112Z"
review-report: "docs/specs/reports/matrix-cell-operator-cancel-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 2
contested-then-cleared: 1
---

# Operator-Cancel for an In-Flight Account×Machine Matrix Cell

## Problem

PR #1230 shipped the account×machine authorization matrix happy-path: from the
dashboard grid (`dashboard/subscriptions.js`), an operator taps an empty cell, the
PIN-gated `POST /subscription-pool/matrix/start-cell` issues an
`account-follow-me` mandate and drives `follow-me/enroll/start`, which spawns a
waiting `claude auth login` pane (a raw `tmux new-session` — `server.ts:10715`) on
the target machine and records a `PendingLogin` (`status: 'pending'`, 15-minute
TTL). The cell then renders in the in-progress (◷) state until the login
completes, expires, or the TTL lapses.

**There is no way to back out of an in-flight cell.** If the operator taps "Set
up" on the wrong account or the wrong machine, the cell sits ◷ for up to 15
minutes with:

- a live `claude auth login` pane consuming a tmux slot on the target machine,
- a `pending` PendingLogin occupying its id slot,
- no affordance — route or button — to abandon it.

The data model already anticipates this: `PendingLoginStatus` includes
`'abandoned'` and `PendingLoginStore.abandon(id)` is implemented and unit-tested.
It is simply **not wired to any route or any button**. This is a reversibility
gap in a mobile-first operator surface — the operator's most likely first mistake
(wrong cell) is the one with no undo.

This spec closes that gap. **It does so symmetrically with the rest of the matrix
flow**: every other write step (start-cell, submit-code) already reaches peer-held
logins through a fronting relay; cancel does too. (The first draft scoped cancel
to self cells only; the convergence review correctly rejected that as a misleading
half-feature on a surface whose whole point is cross-machine — see Original vs
Converged in the report.)

## Goal

A `POST /subscription-pool/follow-me/enroll/:id/cancel` (target-local worker) +
`POST /subscription-pool/follow-me/cancel` (fronting relay) route pair, and a
mobile-first Cancel button on the in-progress matrix cell, such that an operator
who started a cell by mistake — on THIS machine or a PEER — can reverse it in one
tap: the login pane is torn down and the `PendingLogin` becomes `abandoned`,
freeing the cell to be re-tapped cleanly.

## Non-Goals

- **Cancelling a `completed` enrollment.** Once an account is enrolled into the
  pool, removal is the existing pool-removal / mandate-revoke path, not this route.
  This route only acts on a non-terminal (`pending`/`expired`) PendingLogin; a
  cancel against a `completed`/`abandoned` record is an idempotent read (below).
- **Wiping the per-account `configHome` credential slot.** See Frontloaded
  Decision D3 — cancel deliberately does NOT delete `~/.claude-followme-<id>`.
- **Revoking the start-cell mandate.** See Frontloaded Decision D4 — the bounded
  1h re-mint-only mandate is left to expire.
- **New authority.** Cancel grants no capability; it is strictly de-escalating.

## Frontloaded Decisions

**D1 — Auth posture: Bearer-only, mirroring `submit-code` (NOT PIN-gated).**
The PIN gate (`checkMandatePin`) lives ONLY on `start-cell` — the privileged MINT
that issues a mandate. Operating on an already-authorized in-flight login is
Bearer-only: the target-local `:id/submit-code` route and the `follow-me/submit-code`
fronting relay (`routes.ts:21406-21443`) carry no PIN; the relay forwards
`Authorization: Bearer ${ctx.config.authToken}` to self-loopback or a peer. Cancel
is the same shape — it operates on an existing login, mints nothing. **Two reasons
this is forced, not merely chosen:** (a) consistency — cancel's nearest sibling
(submit-code, "operate on an in-flight login") is Bearer-only, and a lone
PIN-gated cancel would be the odd one out; (b) **mechanism** — a PIN cannot cross
the mesh: each machine has its OWN `dashboardPin`, so a PIN-gated target-local
route is UNREACHABLE by the fronting relay for a peer cell (the peer would reject a
foreign PIN). Supporting peer cancel (the headline of this revision) REQUIRES the
Bearer-forwarding posture. The residual — a Bearer-holding agent session could
cancel an operator's in-flight setup — is (i) identical to the existing,
shipped submit-code posture (an agent could equally disrupt an enrollment by
submitting a garbage code), (ii) strictly reversible (re-tap "Set up" to redo),
and (iii) confined to the dark dev-agent gate. The operator-presence proof
correctly lives at the MINT (start-cell), not on every operate-on-login route.
**Ownership invariant:** there is no cross-tenant question — the Bearer is the
agent's OWN intra-trust boundary, and the account×machine matrix only ever contains
the operator's own accounts on the operator's own machines. "Who may cancel which
login" is the same answer as "who may submit a code / start a cell": the operator
(or the operator's agent holding the Bearer), scoped to this agent's own follow-me
logins. The relay never reaches another principal's logins —
`resolvePeerUrls()` resolves only THIS agent's own paired machines.

**D2 — Order of operations: abandon the store record FIRST, then best-effort kill
the pane.** The store record is the source of truth the UI and the start-cell
idempotency-reuse read. Abandoning first makes the record immediately
non-reusable and clears the cell; a crash between the abandon and the kill leaves
an orphaned pane, but that pane is **self-healed on the next enroll** — enroll-start
pre-cleans the slot's pane (`execFileSync(tmux, ['kill-session', '-t', '=<pane>'])`,
`server.ts:10713`) BEFORE spawning a new one. The inverse order (kill-first) risks
the start-cell reuse path handing out a dead pane's `verificationUrl` in the crash
window, which is worse. So: abandon → then kill.

**D3 — Do NOT wipe the `configHome` slot on cancel.** `~/.claude-followme-<id>` is
per-account and reused across enrollments of the same account; deleting it on
cancel could clobber a previously-valid credential for that account. A mid-write
partial credential is avoided structurally by the submit-in-flight guard (below):
cancel refuses (409) while a `submit-code` is actively landing a credential, so it
never kills the pane mid-write. Stale-slot hygiene remains the existing
credential-coherence path's job (`/credentials/restore-enrollment` quarantine), not
cancel's.

**D4 — Do NOT revoke the start-cell mandate on cancel.** Known residual: a
cancelled enrollment leaves the bounded, re-mint-only `account-follow-me` mandate
live for up to its 1h expiry. It grants no standing authority (re-mint of the
operator's own account only) and expires on its own; revoking it adds cross-machine
revocation complexity for no safety gain. Accepted residual.

## Design

### Store changes (`src/core/PendingLoginStore.ts`)

> `PendingLogin` is **operational state, not audit history** — it tracks an
> in-flight login so the wizard can reissue/complete it, and stores only public
> codes/URLs (never credentials). The durable record of a *successful* enrollment
> is the subscription pool entry (+ server logs); the `completed` `PendingLogin` is
> not the system of record. So `issue()` replacing a same-id `completed` record on
> re-enrollment loses no audit evidence — the pool already holds the enrollment.

1. **Terminal guard in `transition()` (defense in depth).** `transition()`
   currently re-stamps status unconditionally — so `abandon()` on a `completed`
   login would silently flip it to `abandoned` and bump `version`. Add a guard:
   `transition()` returns the existing record UNCHANGED (no version bump, no save)
   when the record is already in the requested terminal state OR when transitioning
   FROM a terminal state (`completed`/`abandoned`) TO `abandoned`. This makes
   `complete`→`abandoned` clobbering impossible at the store layer regardless of
   route logic. (`reissue()` already has the analogous guard at line 205.)

2. **`issue()` replaces a terminal/expired same-id record instead of throwing.**
   `issue()` throws `"already exists"` on ANY duplicate id today. Since follow-me
   uses `accountId` as the login id, a cancel→`abandoned` record would block the
   account's RE-enrollment (`issue()` throws → enroll-start 500). Fix: if an
   existing record with the same id is found, throw the duplicate error ONLY when
   its LIVE status is `pending` (a genuine in-flight duplicate); otherwise
   (`completed`/`abandoned`/live-`expired`) splice it out and create fresh. This
   fixes re-enrollment generally (also after a removed completed account), not just
   for cancel. start-cell's reuse path only falls through to `issue()` when no
   reusable pending exists, so by construction any same-id record reaching `issue()`
   is non-pending → replaced. (Edge note: a record can be live-`expired` while its
   `claude auth login` pane is still physically alive — `withLiveStatus` derives
   `expired` from TTL only, with no hard pane self-kill. `issue()` does no pane
   teardown itself; the stale pane is reclaimed by enroll-start's pre-clean
   (`server.ts:10713`) when the replacement login respawns under the SAME
   per-account `configHome` slug — which it always does in the follow-me path
   (id === accountId, configHome per-account). So replace-while-pane-live
   self-heals on respawn; `issue()` is not responsible for the kill.)

**Single-event-loop atomicity (load-bearing invariant).** `PendingLoginStore` is
in-memory with synchronous file writes and no mutex; the route-layer
`followMeSubmitInFlight` Set guards submit-vs-cancel but not cancel-vs-a-concurrent
`enroll/start`→`issue()` for the same id. This is safe ONLY because every store
method reads and `save()`s without an `await` in between, so no two store mutations
can interleave within the single Node event loop. The Test Plan locks this with a
"cancel races a re-issue" assertion so the property can't silently regress.

### EnrollmentWizard pass-throughs (`src/core/EnrollmentWizard.ts`)

Add two thin delegations (mirroring the existing `pending()` / `completeFollowMe()`
so routes never import the store directly):

- `getById(id): PendingLogin | null` → `this.store.get(id)` — returns the record
  with LIVE status (computes `expired`), INCLUDING terminal/expired records (unlike
  `pending()`, which returns only `active()` = live-`pending`). The cancel route
  MUST use this, not `pending()`, or an expired login would 404.
- `abandon(id): PendingLogin | null` → `this.store.abandon(id)`.

### Route: target-local `POST /subscription-pool/follow-me/enroll/:id/cancel`

Placed immediately after the `submit-code` route in `src/server/routes.ts`, in the
SAME closure (so it shares the `followMeSubmitInFlight` Set). Gate/branch order:

1. **Dev-gate** — `resolveDevAgentGate(afmCfg?.enabled, ctx.config)`; off → `503`.
2. **Dependency check** — `ctx.enrollmentWizard` present, else `503`.
3. **id validation** — `req.params.id` against `^[a-z0-9-]+$` (the store's `ID_RE`);
   a mismatch → `404` (never echo a malformed id into a tmux target). The kill
   target is derived ONLY from the matched login's fields, never from the raw param.
4. **Resolve incl. terminal/expired** — `login = ctx.enrollmentWizard.getById(id)`.
   Not found → `404 { error: 'no pending login to cancel', id }` (the id is the
   caller's own validated input; no other store contents leaked).
5. **Idempotent terminal read** — if `login.status` is `completed` or `abandoned`:
   return `200 { enabled: true, cancelled: false, alreadyTerminal: true,
   terminalStatus: login.status, id }` — NO kill, NO transition. (`cancelled` is
   `false` here: a completed enrollment was NOT cancelled; only an actual abandon
   returns `cancelled: true`. This is the codex-external clarity fix.)
6. **Submit-in-flight guard** — if `followMeSubmitInFlight.has(id)`: `409 { error:
   'a sign-in is being completed for this login — try again in a moment' }`. This
   closes the TOCTOU with `submit-code`'s 30s credential-poll AND prevents killing
   the pane mid-credential-write (D3).
7. **Abandon (state first, D2)** — `ctx.enrollmentWizard.abandon(id)` → `abandoned`
   (the store terminal-guard makes this a no-op if somehow already terminal).
8. **Best-effort pane teardown (after state, D2)** — derive
   `paneSession = enrollPaneSessionName(login.framework, login.configHome)` (the
   SAME helper enroll-start spawns with, so the name can never drift), then
   `execFileSync(tmuxPath, ['kill-session', '-t', `=${paneSession}`], { stdio:
   'ignore' })` where `tmuxPath = ctx.config.sessions?.tmuxPath`. This is the RAW
   tmux teardown enroll-start itself uses (`server.ts:10713`) — **NOT**
   `sessionManager.killSession`, which is a confirmed no-op here (the enroll pane is
   a raw `tmux new-session`, never registered in SessionManager state, so
   `killSession` returns `false` and kills nothing). Wrapped in try/catch:
   `catch { /* @silent-fallback-ok: pane teardown is best-effort cleanup; abandon()
   is the authoritative state transition and already ran; a stale pane is
   pre-cleaned on the next enroll */ }`. A `tmuxPath`-absent or kill-failure does
   NOT fail the cancel. (`framework` is a constrained enum, so the tmux target has
   no injectable component; `configHome` is already char-clamped inside
   `enrollPaneSessionName`.)
9. **Respond** — `200 { enabled: true, cancelled: true, id, status: 'abandoned' }`
   (whitelisted fields only — never the full login object, so the `configHome` path
   is not disclosed).
10. **Observability** — `console.log('[follow-me] cancel outcome=<abandoned|
    already-terminal|not-found|submit-in-flight> id=<id> paneKilled=<bool>')`.

### Route: fronting relay `POST /subscription-pool/follow-me/cancel`

A near-verbatim copy of the `follow-me/submit-code` relay (`routes.ts:21406-21443`):
body `{ machineId, id }`; dev-gate; `selfId = ctx.meshSelfId ?? config.machineId ??
'local'`; self/absent `machineId` → loopback `baseUrl`, else
`ctx.resolvePeerUrls().find(machineId)` (unreachable → `502`); `fetch(
`${baseUrl}/subscription-pool/follow-me/enroll/${encodeURIComponent(id)}/cancel`,
{ Authorization: Bearer ${config.authToken}, ... })`; mirror the peer's status+body;
a fetch throw → `502 { error: 'could not reach the machine doing the login …' }`.
This is the route the dashboard calls, so one tap cancels a self OR peer cell.

### Dashboard: Cancel on the ◷ cell (`dashboard/subscriptions.js`)

The in-progress cell renders in TWO places; the button MUST be on the durable one:

- `renderAccountMatrix` rebuilds every cell on the poll loop. Its `in-progress`
  branch currently emits a bare glyph+word span (`~line 470-473`). Add a small,
  full-tap-target **Cancel** button to that branch, carrying `data-matrix-cancel`,
  `data-login-id="${accountId}"` (a matrix login's `id === accountId`, per the
  correlation at `~line 397`), and `data-machine-id="${machineId}"` (the cell
  already carries both, `~line 415`). Because it is re-emitted every render, it
  survives the poll refresh (the live `renderCellSignIn` DOM does not).
- Wire it through the existing delegated `wireMatrixSetup` listener — add a
  `data-matrix-cancel` branch alongside the three handlers at `~line 708-713`. On
  tap: `confirm('Cancel this in-progress setup?')`, then `postJson(URLS.cancel,
  { machineId, id: loginId })` where `URLS.cancel =
  '/subscription-pool/follow-me/cancel'` (the relay — no PIN, mirroring
  `URLS.submitCode`). On `200` re-render the cell empty; on `4xx/5xx` surface the
  route's plain-English error inline.
- **No PIN input** (D1): the relay is Bearer-only, exactly like the existing
  code-submit step, which posts to its relay without a PIN.

## Multi-Machine Posture (Cross-Machine Coherence)

**Proxied-on-write (relay).** A `PendingLogin` + its login pane physically live on
the machine running the `claude auth login` subprocess (cookies/pane on one disk).
The target-local `:id/cancel` is machine-local BY NECESSITY (it kills a local tmux
pane + abandons a local record). Cross-machine reach is delivered by the fronting
relay `follow-me/cancel`, which dispatches by `machineId` to self-loopback or the
owning peer over the authed mesh hop — the SAME proven pattern as
`follow-me/submit-code` and `start-cell`'s peer fan-out. The dashboard always calls
the relay, so a peer cell cancels correctly; an offline peer yields an honest `502`
("target machine not reachable — try again"), never a silent 404 or stale success.
No durable state strands on topic transfer (a `PendingLogin` is not topic-scoped).
No generated URL crosses a machine boundary.

## Test Plan (all three tiers)

- **Unit (`src/core/PendingLoginStore.ts`):**
  - `abandon()` of a `pending` → `abandoned`; of an `expired` (live) stored-pending
    → `abandoned`; of an unknown id → `null`.
  - terminal guard: `abandon()` of an already-`completed` login → returns it
    UNCHANGED (`completed`, version not bumped); `abandon()` of an already-`abandoned`
    → unchanged.
  - `issue()` with a same-id `abandoned`/`completed`/`expired` record → REPLACES it
    (new record, fresh `version`); with a same-id live-`pending` → still throws
    `"already exists"`.
  - `EnrollmentWizard.getById()` returns terminal/expired records; `abandon()`
    delegates.
- **Integration (HTTP pipeline, injected spy `sessionManager`/tmux + seeded store):**
  target-local `:id/cancel`: dark→`503`; happy (seeded pending)→`200 {cancelled:
  true, status:'abandoned'}` + assert the tmux `kill-session` was invoked with
  `=<derived-pane>`; idempotent second call→`200 {alreadyTerminal:true, cancelled:
  false}` + tmux NOT invoked again; unknown id→`404`; malformed id→`404`;
  submit-in-flight (pre-seed the `followMeSubmitInFlight` set)→`409` + no transition
  + no kill; expired login→`200 {cancelled:true}` + pane torn down. Relay
  `follow-me/cancel`: dark→`503`; self→forwards to loopback (assert `200`); unknown
  peer→`502`.
- **E2E "feature is alive":** against the real production-init server (mirroring
  `server.ts`) with `multiMachine.accountFollowMe` enabled, seed a pending login,
  `POST` the REAL relay route, assert `200` with `status:'abandoned'` (and that the
  route is REGISTERED — not `404 Cannot POST`). This is the Phase-1 alive test.

## Migration Parity (Standards)

- **Config:** no new key — the routes ride the existing `multiMachine.accountFollowMe`
  dark flag. `migrateConfig` needs nothing.
- **Dashboard:** `dashboard/subscriptions.js` ships WITH the npm package and is served
  from the package dir (`AgentServer.ts` `resolveDashboardDir`), so existing agents
  receive the new button on `pnpm update` — no file-copy migration, no hook/job/skill.
- **Agent Awareness (CLAUDE.md):** the account-follow-me capability paragraph exists
  in both `generateClaudeMd` (`templates.ts`) and `migrateClaudeMd`
  (`PostUpdateMigrator.ts`). Individual matrix routes are NOT documented (they are
  operator-dashboard mechanics, not agent-invoked APIs — submit-code/start-cell
  appear 0× in the template body). Add ONE clause to that existing paragraph
  ("…and cancel an in-flight cell from the grid") in BOTH the template and the
  content-sniffed migrator block, so the capability is known; no per-route docs.

## Rollback

Pure additive surface behind an existing dark flag. Back-out = `git revert` the PR
(two routes + two store tweaks + two wizard pass-throughs + dashboard button +
one-clause template text). The store changes are backward-compatible (the terminal
guard only PREVENTS a clobber that should never happen; the `issue()` replace only
RELAXES a throw). No data migration: `abandoned` is already a valid terminal state.
No agent-state repair. The auto-merger handles the merge; a bad merge is a single
revert.

## Open questions

*(none)*
