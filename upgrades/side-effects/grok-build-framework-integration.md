# Side-Effects Review — grok-build framework integration (Phase A)

**Version / slug:** `grok-build-framework-integration`
**Date:** `2026-08-15`
**Author:** Echo (autonomous, 24h run on topic 44867)
**Second-pass reviewer:** 22 review rounds (6 internal reviewers + external codex
family + one live grok-family pass). **NOT tooling-converged** — accepted on an
operator-directed 80/20 basis, 2026-08-15. See the spec's Convergence Status.

## Summary of the change

Adds `grok-build` (xAI's Grok CLI) as Instar's **fifth framework identity** and
**third cross-model reviewer family**, and threads that identity through the
surfaces a Grok-primary agent needs. 129 files, ~15.6k insertions.

**What ships live:** the reviewer door — one confined one-shot lane, gated on
`enabledFrameworks` containing `grok-build`.
**What does NOT ship:** interactive sessions, headless jobs, ACP, internal
routing, pool enrolment. The headless builder refuses BY NAME
(`grok-headless-cwd-ungated`) rather than running ungated.

## Blast radius — the honest scope, not the flattering one

The spec's invariant 5 enumerates **fourteen surfaces that change for every
agent regardless of opt-in**. That number was corrected four times during review
(four → six → a count fixed without its list → thirteen → fourteen), which is
itself the most-repeated defect of this branch. The list is now the count; no
prose restates it, and `tests/unit/grok-spec-surface-count-drift.test.ts` fails
the build if that regresses.

**The two highest-consequence entries for a non-opted-in agent:**
1. `codex-cli` / `gemini-cli` binary resolution changed for EVERY agent (round-16
   impersonation fence). A codex-pinned topic on a machine without codex on PATH
   moves from silently running Claude to disclosing a fallback. Correct
   direction; observable.
2. `instar route` and `instar reflect` now honour the agent's OWN configured
   framework instead of assuming `claude-code` (round-22). On a codex-only agent
   `reflect` was running on CLAUDE; it now runs on Codex. A fix, and a behaviour
   change for agents that opted into nothing.

**None of the fourteen registers the grok adapter or can start a grok session** —
verified in code, not inferred: `HEADLESS_BUILDERS` dispatches `grok-build` to a
builder whose body is comments and an unconditional throw, reached before any
process is created. **One (entry 11) can spend**, on a framework the caller names
explicitly: `POST /sessions/spawn` widened its accepted framework set, so a
`pi-cli` spawn that used to be a clean 400 now proceeds. That clause was stale
reassurance carried over from when the list was six, and is corrected in place.

## Decision-point inventory

- **Added — billing containment (§3.1).** Four INDEPENDENT mechanisms, none of
  which reads the session expiry: the forbidden-env sweep (refuses a metered key
  anywhere in the parent env, even beside a valid session);
  `buildGrokChildEnv`'s allowlist (strips billing vars, FORCES
  `GROK_DISABLE_API_KEY_AUTH=1` per spawn regardless of which check passed); the
  config-credential refusal; per-probe login-policy verification.
- **Added — confinement (§4.1).** Verified by side-effect probe, not by argument:
  a marked file in a scratch dir, asked back from grok. Under the shipped
  settings it is NOT readable; with restrictions removed it is (proving the probe
  works); an ordinary completion still returns normally (proving the restriction
  does not break the thing it protects). The earlier setting we shipped did
  nothing on this CLI version — that claim was retracted, then re-established
  with the mechanism that actually binds.
- **Changed — session-expiry admission (§3.1 item 3, round-22).** Refusal
  NARROWED from "expired" to "expired AND no renewal credential". Measured: the
  CLI renews lazily from a stored refresh token on the next auth-needing command,
  so refusing on bare expiry blocked the only call that would renew it — a
  self-sustaining outage, not a safe failure. Both decision points carry the
  conjunct (the transport preflight AND `detectGrokReviewer`, which runs first);
  fixing only the former left the deadlock fully intact.
