# Side-Effects Review — Internal Telegram routes require a lifeline-only secret

**Version / slug:** `telegram-internal-route-lifeline-secret`
**Date:** `2026-10-12`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see the end of this file)`

## Summary of the change

`POST /internal/telegram-forward` and `POST /internal/telegram-callback` take the sender's Telegram id from the request body and were protected only by the Bearer token every session holds, so any session could post a message or an Approve tap as the operator. This change adds a secret only the lifeline and the server hold (`state/lifeline-ingress-secret`, 0600, never in any process environment), requires it on those routes and on a new `POST /internal/lifeline-proof`, and decides what an unproven request gets through `LifelineIngressGuard`.

Files: `src/core/LifelineIngressSecret.ts` (new), `src/server/LifelineIngressGuard.ts` (new), `src/server/TelegramCallbackDedupe.ts` (new), `src/server/routes.ts`, `src/commands/server.ts`, `src/lifeline/TelegramLifeline.ts`, `src/lifeline/forwardErrors.ts`, `src/core/version-skew.ts`, `src/core/keyMaterialPaths.ts`, `src/core/WriteDomainRegistry.ts`, `src/core/devGatedFeatures.ts`, `src/core/types.ts`, `src/monitoring/guardManifest.ts`, `src/data/state-coherence-registry.json`, `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`, plus tests, the spec, its ELI16 and the release-note fragment.

## Decision-point inventory

- `LifelineIngressGuard.evaluate` (forward, callback, proof routes) — **add** — accept or refuse a request by whether it carries the lifeline secret; decide sender trust.
- Operator auto-bind in the forward route and in the message pipeline — **modify** — skipped for a request whose sender is not trusted.
- `/internal/telegram-forward` 426 handler's restart-signal write — **modify** — budgeted for an unverified request.
- `TelegramCallbackDedupe.claim` (callback route) — **add** — a tap id already claimed is not handled again.
- Lifeline `forwardToServerClassified` / `replayQueue` — **modify** — a secret refusal re-queues with no budget burned, backs off, and notifies after ten minutes.
- Lifeline restart signal — **pass-through** for existing writers; **add** one budgeted writer.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- A lifeline still on pre-change code sends no secret. Its **messages are never refused**: no message is refused until the guard is armed, and it arms only when a lifeline has presented the secret (or there is no lifeline). Sixty seconds after the routes are built, an unarmed guard writes the restart signal once, so that lifeline is deliberately restarted onto current code; apart from that restart its requests are handled as before while the guard is unarmed.
  - In **observe** (the fleet default) that lasts as long as the guard stays unarmed. Nothing is degraded.
  - In **enforce** (development agents) it lasts 24 hours. After that, with the lifeline still not updated, its messages are still delivered but as from "Unverified sender", and its button taps are refused. Deliberate (it bounds the original hole) and loud (hourly report, attention item, `/guards` row off).
- A lifeline rolled back alone to pre-change code under a server that has armed and enforces is refused: its messages queue and are dropped with the existing notice after about 25 minutes, and its taps fail. This is the one real over-block of messages; it needs a manual lifeline-only rollback, and `bypass: true` prevents it. Stated in the spec's Rollback section and in the release note.
- **The server cannot read or create its own secret and has never held one in this process** (for example the file is unreadable at boot). Then every tap from a healthy, current lifeline gets 503 `lifeline-secret-unavailable`, and every real message is delivered as "Unverified sender": no operator bind, no command authority. The load is retried every 30 seconds and a degradation is reported after a second failed load. Refusing messages too would make the agent unreachable; trusting them would restore the hole.
- A current lifeline whose copy of the secret is stale gets one 401, re-reads the file and succeeds on the retry (end-to-end test). One that cannot read the file at all has its messages held (not dropped), retried with a backoff that doubles from one minute to fifteen, and tells the user at the first refused attempt after ten minutes. Held messages can therefore wait up to fifteen minutes after the cause clears, unless a new message arrives or the server restarts.
- An operator's own script that calls these routes with the Bearer token (none exists in the repo) would be counted and reported in observe, and refused once the agent enforces. The typed 401 names the cause.
- A button tap that arrives a second time is not handled again. That is the intent. A tap whose handler threw, or whose first handling was cut off, is not retried on redelivery and answers 409; the user taps again, which is a new id.
- A tap whose `callbackQueryId` is not a string or a number now gets 400. Telegram always sends a string.

---

## 2. Under-block

**What failure modes does this still miss?**

- A session that deliberately reads the secret file, rewrites the guard state on disk, or edits the config file. One OS user; stated as the limit in the spec, the CLAUDE.md text, the release note and the PR.
- **An unarmed guard.** While unarmed a forged request is handled as before this change: in observe for as long as the lifeline has not updated, in enforce for at most 24 hours. In practice until the boot nudge restarts the lifeline (about a minute).
- **An unproven message can still trigger the emergency stop.** The sentinel intercept runs on any accepted forward and acts on the message text, so an "Unverified sender" message saying "stop everything" can still kill the topic's session and pause the resume queue. That is unchanged from before and deliberate: skipping the intercept for unverified requests would stop a real operator's "stop" from working through a lifeline that has not updated. A few slash commands that ignore the sender id (`/interrupt`, `/restart`, `/link`, `/unlink`, `/claim`, `/local-model`) are in the same position. A Bearer holder already has route equivalents for all of these.
- `POST /sessions/:name/input` still lets a Bearer holder type text shaped like a Telegram message into a session, and `POST /a2a/inbox` still lets one hand the agent-to-agent hook a message with a body-supplied bot claim. Neither reaches operator binding, the inbound log, the ratifiers or the tap handlers. Unchanged, and stated.
- In observe after arming, an unproven message is still delivered to the session (with no identity and the sender name "Unverified sender"). A session can still put text in front of another session through this route; it can no longer do it as the operator.
- Two machines: a tap handled on machine A whose poll offset A never confirmed can be applied again on machine B after a seat move. Narrow, stated, flagged for the operator.
- A message that was accepted and whose response was lost can be delivered twice (existing exactly-once-ingress concern). This change widens that in one case: an untrusted message does not claim an exactly-once ledger key, so a real lifeline whose messages are being treated as untrusted (enforce with the allowance over, or the server holding no secret) loses that protection. Conversely, while the guard is unarmed an unverified caller is still trusted and can still pre-claim a real message's ledger key, as before.
- The tap guarantee is bounded by retention (2000 ids, 7 days).

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The identity claim enters the system at these two routes, so the proof is checked there, before any effect, and the identity is removed there in one place rather than at each of the seven consumers. The lifeline restart coordination reuses the existing signal file and its existing readers. The never-served / never-backed-up / gitignored floor reuses the one key-material list. The guard reports through the existing `DegradationReporter`, the attention queue and the guard-posture manifest rather than a new surface. The Bearer middleware is untouched and still required.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — and the logic is an exact credential compare, which the principle exempts.
- [ ] ⚠️ Yes, with brittle logic.

The guard blocks on one thing: whether a header equals a random secret, compared in constant time. That is a mechanical credential check, not a judgment about meaning, and the principle's own carve-out for authentication applies; an LLM here would only add a way to be talked into accepting a forgery. Everything else the guard decides (armed, the exit rule, the signal budget, duplicate ids) is arithmetic over recorded facts. No keyword, phrase or heuristic holds authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**Does this change add a static heuristic at a competing-signals decision point?**

No new static heuristic at a competing-signals decision point. Every decision point is classified `invariant` in the spec's `## Decision points touched`, with its justification; the three review rounds contested each row in both directions and they held. The closest to a judgment is the observe exit, and it is fixed arithmetic with a hard deadline precisely so nothing can argue it out of enforcing.

