---
title: "The Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery"
slug: "operator-channel-sacred"
author: "echo"
status: "draft"
parent-principle: "Signal vs. Authority"
eli16-overview: "operator-channel-sacred.eli16.md"
tracked-followups: "<!-- tracked: topic-28130 --> convergent audit of all instar for critical-path gates with the wrong fail-direction (this spec ships the standard + the MessageSentinel exemplar fix; the full audit is its own bounded workstream) [topic-28130]"
review-convergence: "2026-06-26T00:55:14.718Z"
review-iterations: 2
review-completed-at: "2026-06-26T00:55:14.718Z"
review-report: "docs/specs/reports/operator-channel-sacred-convergence.md"
cross-model-review: "skipped-abbreviated"
approved: true
approved-by: "echo (under Justin's standing blanket authority, topic 28130, 2026-06-24/25 — and his explicit directive to identify+integrate+apply the missing standard)"
approved-basis: "standing-authorization + explicit directive; convergence ran conformance + 2 bounded internal review rounds (cross-model deliberately skipped to avoid re-overloading the machine the incident-under-fix was crippling); operator may revert by editing frontmatter; full cross-model recommended at PR time on a healthy system"
cross-model-review-reason: "deliberately skipped external models to avoid re-overloading the machine the incident-under-fix was crippling; conformance + 2 bounded internal rounds ran; full cross-model recommended at PR time"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 1
contested-then-cleared: 0
---

# The Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery

## Problem statement

On 2026-06-25 (topic 28130) the operator was **completely locked out of instar** for an extended
period. Root cause: `MessageSentinel` runs an LLM classifier on EVERY inbound Telegram message
before routing it (`TelegramAdapter` ~L3917 and `routes.js` `/internal/telegram-forward` ~L14124).
When it returns `category:'pause'` it **CONSUMES the message** — sends "Session paused.\n\nSend a
message to resume." and `return`s without ever routing the message to the session. It
**misclassified benign messages ("Testing") as `'pause'`**, so:

1. The user's message was eaten (never reached the agent).
2. The user's NEXT message hit the same misclassification → eaten again.
3. The recovery instruction ("send a message to resume") routed the resume attempt **back through
   the same failing gate** → an **inescapable loop**. The operator could not get a single message
   through.

The misclassification was worsened by a machine overload (spawn-cap saturation from 305 accumulated
worktrees being indexed + autonomous churn) starving the classifier's LLM call, but the
**structural** defect stands on its own: a brittle classifier had unilateral authority to consume
the operator's messages, with the failure mode being "silence the operator."

### Why the existing guards didn't catch it

`MessageSentinel` already has a `MAX_PAUSE_DIRECTIVE_WORDS=25` length-guard: a LONG message
classified `'pause'` is downgraded to `normal` (born from the 2026-06-05 incident where ~200-word
coaching messages ending "…and stand by" were eaten). But a **SHORT** benign message ("Testing", 1
word) misclassified as `'pause'` sails through the guard and is consumed. The code's own comment
states the key fact: **"pause's value is politeness, not safety"** — so consuming a real message to
honor a *guessed* pause is a strictly bad trade.

This is the same brittle-gate class this session already fixed on OUTBOUND/detector paths
(CMT-1790 judge-by-meaning, CMT-1793 detector-emits-signal, CMT-1794 fail-closed-on-abstain,
CMT-1785 idle-error tail-gate) — but it was never applied to the **most critical gate of all: the
operator's inbound channel.** That is the blindspot.

## The missing standard (to integrate into `docs/STANDARDS-REGISTRY.md`)

### The Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery

**Rule.** A gate on the operator's PRIMARY communication channel (inbound user messages) must never
**consume or block** a message based on a single low-confidence, brittle signal. The **safe failure
direction for inbound operator comms is DELIVERY** — route the message to the agent. This is the
deliberate INVERSE of *No Silent Degradation* (which makes OUTBOUND leak-gates fail CLOSED): for the
inbound operator channel a missed control-signal (e.g. an un-honored "pause") is benign, but a
*blocked* message can sever the operator's ability to direct or recover the agent entirely. Four
sub-rules:

1. **Brittle signal ⇏ message-consuming authority on the critical path.** A decision that CONSUMES
   the operator's message (so it never reaches the agent) requires a **deterministic** match — never
   a bare LLM guess. A non-deterministic classification routes the message THROUGH and at most logs.
   **This route-through rule governs CONSUMING/pause gates, whose missed signal is benign** (an
   un-honored pause). It deliberately does NOT loosen genuine **emergency-stop**, whose missed signal
   is *destructive* (the founding incident: 200 emails deleted because a "stop" queued behind work) —
   emergency-stop keeps prefer-stop-when-in-doubt. The two are distinguished by **consequence of a
   miss**, not by being the same gate.
2. **The load-bearing safety property is RECOVERABILITY, not aggressiveness.** A control action is
   acceptable on a brittle signal ONLY if a false-positive is **escapable**: an emergency-stop kills
   the session but the operator can "send a new message to start fresh" — escapable. The pause bug
   was catastrophic precisely because it was **INescapable** (the "send a message to resume"
   recovery routed back through the same failing gate). So: any control action reachable by a brittle
   signal MUST have a recovery path that does NOT traverse the failing gate, and MUST be bounded by
   the circuit-breaker (sub-rule 4) so a false-positive stream cannot permanently sever the channel.
3. **Recovery must not route through the failing component.** A recovery instruction shown to the
   operator ("send a message to resume") must not depend on the very gate that failed — otherwise it
   is an inescapable trap. The mere ARRIVAL of a subsequent message is itself evidence the prior
   block may have been wrong.
4. **Bounded blast radius for decision-gates.** A single misclassification must not be able to lock
   the operator out. A self-evidencing circuit-breaker: repeated blocks on one topic while the
   operator keeps sending non-matching messages → auto-recover (stop blocking, route through). We
   bound blast radius for spawns (fork-bomb cap); decision-gates on the critical path need the same.

**Earned from.** 2026-06-25 (topic 28130): the MessageSentinel pause-misclassification locked the
operator out in an inescapable loop; the recovery instruction re-triggered the bug.

## Proposed design — apply the standard to MessageSentinel (the exemplar fix)

The fix makes the `'pause'` (and the message-consuming path generally) honor the standard. It is a
SIGNAL-vs-AUTHORITY narrowing: the classifier still SIGNALS, but only a deterministic/high-confidence
signal gets the AUTHORITY to consume the operator's message.

1. **Pause consumes ONLY on a deterministic match — never on a bare LLM verdict.** A `'pause'`
   consumes the message ONLY when it matches a deterministic pause pattern (the fast-path `/pause`,
   `pause`, `/^pause\b/i`, etc.). A pause from the LLM path alone NEVER consumes (review finding: the LLM assigns confidence 0.8 to a clean one-word "pause" *regardless of correctness* — confidence reflects parse-cleanliness, not truth — so NO numeric threshold is safe; the rule is deterministic-match-ONLY. A deterministic co-match alone consumes; the LLM verdict never adds consume authority.). A non-deterministic `'pause'` → **route through**
   (deliver to the session) + log + increment `sentinel.pause.routed-through`. This generalizes the
   existing length-guard from "downgrade long pauses" to "never consume a non-deterministic pause."
