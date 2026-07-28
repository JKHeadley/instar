---
title: "Never a False Blocker — constitution standard + B17 structural guard"
date: 2026-05-24
author: echo
review-convergence: internal-adversarial-2026-05-24 (two parallel reviewers — instar-standards conformance + correctness/gameability — plus a manual MEMORY.md lessons-grep; revised for VALID_RULES registration, B16/B17 straddle, hollow-inventory guard, allowlist completeness, and "second opinion" over-breadth. External multi-model /crossreview round NOT run — the branded command is not wired on this checkout; offered to Justin as an optional pre-code add.)
approved: true
approved-by: Justin
approved-via: Telegram topic 12896 (2026-05-24/25 — approved the design direction "reuse the existing reviewer as decider, ship hold-and-redirect", then approved the full converged spec: "Yes" at 2026-05-24 23:43 PDT)
eli16-overview: never-a-false-blocker-standard.eli16.md
---

# Never a False Blocker — standard + B17 structural guard

## Problem

A recurring gravity well: when I hit friction, I reach for a blocker-flavored excuse —
"this needs a human", "I can't do this", "blocked pending you", "I'd want a second
opinion first", "this needs reverse-engineering" — and I **stop**, handing the wall
back to the user. The insidious part is that it wears responsible clothing. It sounds
like prudence, humility, or proper escalation, so it slips past my own guard. It is the
deference-shaped cousin of the "hit a wall" surrender.

The truth the user keeps having to repeat: I have full access to this machine —
computer use (I can read the screen and click buttons), terminal control, the dashboard,
send-keys into live sessions, every MCP tool. So almost **nothing** is a genuine
human-only blocker. The genuinely human-only set is *tiny*: a password only the user
knows, a CAPTCHA, a legal/billing/payment authorization, and a value judgment that is
the user's to make. Everything else is within my own means.

**The triggering incident (2026-05-24, codex-parity work).** I found that Codex only
runs a safety guard a human has "trusted" by clicking a prompt, and concluded: "#1 fix —
but it needs a human to click, and the durable fix needs reverse-engineering, so I want a
second opinion." Three blocker-flavored excuses stacked in one sentence. The user pointed
out the obvious: I was *literally looking at* Codex's own "Press t to trust all" prompt in
the dashboard I had open, and I have computer use. So I drove a real interactive Codex
session, hit the prompt, selected "Trust all and continue", and armed a previously-dark
guard myself — no human. The wall was a hypothesis; testing it took one keystroke.

## Relationship to "A Wall Is a Hypothesis" (B16)

This is the **sibling** of `B16_UNVERIFIED_WALL` ([[wall-is-a-hypothesis-standard]]),
not a duplicate. The two catch different surrenders and must be de-conflicted precisely so
they neither overlap-block (double jeopardy) nor leak the case between them:

- **B16 — feasibility verdict.** "This *can't be built / done / automated* because some
  *interface / API / mechanism is missing*." The wall is a claim about whether a mechanism
  exists. B16 deliberately **lets human-deference pass** — its severity note says plainly
  *"'I can't access X without you connecting it' must pass."*
- **B17 — false human-deference (this spec).** "This *needs a person* — a human / you / an
  expert / a second opinion — rather than me," when the task is within my own toolkit
  (computer use, terminal, send-keys, MCP, dashboard). The wall is a claim about *who* must
  act, not about whether a mechanism exists.

Litmus test for which rule applies: *Does the message say a mechanism is missing (→ B16) or
that a person is required (→ B17)?* The codex-trust incident is the canonical B17 case —
the mechanism existed (a keystroke), but I claimed a human was required to make it.

Both rules live in the same authority and favor false-negatives, so a message that
genuinely straddles is allowed to pass under either rather than double-blocked.

## Scope

Three coordinated pieces, mirroring the B16 change:

1. **Constitution entry** — add the standard "Never a False Blocker" to
   `docs/STANDARDS-REGISTRY.md` in The Substrate family, adjacent to "A Wall Is a
   Hypothesis", and register it in `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (the
   catalog the `/spec-converge` lessons-aware reviewer actually loads). Authored in the
   registry's format (Rule / In practice / Earned from / Traces to the goal / Applied
   through), per the registry's amendment loop (agent proposes with its story, operator
   ratifies).

