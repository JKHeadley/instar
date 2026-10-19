---
title: "Operator approvals by Telegram tap (feedback readiness + executor acceptance)"
slug: "telegram-tap-operator-approval"
author: "echo"
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
related: "Operators Act in Taps, Not Text (docs/specs/ws52-operator-tap-not-text.md); Mobile-Complete Operator Actions; Structure > Willpower"
status: "draft r1"
eli16-overview: "telegram-tap-operator-approval.eli16.md"
tracked: "ACT-003 follow-on; operator directive 2026-10-18 topic 18330"
---

# Operator approvals by Telegram tap

## 1. Why this exists

On 2026-10-18 the operator was sent to the dashboard's Feedback Drain tab twice to approve two
gates and said: the page is unreadable, the PIN feels redundant because he already needed the PIN
to open the dashboard, and "what exactly are we trying to accomplish with that feedback tab?"
For him the answer should be "nothing": a decision that is his should arrive where he already is
(the Telegram topic he works in) as one sentence and two buttons.

The two gates in scope stay the operator's. This spec changes **what can satisfy** them, which
moves an authority boundary. That is why it is a spec and not a patch.

In scope:

- **G-R** — the feedback readiness authority approval (`POST /feedback-factory/readiness-authorities`,
  actions create / replace / restore; revoke stays Bearer-cheap per the existing "halting is cheap" rule).
- **G-E** — the executor's approver-independence acceptance
  (`POST /feedback-factory/triage/plan` `{action:"accept-approver-dependence"}` then `/triage/commit`).

Out of scope: every other PIN-gated lever (money layer, mandates, external-hog arm, passkeys,
latch clear). A later spec may extend the satisfier to them only by naming each one.

## 2. The hard question: can a Telegram tap ever equal a PIN?

### 2.1 What the PIN actually proves today

The PIN is meant to prove "a human operator, not the agent, chose this". It is weaker than that:

- It lives in `.instar/config.json` on the agent's own machine, readable by any process running as
  the agent's OS user. The file viewer no longer serves it (`NEVER_SERVED_PREFIXES`, verified live
  2026-10-18: 403 on read/download/content), but a session can read it from disk. The only thing
  stopping the agent from typing it is a standing rule.
- It is a shared static secret with no binding to the request: a PIN that approves G-R today
  approves G-E tomorrow, and nothing records *which device* typed it.

So "PIN = human" is **willpower, not structure**, for any agent that runs as the same user as its
config. The honest baseline a tap must beat is not "a secret the agent cannot reach"; it is "a
secret the agent is forbidden to use".

### 2.2 What a Telegram tap proves

A Telegram inline-button tap produces a `callback_query` that Telegram generates only when an
authenticated Telegram client presses that button. It carries `from.id` (the account that pressed),
the message it was pressed on, and the button's `callback_data`. Instar receives it only through the
lifeline, and the internal callback route requires the lifeline ingress secret, so a session cannot
forge a tap through the HTTP API (LifelineIngressGuard; enforce mode refuses taps without the
secret).

What a tap does **not** prove: that a human pressed it. The agent can drive the operator's own
Telegram account in a browser (the operator-profile browser broker). If anything with that access
can press an inline button, a tap from the operator's `from.id` is exactly as forgeable as a typed
PIN — by the same actor, under the same standing rule.

### 2.3 Answer

**A tap is equivalent to a PIN only when the agent's routes into the operator's Telegram client
structurally cannot press an inline button, and it is never stronger than that.** Concretely, the
tap satisfier is admitted only while all of these hold, checked at the moment the tap is applied:

1. **No click path in the broker.** The operator-profile browser broker exposes typed operations
   only (snapshot, send, edit). It has no operation that presses a button or opens a callback. A
   unit ratchet pins the broker's operation list; adding a click-shaped operation fails the build.
2. **Generic browser tools cannot reach the operator's profile.** Today this is a cooperative
   PreToolUse hook, not an OS sandbox. That is the same strength as "the agent may not read the
   PIN", so it does not make the tap weaker than the PIN; it is recorded as the shared residual risk
   (§6), not hidden.
