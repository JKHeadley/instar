---
slug: telegram-egress-invisible-payload-guard
title: Telegram Egress — Refuse an Invisible Payload at Every Agent Funnel, with a Guard Call Present in Every Derived Sender File
review-convergence: pending
approved: true
approved-by: justin
approved-at: 2026-08-10
approval-channel: telegram/29723
approval-provenance: >-
  Justin's verbatim decision, 2026-08-10 17:12 PDT — "approved, for both the spec and the standard" —
  relayed through the observer on the operator account. Recorded by the agent as a citation of the
  operator's decision, NEVER as the agent's own authority. The agent did not and cannot self-approve.
---

# Telegram Egress — refuse an invisible payload at every agent funnel, with a guard call present in every derived sender file

> **The title said "every EGRESS" until round 1 of convergence, and the external reviewer was right to
> call it an overclaim: this spec's own limits section admits the derivation reaches only senders that
> call `fetch` against the API host directly. "Every egress" is what a centralized boundary would give;
> what this delivers is every egress the mechanism can SEE, plus an alarm when that set shrinks. Narrowed
> at the title rather than defended in a footnote — the failure this whole document is about is claiming
> a set is complete without deriving it, and I had done it again in the first line.**

## Status

**Spec written 2026-08-10 (window 12), AFTER the implementation, and that ordering is disclosed rather
than hidden.** The work was built as a repair to review-pass-29 finding 1 under the window-12 charter,
reached the commit gate, and the gate correctly demanded a Tier-2 spec. Writing the spec now is the honest
response; declaring Tier 1 to route around the requirement was the alternative and was refused — the two
prior source commits on this branch did exactly that (`declaredTier: 1` against `riskFloor: 2`,
`belowFloor: true`), and review pass 28 convicted that decision on this same send path.

**`approved:` is TRUE as of 2026-08-10, on Justin's verbatim decision relayed through the observer.** The
citation in the frontmatter is the signature trail; the agent recorded the operator's decision and has no
authority to make one. `review-convergence:` remains **pending** and is the agent's own outstanding
obligation — approval of the CONTENT is the operator's act, convergence is a process step still owed, and
writing that tag by hand would be a fabricated review inside the constitution.

## Guarantee summary — read this before citing the spec

**Behavioural refusal is PROVEN BY INPUT for three funnels:** the adapter's API funnel, the adapter's
tokenless-standby relay, and the lifeline's own funnel. Each is sabotage-proven to red only its own arms.

**Four direct senders are PRESENCE-ONLY:** two setup-wizard greetings, the self-test probe, and the demo
harness sender. The lint proves the guard call is in the file; **nothing executes an invisible payload
through their real send function.** That is CMT-1248.

**Do not cite this spec as proof that all Telegram egress is behaviourally guarded.** It is not, and the
distinction between the two groups is the single most likely thing for a future reader to flatten. Round 8
of convergence named that risk explicitly, which is why this section sits above the argument rather than
inside it.

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

**Why it text-parses the TypeScript source rather than importing the table as data** (asked at round 7, and
the answer is a real trade rather than an oversight): the lint is plain `.mjs` run by `node` in the commit
and CI chains, while the table lives in `.ts` — importing it would mean depending on `dist/`, and a lint
that reads a STALE BUILD would report on a table that is not the one shipping, which is a worse failure than
brittle parsing and precisely the class this branch keeps finding. The parse is **fail-closed**: if either
declared set cannot be read, the lint exits non-zero rather than reporting clean, so a moved or renamed
constant breaks the build loudly instead of silently emptying the population. Exporting the table as a
JSON asset consumed by both runtime and lint is the better end state and rides **CMT-1246**, which already
rewrites this boundary.

**The classification is CLOSED-WORLD (added on a round-3 finding).** Before it, a method in the map was
guarded and everything else was silently unguarded — so a future `sendPhoto` carrying a caption would enter
the codebase unclassified and no check would say a word. Every method a sender calls must now be declared
either reader-visible (with its field named) or explicitly bodyless (with the reason); anything in neither
list FAILS as review-required. Proven both ways: injecting an unclassified `sendPhoto` reds naming that
method, and emptying the bodyless declaration reds fail-closed rather than silently passing everything.

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
- **A single shared, guarded Telegram request helper that every sender must call** (raised by the round-1
  external reviewer, and it is the strongest alternative here). This is the design that would make "every
  egress" **structurally** true instead of derivation-true: one function owns the HTTP call, the guard is
  inside it, and a new sender cannot exist without going through it. **Not rejected on merit — deferred on
  blast radius, and the distinction matters.** It rewrites the call path of six files including the
  lifeline's independent poller and two setup-wizard drivers, none of which currently share a client, and
  it would land the same night a live hole was found. The lint plus per-egress guards close the hole now;
  the boundary is the correct end state. **Tracked, not dropped:** **CMT-1246** — a registered, beacon-enrolled commitment with a deadline, not a marker in a document —
  a follow-up to introduce the shared client and then DELETE the per-sender guards. **Owner: Echo.
  Acceptance criteria, so the marker is a commitment rather than a gesture:** (a) exactly one function in
  the codebase issues an HTTP request to the Telegram API host, proven by the derived population collapsing
  to one file; (b) every per-sender `assertTelegramPayloadVisible` call is DELETED, and the behavioural
  suite still reds when the single remaining guard is removed; (c) the lint's assertion changes from
  "every sender calls the guard" to "exactly one sender exists", which is a boundary check and is
  path-complete by construction; (d) the vendored invisible-codepoint table lands with it, removing the
  runtime Unicode dependency named in the multi-machine table above. Recorded here because a rejected alternative that
  is actually the better design must not disappear into a commit message.