---

## 5. Interactions

- **Shadowing:** the secret check runs before the forward route's version handshake. A pre-change lifeline across a major.minor boundary, under an armed enforcing server, gets the 401 before the 426, so its own skew handler does not run. That needs a lifeline-only rollback; stated under Rollback. In the ordinary case (unarmed, or a current lifeline) the handshake runs as before.
- **Sentinel intercept:** runs after the secret check and before identity is used. A refused request never reaches it. An accepted but untrusted message does (see Under-block).
- **Exactly-once ledger:** an untrusted message does not claim a key, so it can neither be deduplicated nor pre-claim a real message's id (see Under-block for both consequences).
- **Double-fire on the restart signal:** the guard and the forward route's 426 handler write the same file. For an unverified request they share one persisted budget, and the guard evaluates first, so it normally spends the budget and the 426 handler's own write does not happen. The signal the guard writes is equivalent (same file, same target version), but it is now written at most once per 12 hours while unarmed instead of on every 426, and the lifeline deletes the signal before it attempts the restart, so a restart that does not go through is not re-nudged by the server for 12 hours. The 426 response itself still drives that lifeline's in-process restart on every forward, as before. A verified lifeline's 426 is unbudgeted, as before.
- **Operator auto-bind:** the route's bind and the pipeline's bind both skip for an untrusted sender (the second by the missing id and by the explicit flag).
- **Races:** the secret file is created with temp + hard link, so two processes creating it at once cannot produce two values or a half-written file. Two processes replacing a malformed file at once can briefly hold different values; both re-read on the next mismatch and converge on the file. Guard state and the tap store each have one writer (the server), written synchronously with temp + rename. Lifeline queue replay is now single-flight.
- **Feedback loops:** an unverified request, or the boot nudge, can cause a restart signal, which can cause a lifeline restart, which causes a startup proof. Bounded by the persisted 12 h / 24 h budget and by the lifeline ignoring a signal that targets its own version. A secret refusal causes a retry; bounded by the backoff (one minute doubling to fifteen), with no drop budget burned and one user notice per episode. The backoff gates queue replay only; a newly arrived message is forwarded at once and is itself the probe.
- **Standby write admission:** the new proof route is classified machine-local in the write-domain registry, so a standby admits its own lifeline's proof.
- **Guard-posture probe:** the new manifest row derives off-runtime-divergent for an unarmed (lifeline expected) or bypassed guard, and alerts after two probe ticks.

