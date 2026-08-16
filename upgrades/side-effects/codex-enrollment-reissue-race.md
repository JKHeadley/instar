# Side-Effects Review — Codex enrolment: stop re-asking a sign-in that already succeeded

**Version / slug:** `codex-enrollment-reissue-race`
**Date:** `2026-08-16`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `Echo — self-review, NOT independent (see "Second-pass review" below for why, and what that costs)`

## Summary of the change

A Codex subscription enrolment looped forever: 33 device codes issued for one sign-in between
01:00Z and 09:21Z on 2026-08-16, still running when found. Three separate defects compound into
that loop, and this change fixes all three.

1. **The isolation variable was one the CLI does not read.** `src/commands/server.ts`'s enrolment
   `spawn` gave every non-grok, non-claude framework `CLAUDE_CONFIG_DIR`. Codex reads `CODEX_HOME`.
   Verified against the CLI rather than assumed: `CLAUDE_CONFIG_DIR=<empty dir> codex login status`
   reported *"Logged in using ChatGPT"* (variable ignored, ambient home read), while
   `CODEX_HOME=<empty dir> codex login status` reported *"Not logged in"*. So every instar-started
   Codex sign-in ran against the machine's real `~/.codex` while the pool recorded an isolated
   `configHome` — the mechanism behind the operator's earlier "enrolment signed me out of Codex".
   The existing round-12 comment already stated the correct rule ("a framework with no known
   isolation var gets NONE rather than a misleading one"); the code's final `else` branch handed out
   `CLAUDE_CONFIG_DIR` anyway, and its two trailing ternary branches were identical — a dead branch
   that is itself evidence the intent was never expressed.
2. **Nothing detected success.** `complete()` is reached only from HTTP routes. A `url-code-paste`
   flow (Claude) ends with the operator pasting a code back through the dashboard, which hits such a
   route. A `device-code` flow (Codex, grok) does not: the operator approves at the provider, the CLI
   writes its own credential and exits, and instar is never told. The record stayed `pending` forever.
3. **Every re-drive destroys the pane.** The enrolment `spawn` does `tmux kill-session` on the
   deterministic pane name before `new-session`, and all three reissue triggers (`reissueExpired`,
   `recoverAfterRestart`, `refresh`) funnel through `driveLogin`. So the process waiting for the
   operator's approval was killed on every sweep.

Together: operator approves → nothing notices → TTL elapses → listener killed → new code → repeat.

Files touched: `src/core/FrameworkLoginDriver.ts` (new pure `enrollmentIsolationEnv` +
`enrollmentCredentialPath`), `src/core/EnrollmentWizard.ts` (new injected `credentialWitness` +
`completedWithoutTelling` guard in `reissueLogins`), `src/commands/server.ts` (wire both), plus unit
and integration tests.

## Decision-point inventory

- `EnrollmentWizard.reissueLogins()` — **modify** — gains a precondition: a login whose credential
  already exists in its slot is completed instead of re-driven. This is the loop's missing
  terminating condition.
- `EnrollmentWizard.completedWithoutTelling()` — **add** — the detector answering "did this login
  already succeed?". Detector only; it never blocks a user action.
- enrolment `spawn` isolation env (`src/commands/server.ts`) — **modify** — per-framework mapping
  moved to `enrollmentIsolationEnv`; `codex-cli` corrected to `CODEX_HOME`; frameworks with no
  verified isolation variable now get none instead of a misleading one.

---

## 1. Over-block

**No block/allow surface — over-block not applicable** in the user-facing sense: this change rejects
no input and blocks no message, action, or session.

The nearest analogue is a *false completion*: wrongly deciding a sign-in succeeded would mark an
account enrolled that never signed in, and leave the operator holding a dead code with no fresh one
coming. Three properties bound it:

- The credential must be **newer than the login's own `createdAt`**. A slot still holding the
  previous account's credential — the re-enrolment case — reads as older and is not success. Pinned
  by `does not mistake a credential that was already in the slot for this sign-in`.
- Only `device-code` flows are witnessed. `url-code-paste` (Claude) is untouched, which matters
  because a Claude slot's `.credentials.json` is rewritten by ordinary token refresh; an mtime bump
  there could plausibly not be this flow. Pinned by `leaves a url-code-paste flow entirely alone`.
- `enrollmentCredentialPath` returns null for any framework whose credential location instar has not
  verified, so no guessed path can produce a false witness.

---

## 2. Under-block

**What this still misses:**

- **A credential written by something other than this flow, inside the flow's window.** If an
  operator manually runs `codex login` in the same slot while an instar enrolment is pending, the
  enrolment is marked completed on that credential. The outcome is benign — the slot genuinely holds
  a working credential and the pool row points at it — but the enrolment is credited with a sign-in
  it did not drive.
- **Which account signed in is not checked.** The witness proves *a* credential appeared, not that
  it belongs to the expected email. The follow-me path already has that gate (`completeFollowMe`'s
  S7 email check via the identity oracle); the plain `complete()` path this change uses does not, and
  this change deliberately does not add one — widening `complete()`'s contract is a larger change
  than the loop fix, and the loop is actively burning the operator's real Codex login today.
- **Timing granularity.** The comparison is `mtime >= createdAt` at whole-millisecond resolution. A
  credential written in the same millisecond as the login record would read as success. Not
  reachable in practice (a device-code flow takes seconds at minimum) and it fails toward the
  *correct* answer anyway.
- **The pane is still killed for a genuinely-expired login.** That is intended: an expired code has
  nothing to preserve.

---

## 3. Level-of-abstraction fit

The witness is a **detector at the lowest layer that can answer the question**: one `stat` of a known
file. It is deliberately not an authority — it does not decide whether an operator may enrol, and it
does not gate a route.

The layering choice worth defending is *where the framework knowledge lives*. Both the isolation
variable and the credential path are per-framework facts, and instar already knew them in scattered
places (`crossModelReviewer`, `codexHookArm`, `codexSpawn`, `ThreadlineBootstrap` all use
`CODEX_HOME`; `OAuthRefresher` knows Claude's `.credentials.json`). The enrolment spawn was the one
place that did not, which is exactly how it drifted. Putting both facts in
`FrameworkLoginDriver.ts` next to the existing `enrollPaneSessionName` single-source-of-truth helper
keeps the mapping in one testable place rather than inline in a 20k-line `server.ts`, and the two
helpers are constructed to mirror each other: the credential lands where the isolation env points.

A lower primitive was considered and rejected: reusing `readCodexSlotIdentity`
(`src/providers/adapters/openai-codex/codexSlotIdentity.ts`), which parses `auth.json` and returns
the account identity. It answers a richer question than the loop needs, costs a parse, and would
couple the wizard to a provider adapter. Existence + mtime is the whole question here.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No — this change has no block/allow surface.** The witness is a detector whose only effect is
  to *withhold a destructive self-action* (kill-pane + mint-new-code). It grants nothing, blocks no
  operator action, and gates no message.

The direction of failure is the load-bearing property. Every uncertainty — no witness wired, absent
credential, unreadable slot, probe throws, unparseable timestamp, non-`device-code` flow — returns
`false`, which is byte-for-byte the previous behaviour. A brittle detector holding block authority is
the anti-pattern; here brittleness can only ever cause the *old* behaviour to persist, never a new
refusal. The `it.each` case `re-drives exactly as before when …` pins all three uncertainty paths.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**No new static heuristic at a competing-signals decision point.** "Does a credential exist in this
slot, newer than this flow?" is an enumerable factual question with a filesystem answer, not a
weighing of competing live signals. There is no scenario where evidence pulls both ways and a
judgment call is needed: the file is there and newer, or it is not. The one genuinely ambiguous case
(a credential written by a concurrent manual login) is documented under Under-block rather than
papered over with a heuristic.

---

## 5. Interactions

- **Shadowing:** the guard runs *before* `driveLogin` inside `reissueLogins`, so on the success path
  `driveLogin` and `store.reissue` never run. That is the point. Nothing downstream depends on a
  re-drive having happened — `reissueLogins` returns the reissued list, and callers treat an empty
  list as "nothing needed refreshing", which is now true in one more case. The three callers
  (`reissueExpired`, `recoverAfterRestart`, `refresh`) all funnel through this one method, so the
  fix covers the TTL sweep, the boot recovery, and the dead-pane path together — deliberately, since
  a server bounce re-driving a succeeded login is the same defect wearing a different trigger
  (pinned by `protects the restart-recovery and dead-pane paths too`).
- **Double-fire:** `complete()` is idempotent at the store layer — `transition()` refuses to move a
  record that is already `completed`/`abandoned`. If the paste-back route and the witness both fire
  for the same login, the second is a no-op.
- **Races:** the witness only reads the filesystem; it holds no state and mutates nothing. The
  subsequent `complete()` goes through the store's existing transition path, unchanged. A login
  cancelled concurrently is `abandoned` (terminal) and `expired()`/the non-terminal filters exclude
  it, so it never reaches the witness.
- **Feedback loops:** this **removes** one. The reissue sweep was a self-triggered controller with no
  terminating condition reachable by the event it was waiting for. Completion is terminal, so a
  completed login leaves the sweep's input set permanently. See the Class-Closure Declaration.
- **`refresh()` and the submit-code route:** the route calls `refresh(id)` when it finds a dead pane
  and returns `login-expired-fresh-ready`. A pane that died *because the login succeeded* now
  completes instead, so `refresh()` returns null and the route answers `410 login-expired` rather
  than handing the operator a fresh code for an account already signed in. That is the more honest of
  the two answers, though the wording ("start a fresh sign-in") is now slightly off for that case —
  noted for follow-up rather than silently reworded here, since the message is shared with the
  genuinely-expired path.

---

## 6. External surfaces

- **Other agents / install base:** the isolation-variable correction changes the *environment of the
  spawned login process* on every install that enrols a Codex account. This is the intended fix, and
  it is strictly more correct: previously the credential landed in the ambient home regardless of
  what the pool recorded.
- **External systems:** no change to any provider API call, no new network traffic. The witness is
  one local `stat`.
- **Persistent state:** no schema change. A login that would previously have sat `pending` forever
  now reaches `completed` — a status the store already defines and terminates on.
- **Timing we do not control:** the witness depends on the CLI having flushed its credential to disk
  before the sweep reads it. If it has not, the sweep re-drives exactly as before and the next sweep
  catches it. Late is handled; wrong is not introduced.
- **Operator surface (Mobile-Complete):** no operator-facing action added or changed. The operator's
  path is unchanged — the enrolment card, its code, and its Cancel button all behave as before. What
  changes is that a card stops re-issuing codes once its sign-in has landed, which is the behaviour
  the surface already implied.

---

## 6b. Operator-surface quality

**No operator surface — not applicable.** No dashboard renderer, markup file, approval page, or
grant/revoke/secret-drop form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, and the reason is the whole point of the feature: a credential is a file
on one machine's disk. A sign-in completed on the Mini writes the Mini's `~/.codex`; whether it
happened is not a question another machine can answer, and must not be. Witnessing a peer's slot
would be both wrong (the file is not there) and unsafe (it would let one machine mark another's
enrolment complete).

The enclosing pending-login record is likewise machine-local — it is created by, and drives, a tmux
pane on one machine. The pool-wide question ("which accounts exist across my machines?") is already
answered by the existing proxied-on-read `GET /subscription-pool?scope=pool` and the account×machine
matrix, neither of which this change touches.

- **User-facing notices:** none emitted. No one-voice gating needed.
- **Durable state on topic transfer:** the pending-login record is not topic-scoped and does not ride
  a topic move; unchanged by this work.
- **Generated URLs:** none. The verification URL comes from the provider via the pane scrape, exactly
  as before.

Verified against the live pair while diagnosing: the laptop and the Mini each hold their own Codex
slots at different paths, and the stuck login existed on exactly one of them.

---

## 8. Rollback cost

- **Hot-fix release:** revert the three source files and ship as a patch. Pure code change.
- **Data migration:** none. No new fields, no schema change.
- **Agent state repair:** none required. The one state effect is that some pending logins reach
  `completed` — a pre-existing terminal status. A reverted build would simply stop detecting success
  and resume re-driving, i.e. the old bug returns; nothing needs undoing.
- **User visibility:** none during the rollback window. The Codex isolation variable would revert to
  the wrong one, which is the status quo ante rather than a new regression — though it is worth
  stating plainly that reverting *re-arms* the behaviour that signs an operator out of their default
  Codex login, so a revert should be paired with disabling Codex enrolment rather than done blind.

---

## Conclusion

The review changed the design twice. First, the witness was initially scoped by *framework*
(codex-cli, grok-build); working question 1 surfaced that the real discriminator is the **flow kind**
— `device-code` completes in the CLI with no paste-back, `url-code-paste` completes through a route
that already calls `complete()` — so the guard is now keyed on `login.kind`, which is both narrower
and framework-agnostic. Second, question 1 surfaced the re-enrolment false-positive (a slot still
holding the previous account's credential), which produced the `mtime >= createdAt` comparison and
its dedicated test; without that the fix would have marked stale slots enrolled on sight.

Two honest residuals are recorded rather than resolved: the witness does not verify *which* account
signed in (Under-block), and the `refresh()` route's shared "start a fresh sign-in" wording is now
slightly off for the already-succeeded case (Interactions). Neither blocks shipping; both are
narrower than the loop that is currently burning the operator's real Codex login every fifteen
minutes.

Clear to ship, with the second-pass caveat below stated plainly rather than waived.

---

## Second-pass review (if required)

**Required?** Yes — this change touches session lifecycle (the enrolment pane's spawn/kill) and
modifies a self-triggered controller, both of which the skill lists as second-pass triggers.

**Reviewer:** Echo — **self-review, not an independent one.**

**Why:** this session runs under a standing operator instruction not to spawn subagents unless
explicitly requested. Rather than quietly record `not-required` (which would be false) or spawn one
anyway, the constraint and its cost are stated here: the artifact has had no genuinely independent
read, so the specific failure mode a second pass exists to catch — the author's own blind spot —
remains uncovered. The PR is therefore the real review surface for this change, and a reviewer should
weight questions 1, 2, and 5 accordingly.

**Self-review findings** (applied above, not merely noted): the flow-kind rescope and the
re-enrolment false-positive guard both came out of this pass. The residual I am least confident about
is the concurrent-manual-login case in Under-block; I judged it benign, and a second reader should
check that judgment rather than inherit it.

---

## Evidence pointers

- Empirical proof of the isolation-variable defect (run against the real CLI on the laptop, 2026-08-16):
  `CLAUDE_CONFIG_DIR=<empty dir> codex login status` → *"Logged in using ChatGPT"*;
  `CODEX_HOME=<empty dir> codex login status` → *"Not logged in"*.
- The live loop: pending login `codex-justin`, `reissueCount` 33, `createdAt` 01:00:19Z, still
  `pending` at 09:21Z with a 15-minute TTL.
- Negative check: inverting `completedWithoutTelling`'s comparison fails exactly the three
  behavioural tests (completion, re-enrolment guard, restart path) and nothing else — the tests fail
  for the reason they exist.
- `tests/unit/framework-login-driver.test.ts` (26 passing), `tests/unit/enrollment-wizard.test.ts`
  (44 passing), `tests/integration/subscription-enrollment-routes.test.ts` (12 passing); full
  enrolment surface 107 passing.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `guard`
- **`guardEvidence`** —
  - **enforcementType:** `ratchet`
  - **citation:** `tests/unit/self-action-convergence.test.ts`; guard implemented at
    `src/core/EnrollmentWizard.ts#completedWithoutTelling`, applied in `reissueLogins`
  - **howCaught / convergence argument:**
    - **Control-loop edge:** the reissue sweep re-drives every non-terminal pending login whose TTL
      has elapsed, on a 5-minute timer, plus once per server boot.
    - **Steady-state bound:** previously **unbounded** — the loop waited on an event (the operator
      approving) that it could observe no way, so the event's occurrence did not terminate it;
      33 iterations were observed and it had no stopping state. The loop now has a terminating
      condition reachable by the very event it waits for: the credential appearing moves the record
      to `completed`, which is terminal, so it leaves `expired()` and the non-terminal recovery set
      permanently. Steady state is one completion, then zero further iterations.
    - **Settling brake:** completion is a terminal store transition (`PendingLoginStore.transition`
      refuses to move a `completed`/`abandoned` record), so the login cannot re-enter the loop. The
      brake engages only on positive evidence — every uncertainty returns `false` and preserves the
      prior re-drive behaviour — so the brake can stall the loop's *destructive* action but can never
      itself become a new unbounded action.
