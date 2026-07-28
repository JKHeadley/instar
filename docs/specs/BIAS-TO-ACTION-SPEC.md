---
title: Standing-Authorization signal for B17_FALSE_BLOCKER — don't re-ask for authority you already hold
date: 2026-06-27
author: echo
slug: bias-to-action
parent-principle: "A Wall Is a Hypothesis"
parent-principle-fit: "On 2026-06-27 the operator told me to fix the release pipeline 'on your own — this is exactly an example of something you should fix on your own' and gave explicit preapproval. I fixed the immediate issue, then for the STRUCTURAL fix I stopped at 'ready for your go-ahead to build' and waited — making the operator chase me ('did you get my last message?'). The existing B17_FALSE_BLOCKER gate (MessagingToneGate, the 'Never a False Blocker' enforcement) is SUPPOSED to catch exactly this — 'hands a doable task back to the user' — but its legitimate carve-out treats 'asking for an approval the agent must obtain' as fine, and it has no notion of an approval ALREADY GRANTED. So asking for authority already in hand slips through as legitimate escalation. This spec feeds B17 a verified standing-authorization signal so 're-asking for authority you already hold' is recognized as the false blocker it is. 'A Wall Is a Hypothesis': an approval I already received is not a wall — treating it as one is the false-blocker anti-pattern this standard governs."
eli16-overview: BIAS-TO-ACTION-SPEC.eli16.md
commitment: CMT-1820
supersedes-draft: "Round-1 review (4 internal + codex/gemini) + a foundation audit corrected the original 'new B20 code + new constitutional article' design: B20 is taken (→ this needs no new code at all), and this is a GAP in the EXISTING B17, not a new surface. Full corrected design below."
review-convergence: "2026-06-27T21:51:25.552Z"
review-iterations: 3
review-completed-at: "2026-06-27T21:51:25.552Z"
review-report: "docs/specs/reports/bias-to-action-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 0
contested-then-cleared: 1
approved: true
approved-by: Justin
approved-via: "Telegram topic 28130 (2026-06-27): 'Please enter an autonomy session and continue until this is fully fixed' + 'you have my preapproval for any decisions needed in this autonomy session', following his directive to build 'stronger structural enforcement that pushes you to be more autonomous'. This spec is the faithful embodiment of that ask (the standing-authorization clause for B17). Approval recorded per the DYNAMIC-MCP autonomous-directive precedent. Ships OBSERVE-ONLY + dev-gated dark (non-FLOOR); the live-firing graduation (D8) is a separate future operator decision."
---

# Spec — Standing-Authorization signal for B17_FALSE_BLOCKER

## Problem

The `MessagingToneGate` already enforces the surrender family — **B16_UNVERIFIED_WALL**
(feasibility), **B17_FALSE_BLOCKER** (false human-deference: handing a doable task back
to a person), **B18_AUTONOMY_STOP** (announcing an engineering stop) — fed by the
`deferral-detector.js` hook <!-- tracked: CMT-1820 --> + the BlockerLedger (`AUTONOMY-PRINCIPLES-ENFORCEMENT-SPEC`).

B17 (`MessagingToneGate.ts:409`) catches "the candidate hands a task back to the user by
claiming it needs a *person* … when the task is within the agent's OWN means." Its
LEGITIMATE carve-outs (`:425`) correctly exempt **a genuine approval the agent must
obtain before acting** — because asking for a required approval is honest escalation, not
surrender.

**The gap:** that carve-out fires on the *shape* "asking for approval," with no notion of
whether the approval was **already granted**. So when the operator has already said "do it
yourself / you have my preapproval / go ahead," and the agent still asks "ready for your
go-ahead?", B17 reads it as legitimate escalation and passes it. The agent re-defers
delegated work back to the operator — the 2026-06-27 incident. The approval-already-held
case is the **authority-facing fourth face** of the surrender family (feasibility / agency
/ continuation / **authority**), and B17 is exactly where it belongs.

## Signal vs. Authority (mandatory declaration)

This adds a **SIGNAL** + extends an existing gate clause; it introduces **no new
behavioral code and no blocking authority of its own**. A new deterministic detector +
a verified standing-authorization resolver populate a `standingAuthorization` context
field; the **existing MessagingToneGate LLM remains the sole AUTHORITY** that decides
whether B17 fires. The detector judges nothing — B17's prompt clause (judged by MEANING,
per "Intelligent Prompts — An LLM Gate Must Not String-Match") makes the call. Observe-
only first (records would-fire, never alters the message) before any verdict change ships.
The fail direction stays toward SENDING (a missed case just sends an ask — harmless); the
dangerous direction (suppressing a NEEDED ask) is contained by the FLOOR carve-out + the
under-fire bias (D5) and the verified-only resolution (D6).