- **Changed — binary resolution (§2.0), TEN sites.** No framework label may
  resolve to another framework's binary, in either direction. On a grok-primary
  agent `sessions.claudePath` HOLDS THE GROK BINARY (documented back-compat
  carry), so every site pairing that field with a `claude-code` label ran one
  framework's program under another's name. Ten sites across rounds 15-22;
  `tests/unit/claudepath-impersonation-sweep.test.ts` now fails the build on an
  eleventh, with zero exemptions.
- **Declined — quota participation.** grok reports quota `unknown`, never
  healthy, and is excluded from automatic internal routing and the failure-swap
  tail. Its weekly pool is unreadable, so an unobservable allowance must not fund
  background traffic.
- **Declined — the API path (§0.5).** Not on cost grounds: the CLI authenticates
  by subscription session with no key, so the review door can refuse key-based
  auth STRUCTURALLY rather than by policy; and the API path cannot deliver an
  agent that RUNS on grok.

## Framework generality

Every change is written against the framework UNION, not against grok
specifically. The compiler enforces this at six `Record<IntelligenceFramework, …>`
maps (launch builders, headless builders, injection process names, activity and
process signals, parity renderers) — a sixth framework cannot be added without
supplying each. `EscalationFramework` was a duplicate union reached through three
`as` casts, so drift there was invisible; it is now an alias of the canonical
union, making omission a compile error. Three alias tables became one. Four
hand-written framework lists now derive from the canonical list.

## Operator surface quality

- Refusals name themselves (`grok-headless-cwd-ungated`,
  `grok-auth-apikey-forbidden`, `grok-login-policy-unverified`,
  `grok-not-authed`) rather than surfacing as ENOENT or generic failure.
- A grok-primary agent installs WITH an instructions file (it previously got
  none — the file was written only when Claude was enabled).
- **Known gap, stated rather than papered over:** no attention item is raised on
  a terminal auth expiry. Detection exists; the raise is not built. The operator
  learns of a dead session from the refusal. Carrier: CMT-1325.

## Class-Closure Declaration

**`unbounded-self-action` → `n/a`.**

Verified rather than asserted: the grok adapter adds **no scheduler job, no retry
controller, and no respawn path**. Every timer it introduces is a single-shot
bound INSIDE one call — the spawn-slot poll (bounded by the acquire budget), the
call timeout, and the escalating SIGTERM→SIGKILL grace in `grokHardKill` — and the
error contract forbids the loop explicitly (`errors.ts`: *terminal for the call;
the caller must not blind-retry*).

Every action in this change is initiated by an explicit caller: the reviewer lane
runs when a reviewer invokes it, and round-22's auth-admission change NARROWS a
refusal rather than scheduling anything. There is no self-triggered controller
here to prove convergence for, which is why the honest declaration is the negative
one and not a `guard` citation I would have had to invent a ratchet for.

## Rollback

`enabledFrameworks` without `grok-build` returns the adapter to dark: no
registration, no reviewer door, no spawn path. The fourteen enumerated surfaces
are NOT rolled back by that — they are code-borne and unconditional, which is
precisely why they are enumerated. Reverting the commit reverts them.

## Testing

Full suite green at 3,090 files / 48,629 tests on the tree carrying rounds 1-22
(2026-08-15 12:24 PDT). Later runs showed only load-shaped failures — resource
envelopes and connection timeouts in files this change never touches, each
passing in isolation, a different file each run.

Nine grok-specific test files across all three tiers, plus the class-level checks
added in round 22. **Every fix in the final rounds carries a control that fails
without it** — verified by restoring the pre-fix code and confirming the intended
test (and only that test) goes red. The concurrency proof runs twelve real
processes behind a start barrier; its control was flaky under load and is now
deterministic, verified passing INSIDE a full-suite run rather than only on an
idle machine.

## What a reader should not conclude

Twenty-two rounds each found real defects, most inside the previous round's
fixes. The honest prior is that more exist. This artifact records what was
verified and how; it is not a claim of completeness, and the spec's Convergence
Status says so in the same words.
