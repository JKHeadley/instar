# Part D — Adversarial / reaper-class re-convergence findings (NEW material only)

Reviewer lens: reaper-class, anti-loop. Scope: ONLY the new Part D section + its
interaction with Part B's D8 invariant. Parts A/B/C as previously converged are not
re-litigated except where Part D changes their grounding.

All findings grounded against the worktree source (not memory). Line numbers are from
this worktree at review time.

---

## F1 (BLOCKING) — Part D's promotion mechanism is grounded on the WRONG message store

Part D ("The promotion", spec lines 166-175) and the grounding note both specify:

> `MessageStore.queryInbox(agentName, { threadId })` (`src/messaging/MessageStore.ts:166`)
> … "an inbound USER message on the topic within `windowMs`".

**This store does not hold inbound Telegram user messages.** Grounded:

- `src/messaging/MessageStore.ts:1-18` — MessageStore is the **Inter-Agent Messaging
  Spec v3.1** store (the **Threadline agent-to-agent** store): `store/`, `threads/`,
  `drop/{agentName}/`, `outbound/{machineId}/`.
- `queryInbox` (MessageStore.ts:166) filters on `e.message.to.agent === agentName`
  and `filter.threadId === e.message.threadId` — i.e. **peer-agent** messages on a
  **Threadline thread id**, NOT a Telegram topic.
- The cited "live precedent" at `server.ts:11988` is the **A2A check-in** history
  builder (`getHistory(threadId)`), iterating `e.message.from.agent` — peer agents,
  not human users. It is precedent for the WRONG thing.
- There is **no `topicId → MessageStore.threadId` mapping** in the codebase
  (grep for `threadId.*topic` / `topic.*threadId` in `src/messaging/*` and
  `server.ts` returns nothing relevant; `threadId` on `MessageEnvelope` is a
  Threadline conversation id).

**The CORRECT store** for "recent inbound user message on a Telegram topic":
`TelegramAdapter.getTopicHistory(topicId, limit)` (`TelegramAdapter.ts:3529`), backed
by `telegram-messages.jsonl` (`TelegramAdapter.ts:786`). Each `LogEntry`
(`TelegramAdapter.ts:217`) carries exactly the needed fields:
`{ topicId: number|null, fromUser: boolean, timestamp: string, … }`. The real
predicate is `getTopicHistory(topicId).some(e => e.fromUser && Date.now()-Date.parse(e.timestamp) < windowMs)`.

**Why this is BLOCKING, not cosmetic:** if the build implements Part D as written
(against `queryInbox`), the promoted predicate queries the A2A store keyed on a
Threadline `threadId` that no Telegram topic resolves to → it returns `[]`/false for
essentially every reaped session. The "promotion" would be **functionally inert** —
recreating the exact `()=>false` stub problem Part D was written to eliminate, while
*looking* implemented. D8 stays always-false; the feature stays dead; and the live
KEEP change never actually engages. (Worse edge: a topic that coincidentally has an
A2A thread would get a wrong answer driven by peer-agent traffic.)

**Fix:** Part D must re-ground "The promotion" + the grounding note on
`TelegramAdapter.getTopicHistory(topicId)` (sync, in-memory tail cache, topic-keyed,
`fromUser`+`timestamp`), NOT `MessageStore.queryInbox`. This also dissolves F3
(see below) because `getTopicHistory` is **synchronous**.

---

## F2 (MATERIAL — risk understated) — `recentUserMessage` is live at FIVE sites, not one; the live change is BROADER than "narrow, requires both a commitment AND a message"

Part D's risk argument (spec lines 183-195) frames the only live change as the
open-commitment KEEP-veto and calls it "**narrow** (requires BOTH a qualifying open
commitment AND an inbound user message inside the window)." Grounding the predicate's
consumers (`grep recentUserMessage src/`) shows **five live decision sites across two
modules**, and two of them are NOT commitment-gated:

1. `ReapGuard.ts:137` — **Gate I**, a STANDALONE `keep('recent-user-message')` on any
   session messaged within `recentUserWindowMs` (default **30 min**, ReapGuard.ts:79).
   No commitment required. Today dead (`()=>false`); goes live on promotion.
2. `ReapGuard.ts:149` — the open-commitment KEEP-veto, `staleCommitmentWindowMs`
   (default **8h**). The D8 mirror. (This is the only site the spec's "narrow"
   framing actually describes.)