2. **Structural guard — authority tier (`B17_FALSE_BLOCKER`)** — a new rule in
   `MessagingToneGate`, the existing outbound-message authority that already hosts
   B15_CONTEXT_DEATH_STOP and B16_UNVERIFIED_WALL. Like B15/B16, B17 is **always
   evaluated** (no signal/kind precondition). It holds an outbound message that defers a
   task to a human / second opinion / reverse-engineering when the message shows no
   evidence the agent enumerated its own means first, unless the deferral names a
   genuinely-human-only item.

   **Required code edits (do not omit — the gate fails open otherwise).** Adding the
   prompt text alone is not enough. `B17_FALSE_BLOCKER` MUST also be registered in:
   - the `VALID_RULES` set (`MessagingToneGate.ts` ~lines 45–61) — otherwise the gate's
     own drift guard treats a B17 citation as an invented rule id and **fail-opens**, so
     B17 would silently never block;
   - the prompt's closing rule-id allowlist (~line 359: *"rule MUST be one of
     B1–B9, B11…B16 exactly"*) — add B17 there;
   - the `ToneReviewResult` doc comments (~lines 27, 41, which say "B1..B16") — bump to B17
     for consistency.
   The unit tier asserts "B17 accepted without fail-open", which exercises this — but the
   edits are listed here so implementation cannot miss them.

3. **Signal tier (deferral-detector extension)** — extend the existing
   `.instar/hooks/instar/deferral-detector.js` PreToolUse hook to recognize the two
   excuse-shapes from the triggering incident that it currently misses — "second opinion"
   and "reverse-engineering"/"needs a human to click/press" — so its advisory checklist
   primes the inventory *before* the message is composed. The detector remains
   **signal-only** (injects `additionalContext`, never blocks), per signal-vs-authority.

## Design — B17_FALSE_BLOCKER

**Block condition (all must hold):** the candidate defers a task to a human, a second
opinion, or reverse-engineering (claims the agent itself cannot/should-not do it) AND the
deferral rests on the *need for a person/expert* rather than a verified-missing mechanism
AND the message shows **no evidence the agent inventoried its own means** AND none of the
legitimate clauses below is present.

**Genuinely-human-only allowlist (any one → pass).** This is the *tiny* set the standard
names. A deferral that points at one of these is honest escalation, not a false blocker:

- A **secret only the user holds** — a password, passphrase, or 2FA code the agent has no
  way to obtain (and cannot collect via Secret Drop because it is the user's personal
  credential, not a service key).
- A **CAPTCHA / human-presence challenge** explicitly designed to exclude automation.
- A **legal / billing / payment / contractual authorization** — spending money, signing,
  accepting terms, granting account access.
- A **value or policy judgment that is the user's to make** — "do you want to ship X or
  Y?", "is this tradeoff acceptable?", a priority/taste/risk-appetite call. Asking the
  user a real decision question is *required* behavior, not a false blocker.
- An **explicit approval the agent is required to obtain** — anything the side-effects
  gate, an external-operation gate, or org policy says needs the user's sign-off before
  it runs (a risky/irreversible action, a deploy the user gated). Pausing to get required
  approval is compliance, not surrender.
- An **account / access grant only the user can make** — connecting a service, granting
  OAuth, adding the agent to a workspace the user administers. (B16 carries this same
  carve-out; B17 must too, since B17 is the rule that fires on "needs you".)
- A **physical-world action** the agent cannot perform (plug in a cable, restart hardware).
- An **external rate-limit / quota / cooldown wait** — "I'm rate-limited, retrying in
  10m" is a genuine timed external constraint, not a deferral to the user. (It should also
  be backed by an actual retry mechanism, but it is not a B17 false blocker.)

**Other legitimate clauses (any one → pass):**

- The message shows a **capability inventory was done** and the deferral survived — and it
  names *specific outcomes*, not just a list of tool names. "I tried send-keys into the
  Codex pane (the prompt didn't advance) and computer-use on the button (it's disabled
  until you authenticate) — so I need your password" passes; a bare "I tried computer-use,
  send-keys, and the API, but this is really your call" does **not** (that is a hollow
  inventory — see the gameability note below). A wall reported after a *substantive*
  inventory is honest engineering.
- The message reports a **genuine runtime error / blocker** — a tool, API, or system call
  that actually failed (not a soft preference to defer).
- The message proposes **getting a second opinion the agent will itself fetch** — e.g.,
  "let me run this spec past GPT/Gemini via cross-model review." Seeking cross-model review
  is *endorsed* instar practice ([[feedback_external_crossmodel_catches_what_internal_misses]]).
  B17 fires on "second opinion" ONLY when it is paired with **handing the task to the
  user / stopping** ("I'd want a second opinion before I can proceed — over to you"), not
  when the agent names another agent/model it will itself invoke and continue.