1b. **CRITICAL — the capacity-shed pause path (the actual 2026-06-25 mechanism) must route
   through.** `MessageSentinel.llmClassify` currently returns `category:'pause', confidence:0.4,
   action:pause-session` when its LLM call FAILS under spawn-cap saturation (a deliberate
   fail-closed "HOLD" borrowed from the fork-bomb/No-Silent-Degradation posture). This is exactly
   what fired during the incident: the spawn cap saturated → the classifier capacity-shed → it
   defaulted to PAUSE → consumed the operator's messages → lockout. On the INBOUND operator channel
   this fail-direction is INVERTED and wrong: a capacity-shed `'pause'` must **route through**, not
   consume. **Safety carve-out (verification finding — load-bearing):** the existing fast-path stop check is WORD-COUNT-GATED (≤4 words, `MAX_FAST_PATH_WORDS`), so a long-form genuine stop ("I need you to stop deleting everything right now") also falls to the LLM and capacity-sheds — blindly routing THAT through would re-create the OpenClaw failure (a real stop queued behind work). Therefore, before routing through ANY capacity-shed result, run a NON-word-count-gated deterministic STOP-token scan (the `FAST_STOP_EXACT` / stop regexes, substring, no length gate); if any stop token is present → fail toward STOP (kill-session), never route-through. Only a capacity-shed result with NO stop token present routes through (a genuinely benign message). This keeps the carve-out safe for BOTH short and long stops while still delivering benign messages — a deliberate, named exception to the fork-bomb fail-closed disposition for this one inbound branch, reconciling the two standards.
2. **Circuit-breaker (bounded blast radius).** Track recent pause-consumes per topic. If the topic
   was pause-consumed within a short window AND a new message arrives that does NOT deterministically
   match a pause/stop pattern, AUTO-RECOVER: route the message through (do not consume), and stop
   emitting "Session paused" for that topic until a deterministic control signal or a real reply
   resets it. The operator's continued messaging is treated as evidence the block was wrong.
3. **Recovery text decoupled.** The "resume" path must not require re-classification through the
   same gate — once the circuit-breaker trips, messages route normally regardless of classification.
4. **Emergency-stop policy preserved but bounded.** `emergency-stop` keeps its safety-first
   (deterministic fast-path + LLM) behavior, but is also subject to the circuit-breaker so a brittle
   false-positive stream cannot permanently sever the channel.

The change is monotonic toward DELIVERY: it can only REDUCE message-consumption (more messages reach
the agent), never block a message the old code would have delivered.

## Decision points touched