---

## 6. External surfaces

- **Other agents on the same machine:** none. Each agent has its own state dir and secret.
- **Install base:** existing agents get the gitignore entries and the CLAUDE.md section through `PostUpdateMigrator`. Development agents start in enforce. Fleet agents with a lifeline start in observe. An agent with no lifeline ingress (its server polls Telegram itself, or it has no Telegram) arms at once and enforces on every agent class, because there is no lifeline traffic to observe; that is persisted. No message is refused on any agent with a lifeline until that lifeline has proven itself.
- **External systems:** Telegram only through the lifeline's existing notices plus one new fixed notice (messages held, sent at the first refused attempt after ten minutes of secret refusal). Three report kinds raise an operator attention item, each at most once per 24 hours, raised by each machine for itself.
- **Persistent state:** three new files under `state/` (secret, guard state, tap claims), all bounded, all machine-local, none in backups or git. The existing restart-signal file also joins the never-served list.
- **Timing:** arming depends on the lifeline's first proof (within one 15-second tick of a current lifeline being up). Until then the guard is unarmed and refuses no message. All time rules read the wall clock.
- **Operator surface (Mobile-Complete Operator Actions):** the two config keys (`enforce`, `bypass`) are config-file edits only, on purpose: a Bearer holder must not be able to turn the guard off over HTTP. There is no dashboard control. The operator's phone-reachable path is conversational: they ask the agent, and the agent edits its own config file. No PIN-gated or approval-class route is added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard renderer, approval page or form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** Each machine runs its own lifeline and server; these routes are the loopback hop between them and cross-machine forwarding does not use them.

- Secret: a credential shared by two processes on one disk. Replicating it would only widen who can read it.
- Guard state: whether this machine's lifeline has proven itself with this disk's secret. Meaningless on another machine.
- Tap claim store: channel-seat state, like the poll offset the registry already classes machine-local. This is the contestable one, and it has a real residual (a tap can be applied on a second machine if the first stopped between handling it and its next poll). Declared in the spec and flagged in the PR for the operator.

A current standby lifeline never polls but still proves itself, so that machine arms. A machine with Telegram configured, a send-only server and no lifeline process at all never arms: it reports `unarmed` hourly when unverified requests arrive, its guard row reads off, and it writes a restart signal every 12 hours that nothing reads. User-facing notices: only the lifeline that holds undelivered messages emits the new lifeline notice, which is the poll owner, so one voice for that. The server-side attention items are raised per machine. No durable state is keyed on a topic, so nothing strands on a topic transfer. No URL is generated.

---

## 8. Rollback cost