## One term, used consistently: MECHANICALLY-VISIBLE

Round 3 asked for the distinction; round 5 correctly noted the document still slid between the two terms.
One term now carries the guarantee: **a payload is MECHANICALLY-VISIBLE when its reader-facing field
contains at least one LETTER, NUMBER, PUNCTUATION MARK, or SYMBOL.**

**That definition is POSITIVE, and round 6 is why.** It was subtractive — remove whitespace,
`Default_Ignorable` and `Cf`, and treat whatever remained as visible. An external reviewer named that as an
open world, and execution confirmed the hole: a payload of only a C0 control (`U+0001`, `U+0007`, `U+001B`),
an unassigned code point, a private-use code point, a noncharacter, a lone combining mark, or a lone
surrogate **ALL PASSED as visible** and would have been delivered. Every one renders as nothing or as tofu —
the incident's exact harm on a wider input surface.

**Subtracting the invisible is the same mistake as enumerating the senders: you can only remove the shapes
you thought of.** Naming what COUNTS closes the world, including against whatever Unicode adds next. A mark
attached to a base letter still passes, because the letter is content; a lone mark does not. That, and only that, is what
the code asserts and what every acceptance criterion here means. Throughout this spec, **"reader-visible"
names the PRODUCT INTENT** — the thing we are trying to protect. **The MECHANICAL GUARANTEE is narrower and
is the only thing the code actually asserts:** the field contains at least one code point in
`\p{L}\p{N}\p{P}\p{S}`. Those are not the same claim — an unsupported glyph or a client-specific font can
make a code point that PASSES this positive check still render as nothing to a particular reader, which is
why the guarantee is mechanical rather than perceptual. Where this document says a payload is refused for having "no visible characters", read
it as shorthand for the mechanical predicate; the guarantee has never been client-rendered visibility and
must not be cited as though it were.

## Signal vs authority

This is deterministic blocking authority, and — correcting an earlier claim of mine — it **is** new
authority on some paths: `editMessageText`, both lifeline sends, and forum-topic names had no guard before.
The justification is not "no new authority"; it is that the predicate is a **deterministic policy evaluator whose
blocked CLASSES are explicitly defined and mechanically testable** (does this string contain any character a
reader could see), with no open-domain judgment about meaning. A message of a single full stop passes,
correctly. The lint's authority is a closed-world format invariant at a dev-process chokepoint.

## Decision points touched