## Frontloaded Decisions

| # | Decision | Resolution |
|---|----------|------------|
| D1 | New code or extend B17? | **Extend B17_FALSE_BLOCKER.** No new behavioral code (B20 is taken by B20_INTERNAL_ID_LEAK; and this is genuinely B17's surface — the authority-facing false blocker). The `VALID_RULES`/`RULE_CLASSES` set is UNCHANGED, so the ratchet is untouched. |
| D2 | The new detector | `src/core/ask-when-authorized.ts` — a cheap, brittle SIGNAL detector (sibling of `parked-on-user.ts`) over the candidate text: permission-seeking / proceed-blocking phrasing aimed at the operator ("ready for your go-ahead", "shall I", "want me to", "should I proceed", "approve and I'll", "waiting on your approval to"). Pure + unit-tested. SIGNAL only — the phrase is an inert quoted token for the gate. |
| D3 | The standing-authorization resolver | `resolveStandingAuthorization({ topicId, askedAction })` → `{ present, source, grantedAt, grantedScope, evidenceQuote }`. Resolves from VERIFIED sources only (D6). `present:true` requires BOTH a grant AND a plausible **scope/recency match to `askedAction`** (D4) — existence of a grant is NOT coverage. Deps-injected reads; pure decision core, unit-tested both sides. |
| D4 | Scope/staleness match is a FIRING PRECONDITION | A grant for task A must NOT fire B17 on unrelated task B. The resolver carries `grantedAt` + `grantedScope` (the action/scope the grant referenced) + the `askedAction`; B17 fires the standing-authorization case ONLY when the gate judges the grant plausibly covers THIS asked action and is not stale. A blanket mandate / topic-preapproval counts ONLY if its scope contains the asked action (existence ≠ coverage). |
| D5 | FLOOR carve-out + UNDER-FIRE bias | FLOOR classification (irreversible / cost-bearing-above-threshold / out-of-scope / policy-sensitive — Self-Unblock Rung FLOOR, verbatim) is the **gate's judgment** (integration-tested, NOT a unit-testable pure function — Body-and-Mind: a classifier must not *decide* it; the cost threshold is deliberately unquantified). B17 does NOT fire the standing-auth case on a FLOOR action even with a live in-scope grant. Explicit bias: **when uncertain whether authority covers THIS exact non-floor action, do NOT fire** (favor false-negatives — sending the ask). |
| D6 | Verified-operator-ONLY resolution (Know Your Principal) | Standing authorization counts ONLY from the VERIFIED topic-operator: resolve the operator uid via `TopicOperatorStore.asVerifiedOperator(topicId)` and match inbound rows on `telegramUserId/userId === uid` — NEVER `fromUser` (any inbound human), NEVER `senderName`/content, NEVER the agent's OWN prior messages, and NEVER a FORWARDED row (D10). A grant the resolver cannot attribute to the verified operator does NOT count. **A row with a missing/blank `telegramUserId` is NON-ATTRIBUTABLE — it never matches (never a wildcard); it simply does not count as a grant** (fail-safe toward sending the ask). |
| D10 | Forwarded-grant defense (substrate-grounded) | A forwarded operator message is uid-stamped operator but carries THIRD-PARTY content ("go ahead, run autonomously") — if counted as a grant it would suppress a needed ask. Round-2 security audit found the forward markers (`forward_origin/forward_from/forward_date`) are detected at Telegram ingress but **NOT persisted** into the message-log row the resolver reads (`telegram-messages.jsonl` via `appendToLog`). FIX (two parts): (1) **persist a `forwarded: boolean`** onto the logged message row at `appendToLog`/the JSONL schema (set from the ingress forward-marker detection), going forward; (2) **fail-safe for unprovable rows** — the resolver counts a row as a grant ONLY when it can PROVE non-forwarded (`forwarded === false` explicitly present). A legacy/pre-change row with NO `forwarded` field is treated as forwarded-UNKNOWN and does NOT count (an unprovable grant never fires B17, so it can never suppress an ask). This makes the forwarded-exclusion implementable on the real substrate without a backfill, biased to the safe direction. **Implementation note (both ingress paths + explicit false):** `forwarded` must be persisted on BOTH inbound writers — the polling path (`TelegramAdapter.appendToLog`, forward markers in scope) AND the lifeline path (`TelegramLifeline` already sends `forwarded:true` on the wire, but `routes.ts logInboundMessage` currently drops it — thread it through). And a genuine row must carry an EXPLICIT `forwarded: false` (diverge from the adjacent "spread `{forwarded:true}` only, omit when false" idiom) — otherwise every row stays forwarded-UNKNOWN and the feature is permanently inert (safe direction, but non-functional). The wiring-integrity tier asserts BOTH paths persist `forwarded` (incl. `false`). |
| D7 | evidenceQuote discipline | `evidenceQuote` is operator content fed to the same LLM that holds B1–B7/B15 leaks → render it boundary-quoted + JSON-encoded as untrusted DATA (identical to `renderRecentMessages`), and secret-scrub it (`redactSecrets`/`guardProxyOutput`) + length-bound before any log write. A regression test asserts supplying `standingAuthorization` can NEVER flip a B1–B7/B15 HOLD to a pass. |
| D8 | Rollout | Observe-only first (`monitoring.biasToAction.enabled` dev-gated dark; `observeOnly:true` records a would-fire to `logs/bias-to-action.jsonl` — scrubbed, source enum + matched-phrase token + uid HASH, never raw quote — and the message sends unchanged). Graduate to the live B17 clause after a measured low false-positive rate. Named FP-rate exit criterion before graduation. |
| D9 | Look-back window | The resolver scans the verified-operator inbound rows within a bounded window — default **last 40 operator-authored inbound messages in the topic OR 24h, whichever is smaller** — for an explicit autonomy/preapproval grant. The window is the single biggest lever on the FP rate; it is config-tunable (`biasToAction.lookback`) and the default is conservative (recent + small) to bias against resurfacing a stale grant. |

## Design

1. **`detectAskWhenAuthorized(text)` → `{ asking, phrase? }`** (D2) — the cheap SIGNAL.
2. **`resolveStandingAuthorization(...)`** (D3/D4/D6/D9) — verified-operator-uid-scoped,
   non-forwarded, scope/recency-matched. Returns the structured grant or `{present:false}`.
3. **MessagingToneGate** — a new `signals.askWhenAuthorized` + `context.standingAuthorization`
   (boundary-rendered untrusted, D7). B17's existing prompt clause GAINS a sub-clause: an
   "asking for approval" message that the existing carve-out would exempt is INSTEAD a
   B17 false blocker WHEN `standingAuthorization` plausibly covers THIS exact, non-FLOOR
   action (judged by meaning). The citation precedence (B15 > B16 > B17 > B18) is unchanged.
4. **Observe-only telemetry** (D8) — would-fire recorded scrubbed; message unchanged.

## What this does NOT do

- No new behavioral code; no new constitutional article (it strengthens the existing
  "Never a False Blocker" enforcement). Reconciles with — does not duplicate — the tracked
  `agent-autonomy-ratchet` (which GRANTS new authority; this catches UNDER-USE of authority
  already held).
- It NEVER lets the agent act on a FLOOR action without an approval (D5).
- It NEVER infers authority from content, a forwarded message, or the agent's own words (D6).
- It NEVER blocks/rewrites a message; at most B17 (once graduated) holds a message that
  re-asks for already-held authority, exactly as B17 holds any false blocker today.

## Cross-machine posture

Detector: pure/stateless. Resolver: reads the verified topic-operator binding + that
topic's inbound history — **proxied-on-read** where the topic lives (same posture as the
existing operator-binding read); a moved topic resolves against the holder. Observe-only
log: machine-local append-only telemetry, no cross-machine semantics. No replicated state.