3. `ReapGuard.ts:221` / `ReapGuard.ts:239` — the `workEvidence()` probe path (the
   mirror of `evaluate()`'s KEEP, both windows). Also goes live.
4. `SessionReaper.ts:489` — see F2a, the most consequential.

So promotion's live footprint includes Gate I (recent-message-only KEEP) and the
SessionReaper stale-idle computation — both **independent of any commitment**. The
spec's "requires BOTH" characterization is inaccurate; the correct statement is
"KEEPs a session with a recent user message (Gate I), AND additionally widens the
open-commitment veto to 8h when a commitment is also present (Gate J)." Direction is
still SAFE (keep-only), but the magnitude is wider than Part D claims and the
reaper-class review should see the true surface.

### F2a (MATERIAL) — SessionReaper.ts:489 INVERTS a currently-always-on relaxation; this is a second, distinct live reaper change Part D never names

`SessionReaper.ts:486-489`:

```
const staleIdle = this.cfg.reapStaleIdleWithActiveChildren
  && staleTopicId != null
  && !this.deps.recentUserMessage(staleTopicId, this.cfg.staleCommitmentWindowMinutes * 60_000);
```

With the stub, `recentUserMessage` is always `false` ⇒ `!false` = `true` ⇒ when
`reapStaleIdleWithActiveChildren` is on, **every** bound topic is treated as
`staleIdle`, so the reaper currently relaxes its keep on sessions-WITH-active-children
universally (more willing to reap them under pressure). Promoting the predicate flips
this: a recently-messaged topic becomes `staleIdle=false` ⇒ the reaper now **KEEPS**
sessions-with-active-children it previously would have reaped.

That is a real, **live, non-dark** change to what the reaper retains under host
pressure — and it lives at a *different* module/site than the ReapGuard KEEP the spec
discusses. It is gated only by the `reapStaleIdleWithActiveChildren` config flag, NOT
by the dark `monitoring.resumeQueue` gate. Direction is safe (keep), but it is the
concrete realization of the "mild resource-retention pressure" the spec waves at in one
phrase — and on a box under genuine pressure with several recently-messaged topics
holding child processes, "mild" is an assertion, not a bound. The spec should (a) name
SessionReaper.ts:489 explicitly as a second live site, (b) acknowledge the inversion
direction (was: relax-keep everywhere → now: keep recently-messaged), and (c) state
the only bound that actually holds it: the `recentUserWindowMs`/`staleCommitmentWindowMs`
horizons (30min / 8h) — after which the session falls through to the activeness guards
and can be reaped. That horizon IS a real bound (a session silent >8h is reapable
again), so this is not unbounded — but the spec must say so, not imply the change is
confined to ReapGuard.

---

## F3 (RESOLVED-BY-F1, no longer a real race) — the sync→async concern dissolves under the correct store

Part D leaves "make the probe async" vs "pre-compute a sync snapshot" to the build
(spec lines 177-181), flagging a potential default-wrong-value window. Under the
CORRECT store (F1), this concern **disappears**: `TelegramAdapter.getTopicHistory`
is **synchronous** (in-memory tail cache; `TelegramAdapter.ts:3529`). The predicate
stays `(topicId, windowMs) => boolean` exactly as the `ReapGuardDeps` /
`SessionReaper` dep signatures already type it (`ReapGuard.ts:48`,
`SessionReaper.ts:265`). No async refactor of the KEEP-probe, no awaited gate, no
race window, no default-wrong-value transition. This is a further reason F1's
re-grounding is the right fix and not just a citation nit — it also eliminates the
only genuinely hazardous build decision Part D defers.

(Had the build gone with `queryInbox`, the async path WOULD have introduced a real
window: a KEEP-probe that must `await` inside the reaper's synchronous evaluate()
chain forces either a pre-snapshot — stale by up to one reaper tick — or a probe
signature change rippling through both modules and `workEvidence()`. Avoided
entirely by using the sync topic-history accessor.)

---

## F4 (CONFIRMED SOUND) — the dark-injection containment claim holds; verified at the spawn chokepoint

Part D's load-bearing safety argument — "the loop requires the REVIVAL path to fire,
and revival ships dark/dryRun, so no loop is possible even with `recentUserMessage`
live" — is **SOUND**, verified at the actual spawn site:

- `ResumeQueueDrainer.ts:311-317`: `if (queue.isDryRun()) { …audit 'would-resume'…;
  return { resumed: false, blocked: 'dry-run' }; }` — this returns BEFORE the
  `respawnTopic()` / `triggerJob()` spawn block (lines 320+). dryRun genuinely
  suppresses the SPAWN; it does not merely log alongside a spawn.
- `ResumeQueue.ts:156` ships `dryRun: true` as the code default (the fleet is
  observe-only), and `ResumeQueue.ts:273` `isDryRun()` returns `this.cfg.dryRun`.
- Therefore: injection (Part B) cannot cause a respawn while dryRun holds ⇒ no
  reap→revive→reap cycle ⇒ the 2026-06-13 loop is structurally impossible while the
  injection is dark, independent of `recentUserMessage` being live. Confirmed.

Caveat (NOT a containment hole, but the spec should state it): the containment is the
loop-safety. It does NOT make the `recentUserMessage` promotion itself harmless — that
promotion is live regardless of the dark gate (F2/F2a). The two are correctly
separable in Part D's rollout ("ship recentUserMessage + injection dark, soak"), and
that rollout is the right one. The only correction is that the live half is the FIVE
sites of F2, not the single ReapGuard KEEP the spec describes.

---

## F5 (MINOR — completeness) — Gate-I going live changes a Part-A-adjacent observability assumption

Once Gate I (`ReapGuard.ts:137`) is live, `keptBy: 'recent-user-message'` becomes a
real, frequently-hit keep reason in the reaper audit (`logs/reaper-audit.jsonl`) where
today it never appears. Not a hazard, but a reviewer note: the dark-soak success
criterion ("the dark soak confirms KEEP and eligibility agree on real data") should be
read against this new keep-reason volume — expect `recent-user-message` and
`open-commitment` keeps to appear where there were none. Anyone reading the soak's
reaper audit who expects the prior (all-`()=>false`) baseline will mis-read the delta.
Worth one sentence in the rollout/soak criteria so the soak isn't called "regressed"
when it's working as designed.

---

## Verdict inputs

- F1 is BLOCKING (wrong store → re-grounds the entire promotion mechanism; as written
  the build produces an inert or wrong predicate).
- F2/F2a are MATERIAL (the live change is broader and lands at a second module the
  risk analysis never names; safe-direction but must be stated accurately for a
  reaper-class sign-off).
- F3 is resolved by F1 (and removes the only hazardous deferred build decision).
- F4 confirms the central containment claim is SOUND.
- F5 is minor soak-criteria hygiene.

Direction of the live change remains SAFE (keep-only) and bounded by the 30min/8h
horizons. The catastrophic loop is genuinely contained by the dark injection. But Part
D cannot go to build with the `MessageStore.queryInbox` grounding — that single error
silently defeats the whole point of the part.