- **Live, no restart (where the live config reader is wired, as it is in the running server):** `telegramIngress.lifelineSecret.bypass: true` in the config file makes every request accepted with its sender trusted and taps accepted. Two things from this change stay on under bypass: a tap id must be a string or a number, and a tap delivered twice is applied once (with 409 for a redelivery after a failed or unknown first attempt). `enforce: false` stops refusing messages only. A message the lifeline is already holding is delivered at its next retry, up to fifteen minutes away.
- **Hot-fix release:** revert the code; an older server ignores the header and the three files.
- **Data migration:** none. The three state files can be left in place or deleted.
- **Agent state repair:** none for a full revert. If only the lifeline is rolled back while the server stays armed and enforcing, set `bypass: true` first.
- **User visibility:** none during a full revert.

---

## Conclusion

The review changed the design substantially over four rounds. The first version refused on a bare mode flag; the reviews drove: arming only on proof and a startup proof route; dropping the sender identity in one place instead of skipping one auto-bind; refusing unproven taps in either mode; a 7-day deadline so observe cannot be held open, and in enforce a 24-hour pre-arm allowance so the migration window cannot either (in observe an unarmed guard deliberately changes nothing: fleet traffic is not degraded before development agents have run the strict behaviour); a boot nudge so a quiet machine's lifeline is restarted without waiting for a message; a persisted restart-signal budget; a no-budget, backed-off, user-visible path for a refused lifeline; protection of the guard's own files from the Bearer-only file editor; a true rollback key; and registration in the guard-posture manifest. What remains open is stated rather than hidden: the one-OS-user limit, the two-machine tap window, and the absence of a test against a lifeline built from a previous release.

---

## Second-pass review (if required)

Required: this change adds block/allow decisions on inbound messaging.

**Reviewer:** independent reviewer subagent (read-only; read the diff and the new files, not only this artifact)
**Independent read of the artifact: concur** (on the second read)

First read: "Concern raised". No blocking defect in the code; seven places where this artifact omitted something or said more than the code supports: the emergency-stop intercept acting on an unproven message; the server's own secret being unreadable; the exactly-once ledger; the 426 signal writer being effectively replaced for unverified callers; "one attempt a minute" (the backoff doubles to fifteen); `bypass` not restoring everything; and three statements that assumed a lifeline on every machine. Each was corrected in sections 1, 2, 5, 6, 7 and 8 above.

Second read, after those corrections and seven small code changes (the pre-arm allowance expiring only in enforce; a per-kind attention throttle; independent unarmed reports; a `no-lifeline-ingress` mode source; the backoff counter incrementing per replay pass; the restart-signal file joining the never-served list; the boot-nudge timer disabled under the test runner): "Concur with the review. All seven earlier concerns are addressed in the revised artifact, and the seven code changes match their descriptions." One cosmetic point was raised (a stale code comment about taps) and fixed.

---

## Evidence pointers

- `tests/unit/lifeline-ingress-secret.test.ts`, `tests/unit/lifeline-ingress-guard.test.ts`, `tests/unit/telegram-callback-dedupe.test.ts`, `tests/unit/session-spawn-no-lifeline-secret.test.ts`, `tests/unit/PostUpdateMigrator-lifelineIngressSecret.test.ts`, `tests/unit/lifeline/forwardErrors.test.ts`
- `tests/integration/telegram-internal-routes-lifeline-secret.test.ts`, `tests/integration/telegram-unverified-sender-pipeline.test.ts`
- `tests/e2e/telegram-internal-routes-lifeline-secret-lifecycle.test.ts`
- `docs/specs/reports/telegram-internal-route-lifeline-secret-convergence.md`

---

## Class-Closure Declaration (display-only mirror)

This change adds self-triggered behaviour in the `unbounded-self-action` class in two places, and neither fixes a defect in an agent-authored artifact.

- **Server restart-signal writer** (`LifelineIngressGuard`): control-loop edge = an unverified request, or the boot nudge while unarmed, causes a signal write, which can restart the lifeline. Steady-state bound = one write per 12 hours before arming and one per 24 hours after, persisted across server restarts, never with an unknown target; a lifeline on the server's version ignores the signal. Settling brake = arming (a restarted current lifeline proves itself, after which a secretless request is no longer a version problem).
- **Lifeline secret-refusal retry** (`TelegramLifeline.replayQueue`): control-loop edge = a refused forward is retried. Steady-state bound = single-flight, the pass stops at the first refusal, the interval between passes doubles from one minute to a fifteen-minute cap, no drop budget burned, one user notice per episode. Settling brake = the first delivered forward clears the episode.

`defectClass`: not applicable (no agent-authored-artifact defect fixed). The convergence arguments above are the self-action declaration.
