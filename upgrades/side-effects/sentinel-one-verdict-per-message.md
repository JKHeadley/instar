# Side-Effects Review — One stop verdict per inbound message

**Version / slug:** `sentinel-one-verdict-per-message`
**Date:** `2026-11-18`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

`MessageSentinel.decideInboundDisposition(message, topicId, messageKey?)` takes an optional message key. With a key, the first decision for that message (key plus the exact text's sha256) is kept for 15 minutes, at most 1000 entries, and returned to every repeated delivery of the same message. The returned decision is marked `reused: true`. A delivery that arrives while the first classification is still running awaits that same promise. A decision that throws, or one that rests on a fallback rather than a judgment (model call failed, shed for capacity, or unparseable; marked by a new `degraded` flag on the classification and the decision), is not remembered, so the next delivery decides afresh. Without a key, behaviour is unchanged.

Callers now pass keys: the lifeline forward route (`routes.ts`, `telegram:<topic>:<messageId>`), the polling path (`TelegramAdapter.onSentinelIntercept` → `server.ts`, the same key format, so the two Telegram paths share one verdict), the phone app route (`mobileConversationRoutes.ts`, `app:<conversation>:<messageId>`), the forwarded app message on the owner machine (`appConversationPool.ts` → `server.ts`, the same app key), and the Slack app route (`mobileSlackRoutes.ts`). A `decisionReused` counter is added to `dispositionStats`.

Cause (from preserved evidence, not timestamps). On 2026-11-18 at 03:41Z the operator's correction in topic 144201 (photo plus "This plan is NOT working. the wrong account is growing: dawn and NOT healdey.justin") reached the sentinel as a 223-character text. Its sha256 `5995dcb6c146ea92…` matches the reconstructed fallback sentence plus caption exactly. The judgment-provenance log (`state/judgment-provenance/2026-11-18.jsonl`, decisionPoint `message-sentinel-classify`) holds 8 classifications of that one identity between 03:41:40 and 03:43:15. The Codex transcripts of those calls (`~/.codex-followme-sagemindai/sessions/2026/11/17/rollout-2026-11-17T19-4{1,2,3}-*.jsonl`) hold the model's final answers in order: redirect, **emergency-stop**, redirect, redirect, redirect, redirect, redirect. The lifeline forward's fetch aborts at 10 s (`TelegramLifeline.doForward`) and `retryWithBackoff` re-sends. The model calls took 5.3–13.3 s, so each re-send re-classified. The second delivery's `emergency-stop` returned `disposition: 'kill'`, and the forward route killed `echo-topic-144201` and sent "Session terminated." (`telegram-messages.jsonl` #144718). That text is produced only by `emergencyStopUserMessage(…, killed=true)`.

## Decision-point inventory

- `MessageSentinel.decideInboundDisposition` (emergency-stop / pause / route-through) — **modify** — an idempotency layer in front of the unchanged decision: a repeated delivery of the same message gets the first decision instead of a fresh draw.
- Forward route, polling intercept, app routes, app owner receiver — **pass-through** — each passes a stable key; how each acts on the disposition is unchanged.

---

## 1. Over-block

No new block surface. The change can only make the decision for message N equal the decision already taken for message N. A genuine stop that the model inferred on the first delivery stays a stop on every repeat. That is the same outcome as before, minus the extra model calls.

## 2. Under-block

- The FIRST classification of a message can still be a wrong `emergency-stop`, and it still kills (about 1 in 7 for this message under that model). Removing it would mean changing *Structure Decides Alone Only on an Exact Match* ("an LLM-inferred stop is a real stop and kills on its own"). That is a constitution question, raised to the operator separately, not changed here.
- A redelivery more than 15 minutes later is classified again. Relay retries and boot redrives fall well inside that window.
- The cache is per process. A re-send that lands on a different machine, or after a server restart, is decided afresh. Before this change every re-send was decided afresh, so this is no worse in those cases.
- A text-identical message under a different message id is a different message and is decided separately, by design.
- A re-sent stop that arrives after the topic's session was respawned, but inside the 15 minutes, gets the stop verdict again and kills the new session. Before this change a re-ask of a model-inferred stop might have answered differently, and a floor stop always re-killed. A re-sent forward is the same operator message, so honouring it consistently is correct.

## 3. Level-of-abstraction fit

This is the right layer. `decideInboundDisposition` is already documented as "the SINGLE place the 'Operator Channel Is Sacred' standard is enforced". Every inbound consume site calls it, so making it idempotent covers all paths at once. Fixing only the lifeline timeout would cover one path and still leave crash redrives and app retries re-drawing.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface.

Message identity is an enumerable invariant: same key and same text bytes. Keying a decision on it is the "idempotency fact" kind of structure that *The Body and the Mind* places below the threshold. The judgment itself (is this a stop?) is still made by the floor or the model, exactly as before. Structure only stops the same judgment being re-asked.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The reuse rule is an invariant: the same message gets the same decision.

## 5. Interactions

- **Pause circuit-breaker:** a redelivered deterministic pause used to call `recordPauseConsume` once per delivery. With a key, one pause message counts once toward the breaker. This is more correct: redeliveries can no longer trip the breaker on their own. It is tested.
- **Exact-match floor:** unaffected. The floor runs inside the first decision. Reused copies carry the same `fast-path` method, and the model is never consulted (tested).
- **Forward route vs polling path:** both use `telegram:<topic>:<messageId>`. If both ever see one message, they get one verdict, which is the desired behaviour.
- **Kill repetition:** a re-sent forward of a message whose first verdict was `kill` gets `kill` again and runs the kill path again. That was already the case before (each re-send re-classified, and a floor stop always re-killed). Killing an already-dead tmux session is a no-op, but the route still sends the operator another notice ("Session terminated." or "No active session to stop."). That duplicate notice existed before this change. This change neither adds nor removes it.
- **Fallbacks:** a capacity-shed or failed model call returns a fallback (`degraded: true`). It is acted on for that delivery exactly as before, but not remembered, so a re-send gets a real judgment rather than a locked-in non-answer. This came from the second-pass review.
- **Races:** the shared promise is stored before it is awaited, so concurrent deliveries attach to one call. A rejection deletes the entry.

## 6. External surfaces

No API or message text changes. The only external effect: fewer model calls (one per message instead of one per delivery), which also takes load off the Codex account that serves the sentinel. No operator-facing actions. `dispositionStats` gains a `decisionReused` counter, an additive field.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design. The remembered verdict lives in the process that made it, because the kill it gates also happens in that process (the server that holds the topic's session). A forward that crosses machines is classified on the receiving machine, as before. No user-facing notices, durable state or URLs are added.

## 8. Rollback cost

A pure code change: revert and ship a patch. No persistent state.

## Conclusion

This removes the re-draw that turned one wrong answer out of seven into a killed session. The first decision for each message is now final for that message. The residual risk is a wrong first answer that kills, which is governed by the constitution and is reported to the operator rather than changed here.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (given the diff, the incident facts and the governing articles; not my conclusions)
**Independent read of the artifact: concur**

The reviewer concurred: no rule violation, correct races, pruning and keys, and every caller's id is in scope and is the platform's own message id. It raised three gaps, all addressed: (1) a fallback first verdict would be locked in for 15 minutes, now fixed with the `degraded` flag and tested; (2) the duplicate stop notice on a re-sent forward was not mentioned, now stated under Interactions; (3) a re-sent stop after a respawn kills the new session, now stated under Under-block. It also noted that the 1000-entry cap was untested, and a test now covers it.

---

## Evidence pointers

- `tests/unit/MessageSentinel-one-verdict-per-message.test.ts` (11): replays the incident's answer sequence, a fallback that is not remembered, and the cap. Proven two-sided: with the reuse disabled by injection, the replay and the reuse cases fail (4 of the first 9).
- Existing sentinel ratchets still pass: `emergency-stop-floor-intelligence-split` (4), `MessageSentinel-operator-channel-sacred` (15), `structure-decides-alone-exact-match-only` (14).
- `tests/integration/telegram-forward-sentinel-intercept.test.ts`: a re-sent forward through the real route with a real `MessageSentinel` makes one model call and no kill.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is in server code (a non-idempotent decision under retried delivery), not in a prompt, hook, config, skill or standards text, and the change adds no self-triggered controller.