- The message merely **discusses this rule** or the concept of false blockers (a memo, an
  explanation, this very text), rather than being a live surrender.

**Gameability limit (stated honestly).** Like B16, B17 sees only the candidate text — it
cannot verify that a claimed inventory actually ran. A determined fabrication ("I tried
everything, it's your call") can still pass, just as a fabricated B16 inventory can. The
mitigations are partial and deliberate: requiring *named outcomes* (not just tool names)
raises the cost of faking, and a canary known-bad (a bare tool-name list with no outcomes)
guards against prompt drift loosening the bar. We accept the residual hole rather than
pretend the carve-out is airtight — the alternative (demanding machine-verified tool traces
inline) is disproportionate machinery for a false-negative-favoring rule.

**Severity: favor false-negatives over false-positives.** This is the same posture as B16.
Genuine escalations — value judgments, password requests, verified external limits — MUST
pass. The rule targets only the precise failure: a task deferred to a person/second-opinion
when the agent never inventoried the means it already has.

### De-confliction from B15 and B16

- **vs B15 (context-death stop):** B15 catches stopping in-flight work for a
  *context-window / fresh-session* reason. B17 catches deferring to a *human/expert*. A
  message can trip neither, one, or — in principle — be checked against both; because all
  three favor false-negatives and the gate cites a single rule id, there is no
  double-block. Where a message is ambiguous between B15 and B17, the gate cites whichever
  it judges primary; the outcome (held, with a redirect) is identical.
- **vs B16 (unverified wall):** the litmus is *missing mechanism → B16; person required →
  B17.* **The straddle is the dangerous case and must NOT fall in the gap.** The canonical
  false blocker fuses both — "there's no API to do this, so a human has to" — and a naive
  hand-off ("if it's about a missing interface, that's B16's domain") would let each rule
  cede to the other while B16's allowlist *passes* human-deference, dropping the strongest
  false blocker between them. The B17 prompt therefore instructs explicitly: **if a message
  claims BOTH a missing mechanism AND that a person is required, evaluate the
  person-required half under B17 — do NOT cede the whole message to B16.** The "no API so a
  human must" sentence blocks under B17 (it is a B17 unit + canary fixture).
- **Citation precedence (deterministic).** When more than one of B15/B16/B17 would *each
  independently block* the same message, the prompt fixes the order **B15 > B16 > B17** so
  the gate cites one rule deterministically rather than arbitrarily. This is distinct from
  the straddle: the straddle is not a precedence conflict because B16 *passes* human-
  deference (its allowlist) while B17 *blocks* it — only B17 blocks, so only B17 is cited.
  Precedence only stabilizes the id when two rules genuinely both want to block; the
  user-visible outcome (held + redirect) is identical either way.

### Why MessagingToneGate (signal-vs-authority compliance)

B17 lives inside the single outbound authority, not in a detector with independent block
power. The `deferral-detector.js` extension raises a *flag* (advisory checklist, and —
optionally, for telemetry — a structured `falseBlocker` field on `ToneReviewSignals`); the
**authority** combines the candidate with full conversational context and makes the one
block/allow decision. This matches the principle ([[feedback_signal_vs_authority]],
`docs/signal-vs-authority.md`) and mirrors exactly how B16 shipped.

**Refinement vs. the approved sketch (flagged, not silent).** When I pitched this to the
user I described "a cheap detector that raises a flag, and the reviewer decides." The B16
precedent shows the authority can evaluate the rule *always*, with no gating signal —
strictly simpler and more robust than making the detector a required precondition (a missed
keyword would otherwise let a false blocker through). So B17 is an **always-evaluated**
prompt rule (like B16), and the detector becomes *priming + observability* rather than a
necessary trigger. This is a deliberate improvement on the sketch, called out here so the
choice is conscious. Net machinery added is *smaller* than the sketch, honoring "reuse,
least new machinery."

### First-ship behavior: hold-and-redirect

Per the user's call ("I lean hold"), B17 ships **holding**: a blocked message returns the
native gate behavior — HTTP 422 on `POST /telegram/reply` with the rule id and a suggestion,
the message is **not** sent, and I revise (enumerate my means, try them, and either do the
work or re-state the deferral against the allowlist). The route plumbing (gate block → 422
with rule id) is rule-agnostic and unchanged. An `observeOnly` escape hatch already exists on
the gate config for emergency softening; we ship holding, not observing.

## Migration parity

- **`MessagingToneGate` (authority)** — server-side; not an agent-installed file. The B17
  rule ships with the server on update. No `PostUpdateMigrator` entry required (same as
  B16).
- **`deferral-detector.js` (signal)** — a built-in hook under `.instar/hooks/instar/`,
  which the migration path **always overwrites** on every update (CLAUDE.md Migration
  Parity rule #4 — built-in hooks are never install-if-missing). The new patterns therefore
  reach existing agents automatically on their next update. Verify the hook is in the
  always-overwrite set during implementation; add no separate migrator entry.
- **Doc changes** (`STANDARDS-REGISTRY.md`, `INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`) are
  repository documentation, read by humans and the `/spec-converge` skill — not deployed
  per-agent.
- **No new config flag.** B17 is on by default like its sibling B-rules; there is no
  per-rule toggle, consistent with the existing gate design ("least new machinery").

## Testing (three tiers + canary)

- **Unit** (`tests/unit/messaging-tone-gate-b17.test.ts`):
  - The rule definition, the deference markers, and the allowlist/legitimate carve-outs
    render in the assembled prompt.
  - `B17_FALSE_BLOCKER` is accepted as a valid rule id without fail-open (drift guard: an
    invented rule id still fails open).
  - **Block side:** the codex-trust message ("needs a human to click, needs
    reverse-engineering, want a second opinion") blocks with B17.
  - **Pass side (every carve-out):** password-only deferral passes; CAPTCHA passes; a real
    value-judgment question ("ship X or Y?") passes; a required-approval pause passes; an
    account/access-grant request passes; a rate-limit/quota wait passes; a deferral *after a
    substantive inventory with named outcomes* passes; a self-fetched cross-model "second
    opinion" ("let me run this past GPT") passes; a genuine runtime-error report passes;
    rule-discussion passes.
  - **De-confliction + straddle:** a pure missing-mechanism message routes to B16 (not
    double-blocked under B17); a context-window stop routes to B15; **the fused straddle
    ("there's no API, so a human has to do this") blocks under B17** (does not slip through
    B16's human-deference allowlist).
  - **Hollow-inventory guard:** a bare tool-name list with no outcomes ("I tried
    computer-use, send-keys, and the API, but it's your call") still blocks; only a
    named-outcome inventory passes.
- **Integration** (`tests/integration/telegram-reply-b17-false-blocker.test.ts`): through the
  real `POST /telegram/reply` route, a B17 block returns 422 with `rule="B17_FALSE_BLOCKER"`
  and the message is not sent; a passing reply still delivers 200.
- **E2E:** the tone-gate authority's production HTTP path is already exercised by the existing
  tone-gate route tests; B17 rides that path (always-evaluated, no new route), and the
  integration tier proves the rule surfaces through it.
- **Canary** (`POST /review/canary` fixtures): add as known-bads that must block — the
  codex-trust false-blocker, the fused straddle ("no API, so a human must"), and the hollow
  one-line inventory ("I tried things, your call"); add as known-goods that must pass — a
  password-only escalation, a value-judgment question, and a self-fetched cross-model
  "second opinion". This guards against prompt drift loosening either edge.

## Test-as-self gate (required before merge)

Per [[feedback_test_as_self_standard]]: green tests are necessary but not sufficient. Before
merge, deploy the built change to this live agent (swap the shadow-install dist, restart),
then drive the real scenario — attempt to send a message containing the codex-trust
false-blocker and confirm the gate holds it (422), and confirm a genuine password/value
escalation still sends (200). Restore, then merge.

## Out of scope

- Building the registry-wide conformance gate and the Usher (North Star infrastructure that
  would parse `STANDARDS-REGISTRY.md` directly) — separate, larger work
  ([[project_north_star_working_awareness]]).
- Wiring the dead end-of-turn `response-review.js` / CoherenceGate Stop-hook path. It is off
  by default and not in `Stop[]` ([[project_fresh_session_gate_unwired]]); reusing it would
  be *more* machinery, not less. B17 uses the live send-time authority instead. (Activating
  that path is a worthy separate effort, but it is not this change.)
- A structured `falseBlocker` signal field on `ToneReviewSignals` is *optional observability*
  only; B17 does not depend on it. Ship the always-evaluated rule; add the field only if
  dashboard telemetry wants it later.