- **No new blocking authority — it REMOVES brittle blocking authority.** The classifier remains a
  signal; the change strictly narrows when that signal may consume a message. The safe direction is
  delivery; the worst case of the new logic is a missed pause (benign per the code's own comment).
- **Emergency-stop safety vs operator-lockout.** The one real tension: making consume harder could
  delay honoring a genuine "stop." Resolved by keeping the DETERMINISTIC stop fast-path fully intact
  (a real "stop" still fires instantly) and only narrowing the BRITTLE LLM consume path — and the
  circuit-breaker only triggers on NON-matching messages, so it never suppresses a deterministic stop.

## Frontloaded Decisions

1. **Pause consume = DETERMINISTIC-match ONLY (no bare-LLM threshold).** Review showed the LLM
   self-reports 0.8 confidence on a clean one-word "pause" regardless of correctness, so NO numeric
   threshold is safe — only a deterministic fast-path match may consume a pause. Both the LLM-pause and the **capacity-shed pause**
   (confidence 0.4 on an LLM failure) route THROUGH. This is the load-bearing decision; it is stated
   numerically (deterministic-only), not left to the builder.
2. **Circuit-breaker state: durable, topic-keyed, shared by BOTH consume paths.** Keyed by topicId;
   stored where it SURVIVES A SERVER RESTART (an in-memory breaker resets exactly when an
   overload-driven restart happens — i.e. when it's needed most), via a `stateDir`-backed ledger
   owned by `MessageSentinel`; consulted+updated by BOTH consume call-sites (`TelegramAdapter`
   processUpdate AND `routes.ts` `/internal/telegram-forward` — lifeline-owned agents like echo only
   hit the latter, so an in-one-path-only breaker is invisible). Concrete (reconciled at build): the breaker CAPS pause-consumes per topic per window — `breakerMaxPerWindow` (default 3) within `breakerWindowMs` (default 10 min); both config knobs on MessageSentinelConfig. Once the cap is hit, a further 'pause' (deterministic OR not) routes THROUGH (auto-recover) — so no pause stream can permanently seal the channel. emergency-stop is never gated by the breaker; a route-through always delivers (the breaker can only convert consume→deliver, never the reverse). Reset is by window expiry (the build dropped the assistant-reply reset as unnecessary: deterministic-only-consume is the primary guard, so the breaker is defense-in-depth and window-expiry alone prevents any permanent lockout). The recovered/disarmed state is **PAUSE-ONLY — it never disarms emergency-stop**.
   A wiring-integrity test asserts both paths consult+update the one shared store.
3. **Emergency-stop keeps deterministic fast-path + prefer-stop; only the message-CONSUMING pause
   paths are narrowed.** Its false-positive (a kill) is acceptable because it is RECOVERABLE
   ("send a new message to start fresh") — the distinction is recoverability, not aggressiveness
   (FD per standard sub-rule 2). The breaker bounds it for pause; a deterministic-stop stream is
   out of scope (a real "stop"-word stream is the operator's intent). <!-- tracked: topic-28130 -->
4. **The standard ships in the constitution in THIS change** (the fix without the standard is a
   point-patch; the standard is the durable guard).
5. **Multi-machine posture: machine-local** — message routing/interception is per the machine
   hosting the topic's session; no cross-machine state. (The standard itself is global guidance.)
6. **The convergent audit of all instar is a TRACKED bounded follow-up** (`tracked-followups`) <!-- tracked: topic-28130 --> — it
   spawns many reviewers and must be paced so it does not re-trigger the overload it audits; not
   bundled into this fix's blast radius.

## Observability (you can't tune what you can't see)

Beyond logging a suppressed signal, the fix emits structured counters so the gate's behavior is
auditable and tunable:
- `sentinel.pause.consumed` (a DETERMINISTIC-match pause that consumed a message),
- `sentinel.pause.routed-through` (a non-deterministic 'pause' that was DELIVERED instead of
  consumed — the new safe path; a rising count here is the false-positive rate this fix neutralizes),
- `sentinel.circuit-breaker.recovered` (a topic auto-recovered after a repeated-pause lockout pattern).
These feed the existing per-feature metrics surface (`/metrics/features`) under a `message-sentinel`
feature key, so "is the gate eating messages?" is a number, not a guess — and the circuit-breaker's
trip rate is visible. (Directly serves the standard: a critical-path gate must be observable.)

## Testing

- **Unit (`MessageSentinel`):** a short benign message ("Testing") that the LLM (mocked) returns
  `'pause'` for (any confidence) → ROUTES THROUGH (not consumed, because it is non-deterministic); a
  deterministic fast-path pause (`/pause`, exact "pause") → consumes; a capacity-shed result with a
  stop token → kill; a capacity-shed result with no stop token → routes through; the
  circuit-breaker: after a pause-consume, a following non-matching message auto-recovers (routes
  through). Both sides of every boundary.
- **Integration:** the `/internal/telegram-forward` + `TelegramAdapter` intercept paths route a
  benign message to the session instead of replying "Session paused"; a deterministic stop still
  intercepts.
- **E2E:** construct the real wiring; a stream of benign messages is never able to lock the channel
  (the circuit-breaker guarantees delivery) — the regression test for the exact 2026-06-25 lockout.
- **Wiring-integrity:** verify the MessageSentinel's dependencies are real and exercised, not
  no-ops — the circuit-breaker state store is actually consulted/updated on the consume path, the deterministic-match gate (NOT a numeric threshold) governs consume, and the observability counters actually increment on each
  branch (consumed / routed-through / recovered). A no-op circuit-breaker would silently reintroduce
  the lockout, so this is a required wiring test, not optional.
- **Conformance:** the new standard is parsed by the Standards-Conformance Gate (it reads the
  registry), so future specs are checked against it.

## Rollback

The MessageSentinel change is a behavioral narrowing behind the existing `externalOperations.sentinel`
config (which currently has `enabled:false` as the interim safeguard — this fix lets it be safely
re-enabled). Single-commit revert restores the prior consume logic. The standard is a docs addition.

## Open questions

*(none)*