3. **No live broker session at tap time.** If the broker has driven the operator's Telegram profile
   in the last 120 s, the tap is refused with a plain reply ("I couldn't accept that tap because I
   was using your Telegram account a moment ago — tap again in two minutes"). This turns "the agent
   pressed it through the broker" from undetectable into structurally refused for the one path that
   exists.
4. **Bound, single-use, short-lived.** Each approval message carries a server-minted nonce bound to
   the exact action, its rendered wording hash, the machine and the authority binding fields. It
   expires after 15 minutes, is consumed once (durable CAS), and a tap on a superseded message is
   refused. This is strictly stronger than the PIN, which binds to nothing.
5. **The tapper is the owner, checked the pairing-invite way.** Reuse the shape of
   `PairingInviteTelegram.operatorTap` (src/threadline/PairingInviteTelegram.ts:89): the lifeline
   ingress guard must be armed and enforcing, the callback must arrive with a verified lifeline
   secret, `fromUserId` must equal the configured `ownerUserId`, the chat must equal the chat the
   request was posted to, and **an unset owner refuses** (fail closed). Do NOT copy the tunnel
   relay-consent check (`TelegramAdapter.processCallbackQuery`, `if (owner && from.id !== owner)`),
   which lets any tapper through when no owner is configured; that gap is filed separately
   (§9).
6. **The tap is announced.** After applying, the bot posts one line in the same place: "Approved by
   your tap at 22:41 — undo". The undo button revokes (Bearer-cheap direction). A tap the operator
   did not make is visible within one screen and reversible with one more tap.

If any of 1–5 cannot be verified (broker state unreadable, binding missing, lifeline guard not
armed), the tap is refused and the message says the dashboard path still works. Fail closed toward
the existing PIN path, never toward acceptance.

### 2.4 The cheaper half: the PIN he already typed

The operator's second complaint was that the gate PIN is redundant because he typed the same PIN
to open the dashboard. That is accurate: unlocking the dashboard already mints an operator session
(`verifyDashboardOperatorSession`, routes.ts:996), and one gate already accepts a recent session
in place of a re-typed PIN (`requireReloginOperatorPin`, routes.ts:33789). Part B of this spec
extends that existing pattern to G-R and G-E: a dashboard operator session minted by a PIN unlock
in the last 10 minutes satisfies the gate, so the dashboard button becomes one tap with no PIN box.
This is no weaker than today (the session itself was minted by the same PIN, and a Bearer token
cannot mint one), and it is the existing relogin precedent, not a new kind of satisfier.

### 2.5 What we explicitly do not claim

- We do not claim a tap proves a human. Neither does the PIN. Both rest on the agent not acting
  through the operator's credentials; the tap makes the one known actuation path (the broker)
  structurally unable to press, which the PIN path cannot do for disk reads.
- We do not make the tap *replace* the PIN. The dashboard PIN path stays as it is; the tap is a
  second satisfier, opt-out per agent.

## 3. Design

### 3.1 One satisfier abstraction

Today there is none: G-R calls `feedbackMutationIntentValid` → `checkMandatePin` (routes.ts:14110,
13195), and the relogin gate has an ad-hoc PIN-or-session OR at one call site. Add
`OperatorApprovalSatisfier` with three implementations: `pin` (today's `checkMandatePin`,
unchanged), `dashboard-session` (Part B, §2.4) and `telegram-tap` (Part A). G-R and G-E call one function, `satisfyOperatorApproval(gateId, request,
evidence)`, which returns `{ ok, satisfier, auditRef }`. The audit chain records which satisfier
approved each change. No other gate is wired to the tap satisfier; an allowlist of gate ids is a
code constant pinned by a test.

### 3.2 Delivery

When a gate becomes pending (the existing `approveAction` / `approver-not-independent` states), the
server posts one message to the operator's chosen place (default: the agent's operator alert topic;
configurable to a topic id such as 18330):

> Feedback is waiting on one approval from you: let the sorting model (GPT-6 Astra, up to $5 a day)
> decide which reports become work. [Approve] [Not now]

The wording is the server-rendered plan text the dashboard shows (one source). One message per
pending episode; re-posted only if the plan changes. [Not now] snoozes 24 h and is never treated
as a revoke.

### 3.3 Apply path

Lifeline → `POST /internal/telegram-callback` (secret-gated) → tap satisfier verifies §2.3 1–5 →
the gate's existing commit function runs with `satisfier: telegram-tap` → announce + undo (§2.3 6).
The commit function is the same one the PIN path calls; no second implementation of either gate.

### 3.4 Configuration

`operatorApproval.telegramTap`: `{ enabled, gates: ["feedback-readiness","feedback-executor-acceptance"],
topicId?, brokerQuietSeconds: 120, ttlMinutes: 15 }`. Dev-gated: live on a development agent, dark
on the fleet. `enabled:false` restores PIN-only. Read live.

## 4. Decision points touched

- G-R and G-E admission: adds a second satisfier. Floor: §2.3 1–5 deterministic, fail closed.
- No judgment point added; every check is an invariant.

## 5. Multi-machine posture

Machine-local by design: each gate's authority binds to the owning machine (readiness binding
carries `ownerMachineId`/epoch). The approval message is posted by the machine that owns the gate
and the nonce binds that machine; a tap delivered to another machine's lifeline is forwarded to the
owner over the existing mesh path or refused, never applied elsewhere. One voice: only the gate's
owning machine posts the request.

## 6. Residual risk (shared with the PIN)

An agent that deliberately bypasses the cooperative browser hook and drives the operator's
Telegram profile with a raw browser, waiting out the quiet window, can press the button. That
same agent could read the PIN from disk. Closing both needs an OS-level boundary (a separate user
or a keychain item behind user presence), which is outside this spec; it is recorded as the shared
residual risk, and §2.3 6 (announce + undo) is the detective control for both.

## 7. Tests (all three tiers)

- Unit: nonce binding/expiry/single-use; each §2.3 refusal; broker operation-list ratchet; gate-id
  allowlist ratchet; wording identical to the dashboard plan text.
- Integration: tap → callback route (with and without lifeline secret) → gate committed with
  `satisfier: telegram-tap`; replayed tap refused; wrong `from.id` refused; broker-active refused.
- E2E: production init with the flag on — a pending G-R posts exactly one message and a tap
  approves it; flag off — no message, PIN path unchanged.
- Live-user-channel proof on a throwaway agent + demo topic before the operator sees it.

## 8. Delivery order

Part B (dashboard session satisfies G-R/G-E) ships first: smallest change, existing precedent.
Part A (Telegram tap) follows once its live-user-channel proof passes on a throwaway agent.

## 9. Found while mapping

The tunnel backup-relay consent tap (`TelegramAdapter.processCallbackQuery`, `tc:` branch) accepts
any tapper when no `ownerUserId` is configured. Out of this spec's two gates; filed as feedback for
its own fix.

## 10. Rollback

`operatorApproval.telegramTap.enabled:false` / `operatorApproval.dashboardSession.enabled:false` (read live). Approvals already made by tap stay valid
and are listed in the audit with their satisfier; revoke is one tap or one dashboard press.