| decision point | classification | justification |
|---|---|---|
| **Refuse an outbound Telegram payload whose reader-visible field has no visible characters** | `invariant` | **Restated after round 1, and REPLACED after round 6.** The predicate is NOT "is this visible to a reader" — that depends on Unicode version, grapheme clustering, emoji modifiers and the rendering client, and is not settled. Nor is it the subtractive question it originally asked, which let eight non-printing categories through. What is closed and decidable is the POSITIVE question the code now asks: *does this string contain at least one letter, number, punctuation mark, or symbol* (`\p{L}\p{N}\p{P}\p{S}`, resolved by the host engine's Unicode tables). Deterministic for a given engine, no competing signal, and closed against categories nobody has thought of yet. There is no competing signal, no context that changes the answer, and no open-domain judgment about meaning — a single full stop passes, correctly. This is the *deterministic policy evaluator whose blocked classes are explicitly defined and mechanically testable* case, not a judgment point wearing an `invariant` label. |
| **Which Telegram methods carry a reader-visible field** | `invariant`, as a **VERSIONED POLICY TABLE** | **Reclassified after round 1.** Calling this "a fact about the API" was wrong twice over: the Bot API can add or change methods, and the `answerCallbackQuery` exclusion is a product-behaviour judgment (an empty toast is *useful*), not a mechanical one. It is an invariant at RUNTIME — a closed code-defined map with no per-call judgment — but it is policy that carries a review trigger, not a timeless truth. **Review trigger:** any Bot API version bump, or any new `apiCall` method reaching a reader. The pinning test is what makes a silent drift impossible. |
| **Whether a source file is a Telegram body-sender (the lint's population)** | `invariant` | Derived mechanically — builds the API host string AND calls `fetch` AND references a body-carrying method. No semantic judgment; a shrink-only ratchet makes a silent population loss loud. |

**Contested in both directions, per the standard.** None of the three is a competing-signals point dressed
as an invariant: none weighs evidence, none has a "it depends" case, and none can be right or wrong about
intent — only about characters, a code-defined map, and a mechanical file predicate. Conversely, none is
misfiled as a judgment-candidate: adding an arbiter to "does this string have a visible character" would be
an LLM call on a settled question, which *Intelligence Infers* would rightly refuse.

## Multi-machine posture

| surface | posture | note |
|---|---|---|
| the refusal predicate | `unified`, with a NAMED runtime dependency | **Corrected after round 2 — the first version overclaimed.** It is a pure function of the payload, but the predicate resolves through the host engine's Unicode tables, so "identical verdict on identical bytes" holds only while machines share a Unicode data version. **Restated at round 9, which caught this row still describing the SUPERSEDED subtractive design:** the drift that matters is no longer `Default_Ignorable`/`Cf` membership — it is **General_Category membership for `L`/`N`/`P`/`S`**, since those four categories are now what the code asks about. The residual is BOUNDED to code points whose L/N/P/S membership changed between Unicode releases (in practice, newly ASSIGNED code points: an unassigned point is not content on either version until it becomes a letter or symbol). An empty string, whitespace, ordinary text and emoji already assigned are decided identically on every version. **Direction of the residual, stated because it decides whether this is dangerous:** an older table has FEWER assigned letters/symbols, so an older machine REFUSES a payload made only of a newly-assigned character that a newer machine would send. That direction is fail-SAFE — the older machine withholds rather than delivering emptiness — which is why this is a named dependency rather than a blocker. **No runtime pin exists to cite, and I checked rather than assumed:** `engines.node` is `>=20.12.0` — a
FLOOR, not a pin — CI runs Node 20, and this development machine runs Node 24, so a version spread is not
hypothetical, it is the current state. The residual above is therefore live, bounded as described, and
un-mitigated by any existing enforcement. Vendoring a generated table removes the dependency entirely and
is the clean fix; it rides **CMT-1246** and is NOT claimed here. |
| the method→field map | `unified` | Compile-time constant shipped with the code. |
| the lint | `unified` | Runs in CI and at commit time against the repository, not against machine state. |

**No surface here is machine-local**, so no `machine-local-justification` marker is claimed — and the
bidirectional check holds: `unified` is feasible for all three, because none is credential-bound or
hardware-bound. The one adjacent thing that IS machine-local — a bot token and the topic ids it namespaces —
is untouched by this change and is not a surface this spec introduces.

## Frontloaded Decisions

Every decision that would otherwise stop the build mid-run, resolved here:

1. **Where the refusal sits** — at every agent funnel and every derived sender, not at a named "chokepoint" function. Resolved: two egress
   mechanisms in the adapter (`apiCall` and the standby relay), one in the lifeline, four direct senders.
2. **Whether to keep a second copy in `sendToTopic`** — no. Two copies closing the SAME case mask each
   other's tests. The relay guard is not a second copy; it closes a DIFFERENT case, and each is
   independently sabotage-proven.
3. **Whether `answerCallbackQuery` is in scope** — no, on the over-refusal ground stated above.
4. **Whether forum-topic names are in scope** — yes. Same class, different field; swept rather than
   deferred.
5. **Throw vs silent drop** — throw. Both funnels already throw on a non-ok response, so it is the
   established contract; a caller that swallows it drops an invisible message, which is the correct outcome.
6. **Whether to raise the lint's population baseline automatically** — no. The ratchet is shrink-only and a
   legitimate increase must be a deliberate edit in the same commit as the new sender.

**Cheap-to-change-after tags claimed: none.** This ships live rather than dark, so no reversibility claim
is being made and none needs contesting.

## Open questions

*(none)* — all resolved into Frontloaded Decisions above.

## Known-open, tracked outside this spec

Two findings from convergence are real, are NOT closed by this change, and are registered as durable
commitments rather than left as prose:

- **CMT-1247 — the relay refusal-status mismatch is a protocol bug this guard only makes rarer.** The far
  route answers **400** for a content refusal; `isRelayRefusal` recognises only **422**. The local guard
  means an invisible payload no longer travels that path, but ANY other relay-side content refusal still
  surfaces to a caller as "router unreachable". Normalizing the status/schema across that boundary is the
  fix and it is out of scope here.
- **CMT-1246 — the centralized client is RISK RETIREMENT, not cleanup**, and round 5 was right to insist on
  the distinction. The interim design is *knowingly non-structural*: it depends on source-shape derivation
  plus a ratchet, and a ratchet catches a population SHRINKING, never a refactor semantically routing
  around a guard that is still present in the file. **Stated consequence if it slips:** the guarantee in
  this spec's title cannot be strengthened — "by presence at every derived sender" stays until CMT-1246
  lands, and any future claim of path-complete egress coverage is unearned until it does. It carries the
  vendored codepoint table with it, which also retires the Unicode dependency.

## Rollback

Remove two guard calls in the adapter (funnel + relay), one in the lifeline, four one-line calls in the
other senders, and one entry from the `lint` chain. No migration, no persisted state, no agent-state
repair. Callers would resume delivering invisible payloads — the pre-change behaviour.

## Acceptance criteria

1. A payload that is not MECHANICALLY-VISIBLE is refused at **every path-tested agent funnel (proven by input, zero network calls)** and **a guard call is present in every lint-detected direct sender FILE (presence proven; behavioural refusal NOT proven)**. The word "guarded" is reserved throughout for input-proven paths.
   Those are two different strengths and the criterion states both rather than averaging them into one word.
   **Said without hedging: for the four direct command-file senders, nothing today executes an invisible
   payload through their real send function — that is CMT-1248, and until it lands "presence" means the
   call is in the file, nothing more.**
   **Amended twice. Round 3 exposed a gap; round 4 caught the amendment CONTRADICTING the criterion it
   amended — requiring "every derived egress, proven by input" while admitting most were not. Resolved by
   closing the gap where it could be closed and stating the guarantee exactly where it could not.**

   **Path-tested by input (3 of 3 funnels that carry agent traffic):** the adapter's API funnel, the
   adapter's tokenless-standby relay, and the lifeline's own private funnel — each proven to refuse with
   ZERO network calls and to deliver ordinary text, each sabotage-proven to red only its own arms.

   **NOT path-tested (4 direct command-file senders — two setup-wizard greetings, a self-test probe, and a
   demo-harness sender):** covered by the lint (the guard is called in the file) and by the shared guard's
   unit tests, NOT by a test driving each real send function. **So the criterion reads, honestly: refusal
   is PROVEN BY INPUT at every funnel carrying agent traffic, and PROVEN BY PRESENCE at the four direct
   senders.** Tracked to closure as **CMT-1248**, not as a marker.
2. Visible payloads still deliver, with the exact text asserted — discrimination, not shouting.
3. Each egress guard is independently covered: removing one reds only its own arms.
4. The over-refusal boundary holds: an empty `answerCallbackQuery` is not refused.
5. The lint fails on a deleted, commented-out, decoyed, or unimported guard, and on a shrunken population —
   each asserting its **specific failure string**, never a bare exit code.
6. Full `lint` chain green; no pre-existing invisible-payload or window-10 test regresses.
7. **Boundary code points are pinned by fixtures that run on whatever engine executes them** (added on a
   round-5 finding), so a Unicode-table divergence between the supported floor and the CI version reds a
   test instead of being assumed away. The fixtures cover eight zero-width/ignorable boundary points, eight NON-PRINTING code points that the
   old subtractive predicate delivered (C0 controls, unassigned, private-use, noncharacter, lone combining
   mark, lone surrogate), and five positive controls that must still pass — a full stop, a digit, an emoji,
   a base letter carrying a combining acute, and a letter beside an ideographic space. "Control" here means
   a TEST control, never a Unicode control character. The run records its engine, so a divergence is
   attributable rather than mysterious.

## Verification performed

- 28 tests in `tests/unit/telegram-send-funnel-invisible-payload.test.ts`; **90 green** across it plus every
  pre-existing invisible-payload and window-10 behavioural test.
- Both egress guards sabotage-proven: removing the relay guard reds exactly its 7 arms with the funnel arms
  green; removing the funnel guard reds exactly its 7 with the relay arms green.
- All five reviewer escapes on the lint closed and re-proven by specific failure string.
- Full `lint` chain exit 0; `tsc --noEmit` clean.

## Known limits, stated rather than claimed as covered

- **SEMANTIC BYPASS is the named residual risk, not a theoretical one.** The lint proves a guard is CALLED
  in a sender file, **not that it sits on the path the send takes** —
  a future refactor can satisfy the lint while routing around the guarded call. This is a real boundary
  weakness, not a cosmetic one, and it is the reason the shared-client alternative below is the correct end
  state rather than a nicety. Nothing in this spec should be read as claiming the lint derives guarded
  egress PATHS; it derives guarded FILES. The per-path guarantee is carried entirely by tests.
- A sender reaching Telegram by some mechanism other than a direct `fetch` to the API host falls outside
  the derived population. The shrink ratchet makes a disappearance visible but cannot pre-empt a new shape.
- Non-Telegram adapters (Slack, WhatsApp, iMessage) are entirely out of scope and are not claimed.