## Migration parity

`src/core/*` + `MessagingToneGate` ship in `dist` via npm; dev-gated dark
(`monitoring.biasToAction`) so the fleet is inert until enabled — standard dev-gate
resolution, no `PostUpdateMigrator` config entry (confirm in converge). No
`.claude/`/`.instar/` installed-file change. B17's prompt-clause text change ships in the
gate code; the judge-by-meaning ratchet (`gate-prompts-judge-by-meaning.test.ts`) must
still pass (the new sub-clause is meaning-based).

## Test tiers

- **Unit:** `detectAskWhenAuthorized` (asking vs not, both sides); `resolveStandingAuthorization`
  — verified-operator-uid grant counts; identical text from a DIFFERENT uid does NOT;
  a FORWARDED operator row does NOT; a legacy row with NO `forwarded` field does NOT (D10
  fail-safe); a row with missing/blank uid does NOT (D6); the agent's own prior message
  does NOT; scope-match (grant for A does not cover B); staleness (outside the window does
  not count); mandate/preapproval count ONLY when scope contains the action.
- **Integration (MessagingToneGate):** (a) ask + in-scope live grant + non-floor ⇒ B17
  fires; (b) ask + NO grant ⇒ no B17 (a first ask is fine); (c) ask + grant + FLOOR action
  ⇒ no B17; (d) ask + grant for a DIFFERENT action ⇒ no B17; (e) a genuine taste/value ask
  ⇒ no B17; (f) observe-only ⇒ records, sends unchanged; (g) the B1–B7/B15 HOLD regression
  (standingAuthorization can never flip a leak HOLD); (h) a BORDERLINE-FLOOR action (one a
  reasonable operator would still want to approve but isn't obviously irreversible/costly)
  + a live grant ⇒ no B17 (the under-fire bias holds at the boundary — where the only real
  residual lives).
- **Wiring-integrity:** the gate receives a non-null `askWhenAuthorized` signal +
  `standingAuthorization` context from the real outbound path; the resolver actually
  filters on the verified uid (not `fromUser`); the observe-only log is written + scrubbed.
- **E2E lifecycle:** the feature is alive behind the dev-gate (route/telemetry present,
  503 when off), exercising the real outbound→gate→observe-only path end to end.

## Standards parent

Primary: **"A Wall Is a Hypothesis"** (an approval already granted is not a wall —
re-asking is the false blocker). It strengthens the existing **"Never a False Blocker"**
enforcement (B17) by closing its authority-facing gap, and reuses **"Self-Unblock Before
Escalating — Rung FLOOR"** (the FLOOR carve-out) + **"Know Your Principal"** (verified-
operator-only resolution). No new constitutional article — this is the missing clause of
an existing standard, reconciled with the tracked `agent-autonomy-ratchet` follow-on.

