---
slug: telegram-egress-invisible-payload-guard
title: Telegram Egress — Refuse an Invisible Payload at Every Egress, Not at a Named Function
review-convergence: pending
approved: false
---

# Telegram Egress — refuse an invisible payload at every EGRESS

## Status

**Spec written 2026-08-10 (window 12), AFTER the implementation, and that ordering is disclosed rather
than hidden.** The work was built as a repair to review-pass-29 finding 1 under the window-12 charter,
reached the commit gate, and the gate correctly demanded a Tier-2 spec. Writing the spec now is the honest
response; declaring Tier 1 to route around the requirement was the alternative and was refused — the two
prior source commits on this branch did exactly that (`declaredTier: 1` against `riskFloor: 2`,
`belowFloor: true`), and review pass 28 convicted that decision on this same send path.

`approved:` is **false** and only the operator may change it. This spec is not self-approvable.

## The problem

A message whose entire body is invisible — whitespace and/or zero-width characters — cannot inform a
reader, and delivering it produces a "reply lost" escalation for content that never existed. That is not
hypothetical: it is the live incident this guard was built for (a peer relay accepted a body of one ZERO
WIDTH SPACE, failed with an empty error, burned nine retries over 4h17m, and emitted a user-facing "I had a
reply for you but couldn't deliver it" notice; there was no reply).

The refusal has been placed four times, and its scope over-claimed four times. Each over-claim was
falsified by the next reader:

| placement | claim written | falsified by |
|---|---|---|
| one HTTP route | "fixed at the point of sending" | pass 27, via a second route |
| two routes | "both doors" | pass 28, via a third route |
| `sendToTopic` | "the single chokepoint every Telegram send passes through" | pass 29, by executing `send()` |
| `apiCall` | "the one function `fetch` is reached through" | second-pass reviewer, via the standby relay |

**The root cause is one habit, not four mistakes: asserting the shape of a set instead of deriving its
members.** Every repair in this window that HELD was a derivation; every one that failed was a
hand-maintained list or an asserted enumeration.

## The derived population

Derived by MECHANISM — a file that builds the `api.telegram.org` URL and calls `fetch` — not by class name:

| sender | send sites | state before |
|---|---|---|
| `src/messaging/TelegramAdapter.ts` | 14 `apiCall('sendMessage')` across 9 methods | 4 covered, via `sendToTopic` |
| `src/lifeline/TelegramLifeline.ts` | 2, behind its OWN private funnel | **no guard at all** |
| `src/server/routes.ts` (demo sender) | 1 direct `fetch` | none |
| `src/commands/setup-wizard/codex-driver.ts` | 1 | none |
| `src/commands/setup-wizard/gemini-driver.ts` | 1 | none |
| `src/commands/test-as-self.ts` | 1 | none |

**Six senders.** The lifeline was invisible to all four previous enumerations for one reason: each of them
enumerated the adapter.

## The design

### 1. Refuse per EGRESS, not per function

`TelegramAdapter` has **two** egress mechanisms, and this is the correction that cost the most to learn:

- `apiCall` — the only path to `fetch`. Covers 14 sites.
- the **tokenless-standby relay** (`!hasUsableBotToken && this.outboundRelay`) — hands the body to another
  machine's router and **never enters `apiCall`**.

A guard on `apiCall` alone leaves the relay uncovered. Relying on the receiving end is not sufficient
either: the far route refuses with **400**, while `isRelayRefusal` recognises only **422**, so a CONTENT
refusal would surface to the caller as `relay failed … router unreachable` — a transport lie about a
reachable router, the exact conflation `TelegramRelay`'s own header records having fixed.

This is **not** the duplication review pass 23 warns about (two copies closing the SAME case, masking each
other's tests). These close DIFFERENT cases and each is independently provable.

### 2. Key the refusal by method → field, not by a method set plus a hardcoded field

```
sendMessage      → text
editMessageText  → text
createForumTopic → name
editForumTopic   → name
```

A forum topic's `name` is as reader-visible as a message body, and an invisibly-titled topic is worse — it
persists in the topic list, unfindable. The two creating routes validate `name.trim().length >= 1`, and
`trim()` does **not** remove zero-width characters (they are format controls, not whitespace), so two ZERO
WIDTH SPACEs measure length 2 and pass. Verified by execution.

`answerCallbackQuery` also carries `text` and is deliberately **excluded**: it renders a transient toast and
an empty one legitimately dismisses the spinner. Refusing it would be an over-refusal, not a protection.

### 3. Make the enumeration a check, not a memory

`scripts/lint-telegram-send-funnel-guarded.mjs` derives the sender population from the mechanism and reads
the method→field map **from the guard's own source** rather than keeping a second copy. A future sender
joins the population by existing.

Its own failure modes are closed, each found by an independent reviewer defeating an earlier version:
block comments stripped file-wide; a local definition is not a call; the shared import is required; and a
**shrink-only ratchet** pins the population, because a zero-tripwire only catches total matcher failure —
splitting the host literal previously dropped a sender out silently and the lint reported "clean — 5".

## Alternatives considered and rejected

- **Keep the per-door checks and add a fifth.** Rejected: four enumerations, four over-claims. A per-door
  check requires every future door to remember, which is the willpower the constitution's first standard
  forbids.
- **Guard only `apiCall` and let the far end refuse the relayed case.** Rejected: it reports a content
  refusal as a transport failure (see §1).
- **Keep a belt-and-braces copy in `sendToTopic`.** Rejected: two copies closing the same case mask each
  other's tests (pass 23) — break either alone and nothing reds.
- **Widen the guard to every method carrying a `text` param.** Rejected as over-refusal:
  `answerCallbackQuery` legitimately sends an empty toast.

## Signal vs authority

This is deterministic blocking authority, and — correcting an earlier claim of mine — it **is** new
authority on some paths: `editMessageText`, both lifeline sends, and forum-topic names had no guard before.
The justification is not "no new authority"; it is that the predicate is a **deterministic policy evaluator
over a domain so constrained that all inputs can be enumerated** (does this string contain any character a
reader could see), with no open-domain judgment about meaning. A message of a single full stop passes,
correctly. The lint's authority is a closed-world format invariant at a dev-process chokepoint.

## Rollback

Remove two guard calls in the adapter (funnel + relay), one in the lifeline, four one-line calls in the
other senders, and one entry from the `lint` chain. No migration, no persisted state, no agent-state
repair. Callers would resume delivering invisible payloads — the pre-change behaviour.

## Acceptance criteria

1. An invisible payload is refused at **every** derived egress, proven by input, with zero network calls.
2. Visible payloads still deliver, with the exact text asserted — discrimination, not shouting.
3. Each egress guard is independently covered: removing one reds only its own arms.
4. The over-refusal boundary holds: an empty `answerCallbackQuery` is not refused.
5. The lint fails on a deleted, commented-out, decoyed, or unimported guard, and on a shrunken population —
   each asserting its **specific failure string**, never a bare exit code.
6. Full `lint` chain green; no pre-existing invisible-payload or window-10 test regresses.

## Verification performed

- 28 tests in `tests/unit/telegram-send-funnel-invisible-payload.test.ts`; **90 green** across it plus every
  pre-existing invisible-payload and window-10 behavioural test.
- Both egress guards sabotage-proven: removing the relay guard reds exactly its 7 arms with the funnel arms
  green; removing the funnel guard reds exactly its 7 with the relay arms green.
- All five reviewer escapes on the lint closed and re-proven by specific failure string.
- Full `lint` chain exit 0; `tsc --noEmit` clean.

## Known limits, stated rather than claimed as covered

- The lint proves a guard is CALLED in a sender file, not that it sits on the path the send takes. That
  needs a parser; the per-path guarantee is carried by tests instead.
- A sender reaching Telegram by some mechanism other than a direct `fetch` to the API host falls outside
  the derived population. The shrink ratchet makes a disappearance visible but cannot pre-empt a new shape.
- Non-Telegram adapters (Slack, WhatsApp, iMessage) are entirely out of scope and are not claimed.