## Open questions

*(none)*

## Build state (2026-06-27)

**DONE + tested (in worktree `echo/bias-to-action`):**
- `src/core/ask-when-authorized.ts` (detector, D2) + `tests/unit/ask-when-authorized.test.ts` (16 tests green).
- `src/core/standing-authorization.ts` (resolver, D3/D4/D6/D9/D10 — verified-uid-only, forwarded-fail-safe, staleness, scope evidence) + `tests/unit/standing-authorization.test.ts` (11 tests, every identity/forwarded/staleness boundary).
- `src/core/MessagingToneGate.ts`: `askWhenAuthorized` signal field, `standingAuthorization` context field, `renderStandingAuthorization` (boundary-quoted untrusted DATA), the B17 STANDING-AUTHORIZATION sub-clause (judge-by-meaning + FLOOR + under-fire bias), the signal-render line. tsc clean; gate-prompts-judge-by-meaning ratchet + all 112 MessagingToneGate tests pass.
- `src/server/routes.ts`: the `askWhenAuthorized` SIGNAL wiring + import (inert without the context wiring below).

**REMAINING (precise next steps):**
1. **Context wiring** (`src/server/routes.ts`, near the recentMessages build ~line 1771): instantiate `resolveStandingAuthorization(topicId, deps)` with deps `{ getVerifiedOperatorUid: t => ctx.topicOperatorStore?.asVerifiedOperator(t)?.uid ?? null, getRecentMessages: t => <operator inbound rows with telegramUserId/text/ts/forwarded>, now: Date.now }`; secret-scrub `evidenceQuote` (import `redactSecrets`) before putting it on `context.standingAuthorization`. **Observe-only (D8):** when `monitoring.biasToAction.observeOnly` (default true), DO NOT attach `standingAuthorization` to the gate context (so no verdict changes) — instead append the would-fire to `logs/bias-to-action.jsonl` (source enum + matched-phrase token + uid HASH, never raw quote). When graduated (observeOnly:false), attach it.
2. **Forwarded persistence (D10)** — the load-bearing security step: persist `forwarded: boolean` onto the message-log row on BOTH ingress paths — polling (`TelegramAdapter.appendToLog`, forward markers in scope at `:4497-4501`) and lifeline (`TelegramLifeline` already sends `forwarded:true` on the wire; thread it through `routes.ts logInboundMessage` → `appendToLog`). Write an EXPLICIT `forwarded:false` on genuine rows (diverge from the omit-when-false idiom) or the resolver stays permanently inert. Add the field to the row type + `getRecentMessages` return.
3. **Config** (`src/core/types.ts` near `correctionLearning`): `monitoring.biasToAction?: { enabled?, observeOnly?, lookback? }` dev-gated dark; `ConfigDefaults` omit `enabled` (dev-agent-gate pattern).
4. **Tests:** integration (gate fires/doesn't per D-cases a–h, incl. borderline-FLOOR); wiring-integrity (gate receives non-null signal+context from the real path; resolver filters on verified uid not fromUser; observe-only log written+scrubbed; BOTH ingress paths persist forwarded incl. false); E2E (feature alive behind dev-gate, 503 when off).
5. **Phase 5 second-pass adversarial review** (MANDATORY — touches the gate authority + the forwarded/uid security path), side-effects artifact, trace, commit, PR.
