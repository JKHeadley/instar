---
title: "Outbound advisory — close the jargon + raw-file-path gaps for automated senders (inform-only)"
slug: "outbound-jargon-filepath-gap"
author: "echo"
revision: 2
revision-reason: "Operator constraint (Justin, topic 20905, 2026-06-10 11:24 PDT) postdates the r1 convergence tag by minutes: outbound infra must INFORM the sending agent BEFORE the send — never block. r1's deterministic 422 floor (§2.3) violated that; r2 replaces it with a preflight advisory + sender override. Re-converged after r2 panel round(s)."
review-convergence: "2026-06-10T21:45:00Z (r2, 3 rounds, internal 5-reviewer panel; externals skipped-abbreviated — see report)"
review-iterations: 3
review-report: "docs/specs/reports/outbound-jargon-filepath-gap-convergence.md"
parent-principle: "Structure beats Willpower"
prior-revision-convergence: "2026-06-10T18:30:12.526Z (r1, 3 rounds, 5-reviewer panel — see prior report; r1 verdicts on §2.1/§2.2 carry forward except where r2 marks changes)"
approved: true
approved-by: "Justin — explicit 'please enter a 12 hour autonomous session and tackle both' (topic 20905, 2026-06-10 12:20 PDT), conditioned on his 11:24 PDT constraint: inform-only, no blocking power. That constraint is the governing decision for this revision."
---

# Outbound advisory — close the jargon + raw-file-path gaps for automated senders (inform-only)

*topic 12143 → 20905 · 2026-06-10 · tracked as ACT-749. The durable Structure-over-Willpower fix
for the 2026-06-10 incident: a background job (`evolution-overdue-check`, Haiku) sent Justin an
overdue reminder that used dev jargon AND pasted a raw repo path instead of a clickable link — both
standing instar standards, both bypassed because the job composes its own Telegram escalation.*

> **Grounding correction (read first).** The original ACT-749 framing — "build a gate at the
> outbound chokepoint" — is WRONG: the chokepoint gate already exists. `MessagingToneGate` is
> "the single outbound-messaging authority," runs on `/telegram/reply` via `checkOutboundMessage`
> (`src/server/routes.ts:1492`), and ALREADY has a `B2_FILE_PATH` block rule + a jargon detector.
> This spec closes the SPECIFIC holes that let the job's message through, and — per a 5-reviewer
> convergence round — does so STRUCTURALLY (the kind is injected by the scheduler, not declared by
> the model) rather than re-introducing the willpower dependency the first draft hid.

## 0. Governing constraint (r2 — this overrides everything below it)

Justin, topic 20905, 2026-06-10 11:24 PDT, responding to this exact proposal:

> "sounds great, as long as this is integrated into infra that INFORMS the agent BEFORE the agent
> sends a message to the user rather than actually blocking the agent. Gates having blocking power
> is too dangerous"

Hard consequences for this design:

1. **Zero new blocking authority.** No deterministic block floor (r1 §2.3's 422 floor is DELETED),
   no new block rules, no re-scoping of existing block rules to new kinds (r1's B12 extension is
   DROPPED).
2. **The inform-only mechanism must reach the agent BEFORE the user sees the message** — feedback
   after delivery does not satisfy the constraint (the bad message already landed).
3. **The sending agent keeps final authority over its own send AT THE ADVISORY LAYER.** The
   advisory layer may inform, annotate, and audit; it may never be the entity that decides a
   message dies, and its override path always delivers PAST IT (see the honest scoping below).

**Honest inventory of PRE-EXISTING blocking power (untouched, named so the operator's separate
decision is made on true premises).** This spec adds an inform-only layer NEXT TO a pipeline that
already holds blocking surfaces. Leaving them untouched is the operator's standing state, not this
spec's endorsement; deciding their future is the separate conversation Justin has been offered. The
full inventory, verified against source:

- The `MessagingToneGate` LLM authority with its enumerated block rules — including `B2_FILE_PATH`,
  which is a BLOCK rule the authority applies on all kinds (`MessagingToneGate.ts:299`; "fail-open"
  describes only gate *unavailability*, not the rule's nature), and B12 (jargon, health-alert-scoped).
- The deterministic localhost-link 422 guard (`routes.ts:1317-1342`) — operator-mandated 2026-06-05;
  it 422s regardless of the LLM gate.
- The 4096-char length reject on `/telegram/reply`.
- The duplicate-message suppression window (infra silently dropping an exact repeat — a standing
  "infra decides a message dies" surface, named here for completeness).
- The `grounding-before-messaging.sh` PreToolUse hook (agent-side, exit-2 BLOCKING power on
  `telegram-reply` invocations; `src/templates/hooks/grounding-before-messaging.sh:52`).

**Interaction note:** an advised agent that fixes and re-runs passes through the grounding hook
again — one send can receive two differently-shaped quality interventions (the hook's and the
advisory's). They are independent layers; the advisory text must not imply it is the only check.

**Consequence for the override claim:** `--ack-advisory` delivers unconditionally **past the
advisory layer**. The pre-existing pipeline above — unchanged by this spec — still applies after
it, exactly as it does to every send today. The advisory text must never claim ack guarantees
delivery (see §2.4's localhost special case, where the pre-existing 422 guard WILL refuse the send
regardless of ack — the advisory says so honestly).

## 1. Problem statement — why the existing gate missed it

`checkOutboundMessage` is well-built and signal-vs-authority compliant: deterministic detectors
emit signals, the LLM authority (`MessagingToneGate.review`) makes the single block/allow decision,
fail-OPEN on gate unavailability so a slow gate never traps a legitimate message. Three grounded
gaps let the job's reminder through:

**Gap 1 — jargon is never detected on `/telegram/reply`.** `checkOutboundMessage` collects the
jargon signal only when its caller passes `options.jargon === true` (`routes.ts:1358-1365`); the
`/telegram/reply` handler calls it WITHOUT `jargon` (`routes.ts:7760`). So `detectJargon` NEVER
runs for a Telegram reply — job OR main agent. The dev-jargon half is structurally un-checked on
the primary path.

**Gap 2 — raw-file-path detection has no deterministic everyday surface.** A literal repo path is
caught by `B2_FILE_PATH` — but only when the LLM authority runs AND fires. It does NOT run when
the send is `isProxy`/`isSystemTemplate`/`willRelay` (`routes.ts:7755-7759`), and the authority is
fail-OPEN on timeout/error/rate-limit (`routes.ts:1480`). Nothing deterministic ever tells the
SENDER "this message shows the user a raw path" — neither before nor after the send.

**Gap 3 (the root cause the first draft missed) — an automated job send is indistinguishable from
a conversational reply.** `telegram-reply.sh` POSTs `{text}` with no message-kind, so EVERY send
defaults to `'reply'`. The system judges a background-job alert with the SAME lenient bar it uses
for the main agent's conversation. The incident message was lenient-barred because nothing told the
infrastructure it was an automated alert. This is the gap that actually matters: **the system
cannot currently tell an automated message from a conversational one**, and both of the above gaps
are downstream of it.

## 2. Design

Three targeted changes inside the EXISTING seam — NO new gate, NO new blocking authority. The spine
is making the automated-vs-conversational distinction **structural**; the corrective surface is an
**advisory preflight that informs the sending agent before delivery and always defers to it**.

### 2.1 Structural automated-kind (the spine — model-proof for the mandated send path)

*(Carried forward from r1 unchanged except where marked. r1 convergence verdicts on this section
stand.)*

The first draft made a background job DECLARE `--kind automated` — which the same Haiku model that
already ignored the standards would have to remember to type. That is the willpower trap. Instead,
the **scheduler stamps the kind into the job session's environment**, so it binds regardless of
what the model does ON THE MANDATED RELAY PATH (`telegram-reply.sh`, which CLAUDE.md requires for
every reply):

- **Spawner env injection (BOTH spawn env blocks).** `SessionManager.spawnSession` injects
  `INSTAR_SESSION_ID`, `INSTAR_AUTH_TOKEN`, `INSTAR_AGENT_ID`, etc. via tmux `-e` and accepts
  `jobSlug`. Add, ONLY when `jobSlug` is set: `'-e', 'INSTAR_MESSAGE_KIND=automated'`
  (and `'-e', \`INSTAR_JOB_SLUG=${jobSlug}\`` — the slug is read at `PostUpdateMigrator.ts:8701` but
  currently NEVER set, a dead signal this revives). There are **TWO** env blocks that must both get
  this: the standard spawn block (`SessionManager.ts:1742-1756`, launchLane `'headless'`) AND the
  **rerouted-interactive lane** (`~:1983-2051`, `launchLane === 'rerouted-interactive'`, which also
  carries `jobSlug`) — this is the lane the June-15 subscription-path lever routes job spawns
  through, so omitting it would leave a structural hole for exactly those job sessions. (The third,
  interactive env block ~`:3118` carries no `jobSlug` and is correctly untouched.) The script-mode
  job env (`JobScheduler.ts:757-761`, the `runScriptJob` env — NOT the `:1450` `gateEnv`, which is
  the zero-token pre-screen, not a send path) gets the same `INSTAR_MESSAGE_KIND=automated` **plus
  `INSTAR_SENDER_CLASS=script` (r2 — see §2.4: a script sender cannot read or react to an advisory,
  so the preflight must not withhold its sends)**. LLM job sessions get
  `INSTAR_SENDER_CLASS=llm-session`. Interactive (non-job) sessions get NONE of these → they stay
  `'reply'`. Env injection is tmux `-e` and framework-agnostic — codex/gemini job sessions spawned
  through the same lanes get the same ambient kind.
- **Script forwarding (BOTH body builders).** `telegram-reply.sh` reads `$INSTAR_MESSAGE_KIND` and
  `$INSTAR_SENDER_CLASS` (default empty) and, when non-empty, adds a
  `metadata: { messageKind, senderClass }` object to the POST body. (Forwarding `senderClass` too
  is an r2-round-2 addition: it lets the server's breadcrumb distinguish a script-class send from a
  class-spoofed llm-session send — see the visibility note below.) The script has no `metadata`
  object today (it sends `{text, format}`), and it builds the body two ways — a `python3` one-liner
  AND a `sed`-based fallback used when python3 is absent. BOTH builders must carry the fields, or a
  python-degraded agent silently drops them → the incident recurs. The job model types nothing
  different — the script and env do it.
- **Route threading.** `/telegram/reply` reads `metadata.messageKind` and passes it to
  `checkOutboundMessage({ messageKind })` (the route already reads `metadata` at `:7687`).
- **No job-template change.** `evolution-overdue-check.md` (and every other job) is UNCHANGED — the
  kind is ambient.
- **Honest scope of "model-proof" (round-2 correction).** The guarantee binds for sends via
  `telegram-reply.sh` (the path CLAUDE.md mandates). A job that *hand-curls* `/telegram/reply`
  directly bypasses the script, sends no `metadata`, and defaults to `'reply'`, evading the
  advisory. A raw localhost POST carries no server-visible session identity, so deriving the kind
  server-side would need new infra (binding a per-session token to the kind) and is OUT OF SCOPE
  here. This residual is named in §7, not hidden. Two visibility mechanisms bound it:
  - The route logs an observability breadcrumb when a send whose topic maps to a job session
    arrives WITHOUT a `messageKind` (the topic→session→`jobSlug` lookup is available server-side
    even when the body omits the kind). Sends carrying the `X-Instar-DeliveryId` redrive header
    (exact name — verified against `delivery-failure-sentinel.ts:739`; a misspelled exemption
    would false-positive on every legitimate redrive) are EXEMPT from the breadcrumb ONLY when the
    id matches an actual `PendingRelayStore` row (`delivery_id` is the PK — one lookup; a
    fabricated header must not buy the exemption). Legacy queued rows may lack a kind; a sentinel
    redrive is not a bypass — see §2.5.
  - A send arriving with `messageKind:'automated'` whose topic maps to a job session but with NO
    corresponding preflight audit row in the recent window is breadcrumbed as a possible
    class-spoof or script-modification (visibility only — sovereignty over the send is accepted).
    Two precision rules (r2 round-3): the correlation counts only PREFLIGHT-written
    `clean`/`advised` rows — a send's own `acked` row (written by `/telegram/reply` itself on a
    hand-set `advisoryAck:true`) must not self-license it; and the check is scoped to the
    ORIGINATING machine (a relay holder's preflight rows live on the originator — a holder must
    not false-fire on relayed sends).
  - A `senderClass` declaration is validated server-side against the job definition where one
    exists (the scheduler KNOWS whether `jobSlug` X is script-mode — a declared `script` class on
    an LLM-session job is breadcrumbed as a spoof rather than trusted; r2 round-3).
  - The CLAUDE.md template's hand-curl example of `/telegram/reply` is REMOVED/redirected to
    `telegram-reply.sh` in this same PR (§5) — no boot-context map to the bypass.

A new `messageKind` value `'automated'` is threaded through the union — it exists in FIVE places
today (`MessagingToneGate.ts:203`, `:281`, `:458`; `routes.ts:1313` (`evaluateOutbound`), `:1501`
(`checkOutboundMessage`)), all `'reply' | 'health-alert' | 'unknown'`. All five widen to add
`'automated'`, plus a `renderMessageKind` branch (`MessagingToneGate.ts:458`) describing it to the
authority. **(r2 change from r1:) The jargon strictness rule B12 is NOT extended to `automated`** —
extending a block rule's scope is new blocking power, which §0 forbids. The authority receives the
kind and the signals as accurate context for the judgment power it ALREADY has; no rule re-scoping.
`'reminder'` is NOT a separate kind — `automated` covers all job escalations.

### 2.2 Always-compute the jargon signal — for non-`reply` kinds (Gap 1)

*(Carried forward from r1; consumer note updated for r2.)*

Make `checkOutboundMessage` compute `detectJargon` itself (drop the `if (options.jargon)` opt-in),
single-sourced so ALL channels (telegram/slack/whatsapp/imessage) get it uniformly — gated by a
`messaging.outboundFloor.jargonAlways` flag (default on). **Scoped to non-`reply` kinds**: jargon
is computed for `health-alert | automated`, NOT for conversational `reply`. Rationale (a round-1
finding): the gate's jargon rule (B12) is scoped to health-alerts and explicitly does NOT apply to
conversational replies ("prose discussion of internals is fine"), so feeding a jargon signal on a
`reply` is dead weight that only adds LLM reasoning-drift / over-block tail — the exact over-block
the operator's repeated feedback warns against. `detectJargon` is cheap deterministic regex (~28
anchored terms, sub-ms server work), so the cost is negligible; the scope choice is about
over-block, not cost. The existing try/catch (a detector error skips the signal, never blocks) is
preserved.

**r2 consumers:** on `health-alert` the signal feeds B12 exactly as today. On `automated` the
signal has two inform-only consumers: it is included in the context the existing authority sees
(no new rule), and it drives the §2.4 preflight advisory back to the sending agent.

### 2.3 A deterministic raw-file-path SIGNAL (Gap 2) — detector only, no floor

Add `detectRawFilePath(text)` — a sibling of `detectLocalhostLink`, held to the SAME linear-regex
discipline (`localhost-link.ts`'s `LOCALHOST_LINK_RE` is bounded char-classes, no nested
quantifiers). Hard requirements (round-1 must-fixes, all carried forward):

- **ReDoS-safe + bounded.** Linear, non-backtracking pattern; bounded segment count/length; an
  `indexOf` prescreen for path-ish substrings (`/`, `~/`, `.instar/`, `src/`, `/Users/`) so the
  regex only runs when a path is plausibly present. Must NOT match inside an `http(s)://` URL
  (URLs containing paths are the legitimate form to preserve). A ReDoS regression test feeds a 4KB
  pathological input and asserts bounded time.
- **Bounded match echo.** The returned match stops at the first whitespace/quote/`?`/`#`/`)`
  (mirror `localhost-link.ts`'s char-class boundary) and is truncated (≤120 chars) before it is
  echoed in any advisory message or audit line — so a secret adjacent to a path
  (`.../foo.env?token=…`) can never ride into logs/transcripts.
- **Fail-OPEN on error.** Every call site wraps the detector so a throw skips the signal — never a
  500, never a withheld message. Unit test: "detector throws → message delivered, not 500."

Two inform-only uses:

- **SIGNAL to the existing authority (all kinds).** Feed `signals.filePath = { detected, match }`
  into `review`, anchoring the existing `B2_FILE_PATH` judgment with the exact deterministic match.
  On every kind this is a SIGNAL the authority weighs — a legitimate "I edited `src/foo.ts`" stays
  the authority's call. No new rule, no floor.
- **ADVISORY to the sending agent (automated kind only)** — via the §2.4 preflight, BEFORE the
  message is delivered.

### 2.4 The preflight advisory — inform the sender BEFORE the send (r2, replaces r1's floor)

**Honest naming (r2 round-2).** Mechanically, an advisory bounce is a **default-withhold the
sender always resolves**: the first flagged attempt does not deliver, and the infra-chosen
disposition on sender inaction is non-delivery. We name that plainly rather than claiming "no
authority at all." It is the minimal disposition that satisfies the operator's "inform BEFORE the
send" — informing after delivery was explicitly rejected, and informing without pausing is
physically impossible (the send either happened or it didn't). What keeps it inside the inform-only
constraint: the withhold is always and only resolved by the SENDER (fix, or ack — both fully in
its power, both always available, both delivering), never escalates, never consults a judge, and
fails open in every error path. The infra never wins an argument with the sender; it only
guarantees the sender was told first.

**The mechanism.** `telegram-reply.sh` gains a preflight step, active ONLY when
`INSTAR_MESSAGE_KIND=automated` AND `INSTAR_SENDER_CLASS=llm-session` (a sender that can read and
react to feedback):

1. Before POSTing the send, the script calls `POST /messaging/preflight` with
   `{text, messageKind, topicId, jobSlug}` (Bearer-authed + `X-Instar-AgentId`, same credentials
   the script already holds). **`topicId` and `jobSlug` are REQUIRED in the body (r2 round-3): the
   audit row (§2.4(5)), the escalation (§2.4(6)), and the class-spoof correlation (§2.1) all key on
   them, and a localhost POST carries no server-visible session identity to derive them from. They
   are sender-supplied — consistent with the accepted-sovereignty posture; a sender that lies about
   them is in the same accepted dodge class as one that unsets its kind env.** The endpoint runs
   ONLY the deterministic detectors (`detectJargon`, `detectRawFilePath`, `detectLocalhostLink`) —
   no LLM call — and returns `{advisories: [{code, match?, guidance}]}`. The route caps analyzed
   text at 64KB (consistent with the pipeline's 4096-char downstream reject; detector work stays
   sub-ms). **Enum validation at both boundaries (r2 round-3):** the server coerces an unrecognized
   `messageKind`/`senderClass` to `'unknown'` before threading it anywhere (TypeScript unions don't
   validate at runtime; the value reaches the gate prompt, the audit, the relay hop, and the queue
   column); the script validates the env values against the literal enum before use. It is
   **fail-OPEN end-to-end**: endpoint unreachable, timeout, non-200, malformed JSON, server down →
   the script proceeds directly to the send as if the preflight returned empty.
2. **No advisories → send proceeds immediately.** One extra localhost round-trip; the user-visible
   path is unchanged.
3. **Advisories present (and no ack flag) → the script does NOT send.** It prints an advisory
   block to stdout — which lands in the sending agent's transcript as tool output, i.e. the agent
   is INFORMED — and exits 0. Requirements on that block (r2 round-2 hardening):
   - **The FIRST line is machine-unmissable and literal:**
     `NOT SENT — advisory (fix and re-run, or re-run with --ack-advisory to send unchanged)`.
     A weak model that pattern-matches success on "no error output" must still collide with an
     explicit NOT SENT. The §6 E2E asserts this exact first line.
   - **Exit code 0 is deliberate and bounded to the advisory case:** in this script's contract,
     non-zero means delivery failure and triggers queue/retry semantics in callers; an advisory is
     neither — the message was deliberately not yet sent and the next move belongs to the agent.
     The NOT-SENT first line, not the exit code, is the signal. (The existing 422-block path keeps
     its exit 1 — that IS a refusal.)
   - **Advisory composition is injection-pinned:** `guidance` is a STATIC string keyed by `code` —
     never derived from message content. The detector `match` is rendered as an inert, delimited,
     quoted token under a fixed label (e.g. `detected: "src/foo/Bar.ts"`), never spliced into
     instruction-shaped prose. Unit test: a match containing imperative text appears only inside
     the quoted token.
   - **The localhost-link advisory is special-cased for honesty:** its static guidance states that
     the server's pre-existing deterministic guard will refuse a raw localhost link REGARDLESS of
     ack (use the tunnel URL form instead). The advisory layer never promises ack-delivery for a
     finding class an older, untouched blocker will still refuse.
   - The fix path is listed BEFORE the ack path (default-bias toward fixing).
4. **`--ack-advisory` (flag form ONLY — r2 round-2: the `INSTAR_ADVISORY_ACK` env form is DROPPED;
   a standing env export would be a blanket pre-ack that silently disables the inform layer
   forever, the exact willpower trap §2.1 exists to close).** An ack-flagged invocation STILL runs
   the preflight (it never withholds) — so the audit records exactly which advisories were
   overridden, including `advisories: []` (a preemptive ack on a clean message, itself a signal).
   The send proceeds unconditionally past the advisory layer (§0 scoping), and the send body
   carries `metadata.advisoryAck: true` plus the overridden advisory codes — this annotation is
   REQUIRED (it is how the server audits `acked` as the single writer) and is message-store-visible
   to observability only, never to the user.
5. **Audit (single writer: the SERVER).** Every preflight outcome is one line in
   `logs/outbound-advisory.jsonl`, appended server-side with a single `write()` per line
   (O_APPEND): `{ts, topicId, jobSlug, kind, textHash, advisories, action:
   'clean'|'advised'|'acked'}` (the text hash — of the analyzed text — lets the escalation match a
   later clean/acked resolution to the specific flagged message; r2 round-3). `clean`/`advised`
   are written by the preflight route; `acked` is written by `/telegram/reply` when it sees
   `metadata.advisoryAck`. The script writes NOTHING to the audit file (no second writer): a
   fail-open (preflight unreachable) is a script-side stderr breadcrumb only, and the server
   cannot log what it never saw — accepted, since fail-open frequency is observable from the
   server's own availability record. A small read-only surface makes the measurability claim
   real: `GET /messaging/advisory-log?limit=N` (Bearer-authed). **Read strategy + growth bound
   (r2 round-3 — this file gains one line per automated send forever, `clean` rows dominating;
   per-send full-file scans would grow linearly with agent lifetime):** because the server is the
   single writer, it maintains an in-memory recent-window index at write time (per-signature
   advised counters + a recent-row set), making the §2.4(6) escalation check and the §2.1
   spoof-correlation O(1) per send; the JSONL is the durable record only (index resets on restart
   are accepted for best-effort observability — stated, not hidden). The GET route reads a bounded
   tail (last N KB), NOT the whole file (do not inherit the reap-log's full-file `readFileSync`
   verbatim — that precedent is rare-event-volume), and the file is size-rotated (single rollover
   at a configured byte cap, e.g. 10MB, keeping one `.1` predecessor).
6. **Repeated-ignore escalation (r2 round-2: REQUIRED ship content — formerly Open Q1, promoted
   because it is the load-bearing bound on this design's worst failure mode).** The same
   sender+detector signature re-producing `advised`-then-silent every cycle would otherwise
   suppress a recurring notice indefinitely — strictly worse than today's ugly-but-delivered. A
   server-side check (fed by the §2.4(5) in-memory write-time index; no new poller, no file scan)
   detects unresolved `advised` rows and raises ONE aggregated, deduped Attention item ("job X is
   dropping its own messages after advisories — N instances") — informing the OPERATOR, never
   gating the agent. **Counting mechanics (r2 round-3 — "N consecutive per jobSlug+topicId" was
   reset-gameable: a job emitting one clean heartbeat alongside its advised-and-dropped reminder
   would reset every cycle and never escalate):**
   - The count keys on the SIGNATURE (`jobSlug`, `topicId`, sorted advisory-code-set) and counts
     `advised` rows in a rolling window REGARDLESS of interleaved `clean` rows for other messages.
     A signature's count resolves only on an `acked` with the same codes or a `clean` preflight of
     the SAME message (matched via the audit row's `textHash` — a near-identical re-send that now
     passes clean is the fix landing).
   - A per-`jobSlug` AGGREGATE count (across topics, higher threshold, topic list carried in the
     item body) covers one-shot senders whose topics vary (e.g. `dispatch-action`) — without it,
     per-topic-varying one-shots would sit outside the bound entirely.
   - Defaults N=3 per signature / N=5 per-slug aggregate, config
     `messaging.outboundAdvisory.ignoreEscalationThreshold` / `.ignoreEscalationSlugThreshold`.
   - **Preemptive-ack consumer (r2 round-3 — the `advisories:[]` ack was called "a signal" with no
     consumer):** the same mechanism also raises (deduped, same budget) on N consecutive
     `acked`-with-NONEMPTY-advisories per signature — a job habitually overriding instead of
     fixing is operator-relevant. Informs only; gates nothing.
   - P17-compliant: deduped per signature, never per-event; Attention items carry the FIXED
     `sourceContext: 'outbound-advisory-escalation'` (never per-signature source labels — the
     2026-06-05 lesson) so the per-source topic budget genuinely binds; the §6 burst test proves
     many distinct misbehaving signatures produce topics ≤ the budget.

**Why this satisfies §0.** The agent is informed BEFORE the user sees anything (constraint 2); the
only entity that resolves a withheld send is the sending agent itself, and the override always
delivers past the advisory layer (constraint 3, honestly scoped in §0); no block rule, no 4xx
wall, no LLM judge anywhere in the new surface (constraint 1).

**The honest failure mode (named, bounded — r2 round-2 sharpened).** A sender that ignores the
advisory and never re-runs has dropped its own message. Two sub-cases:
- **Recurring senders** (cron jobs, overdue-reminder loops): the next cycle re-fires, and because
  the same model + same detectors + same message shape plausibly reproduce the same
  advise-then-silence, recurrence alone is NOT the bound — the §2.4(6) escalation is. By the Nth
  silent drop the operator holds an Attention item naming the job.
- **One-shot senders** (NOT all `jobSlug` bearers recur — verified counterexample:
  `DispatchExecutor.runAgentic` spawns one-shot `jobSlug:'dispatch-action'` sessions,
  `src/core/DispatchExecutor.ts:573-578`; manual job runs share the shape). For these a dropped
  message has no re-fire behind it; the escalation (which keys on audit rows, not cron schedules)
  still fires after the threshold is met across instances, and the advisory's NOT-SENT first line
  plus fix-first ordering is the per-instance mitigation. This residual cost of inform-only is
  accepted and stated, not hidden.

Script-class senders (`INSTAR_SENDER_CLASS=script`) skip the preflight entirely: there is no agent
to inform. Their sends deliver exactly as today and rely on the existing authority's signals.
**What the preflight may NEVER become:** an auto-rewriter (silently "fixing" the message itself) or
a delivery veto. Those require a new operator decision.

### 2.5 Placement + the honest bypass scope

- The preflight lives in `telegram-reply.sh` (the mandated relay path) + a new route
  (`POST /messaging/preflight`). It does NOT touch `checkOutboundMessage`'s control flow — the
  existing gate pipeline is unchanged except for receiving the new signals (§2.2, §2.3).
- `isProxy`/`isSystemTemplate`/`willRelay` sends skip `checkOutboundMessage` today and are
  untouched by this spec — those are system-composed, not agent-composed, so there is no sender to
  inform. Named residual, unchanged from r1.
- The cross-machine `willRelay` case: the relay MUST forward `metadata.messageKind` (and
  `senderClass`) to the holder's `/telegram/reply` so the kind survives the hop. Honest sizing
  (r2 round-2): this is a three-layer signature widening — `TelegramAdapter.sendToTopic` options →
  `outboundRelay` (`TelegramAdapter.ts:542`) → the relay POST body in `TelegramRelay.relayOutbound`
  — plus the holder route already reading metadata (`:7687`). An integration assertion covers the
  kind surviving the hop end-to-end. (The preflight already ran on the ORIGINATING machine — it is
  a sender-side mechanism and does not re-run on the holder.)
- **The failure-retry queue must carry the metadata (r2 round-2/-3 — previously a silent hole).**
  A clean/acked automated send that fails recoverable (5xx/000) is queued in `PendingRelayStore`,
  whose schema today has no metadata column, and the `DeliveryFailureSentinel` redrive would
  re-send it kindless — mis-kinding the holder-side signals AND false-positive-firing the §2.1
  breadcrumb on every legitimate redrive of a job message. Worse (round-3): dropping
  `advisoryAck` on the queue hop means an acked-then-queued send never writes its `acked` audit
  row — the trail ends at `advised`, which is EXACTLY the §2.4(6) escalation signature, so
  transient delivery failures would false-fire the "job is dropping its own messages" item.
  Resolution: the queue row carries a nullable SERIALIZED METADATA column (kind, senderClass,
  advisoryAck + overridden codes), and the redrive forwards it whole. Concretely:
  - BOTH script queue writers get the column — the python3 stdlib-sqlite3 writer AND the
    `sqlite3` CLI fallback (each has its own `CREATE TABLE IF NOT EXISTS` + INSERT; the spec's
    both-builders standard applies here identically — a python-degraded agent must not queue
    metadata-less rows). The CLI fallback's INSERT interpolates shell variables into SQL today:
    the new values pass ONLY as validated-enum literals / parameterized JSON written via stdin,
    never raw interpolation (a quote-bearing env value must not inject into the queue DB).
  - **Existing-DB migration path:** the table already exists on every deployed agent, so the
    column arrives ONLY via the idempotent-ALTER conventions both writers already carry — a new
    `COLUMN_ADDS` entry in `pending-relay-store.ts` AND the parallel try/except-duplicate-column
    ALTER in the script's inline python + CLI bootstrap. A test inserts against a pre-column DB
    and asserts success (an implementer who only edits CREATE TABLE ships an INSERT that throws
    `no column named message_metadata` on every existing agent — failing the queue write that
    exists to save the message). Dual-writer version skew is safe because each writer self-heals
    the schema on open.
  - The sentinel's `postReply` threads the metadata through; legacy rows predating the column
    redrive metadata-less and ride the delivery-id breadcrumb exemption (§2.1).
- A job that hand-curls `/telegram/reply` bypasses the preflight (no script) AND the kind (no
  metadata): same residual as §2.1, same breadcrumb, minus the CLAUDE.md map to it (removed, §5).

## 3. Decision points touched (signal-vs-authority)

- **Jargon (2.2):** pure SIGNAL — fed to the existing authority (no new rule) and to the preflight
  advisory. No new authority.
- **Raw-path signal (2.3):** pure SIGNAL fed to the existing authority on all kinds. No new
  authority.
- **Preflight advisory (2.4):** a **default-withhold the sender always resolves** — honestly named
  (r2 round-2; see §2.4's first paragraph). Not "no authority at all": the first flagged attempt
  deliberately does not deliver. It is the minimal disposition that can inform BEFORE the send;
  it never escalates, never judges, always defers to the sender, and fails open. r1's deterministic
  block authority is deleted per the §0 operator constraint; the cost-asymmetry argument that
  licensed it in r1 is explicitly OVERRIDDEN by the operator's judgment that blocking power in
  messaging infra is the greater danger.
- **Repeated-ignore escalation (2.4(6)):** informs the OPERATOR (one deduped Attention item);
  gates nothing.

## 4. Open questions — all resolved in r2 convergence (decisions recorded)

1. **Repeated-ignore escalation** — RESOLVED: required ship content, not optional (§2.4(6)). It is
   the load-bearing bound on the design's worst failure mode; leaving it floating would be an
   untracked intention (Close-the-Loop).
2. **Preflight scope** — RESOLVED: `automated`+`llm-session` only. The conversational path already
   has the full authority pipeline; the operator's over-block concern argues against any new
   friction there.
3. **Ack annotation** — RESOLVED: REQUIRED, not optional. `metadata.advisoryAck` is the mechanism
   by which the server (single audit writer) records `acked` at all; message-store-visible to
   observability only.
4. **Ack env form** — RESOLVED: dropped. Flag-only (`--ack-advisory`), per the standing-pre-ack
   willpower-trap finding.

## 5. Migration parity (concrete)

- **Scheduler env injection (`src/` — auto-reaches all agents on update, no agent-file migration):**
  BOTH `SessionManager.spawnSession` env blocks — the standard one (`:1742-1756`) AND the
  rerouted-interactive lane (`~:1983-2051`) — plus the `JobScheduler` `runScriptJob` env
  (`:757-761`; NOT the `:1450` `gateEnv` pre-screen) add `INSTAR_MESSAGE_KIND=automated`
  (+ `INSTAR_JOB_SLUG`, + `INSTAR_SENDER_CLASS` per §2.1) when `jobSlug` is set.
- **`telegram-reply.sh` (agent-installed → needs the SHA re-deploy):** add (a) `$INSTAR_MESSAGE_KIND`
  + `$INSTAR_SENDER_CLASS` forwarding in BOTH body builders (python3 + sed-fallback), (b) the §2.4
  preflight step + `--ack-advisory` flag. **Timeout mechanics (r2 round-2 — the fail-open contract
  depends on getting this right):** the script reads `messaging.outboundAdvisory.timeoutMs` from
  `.instar/config.json` if present (hardcoded default 2000), converts ms→s for `curl --max-time`
  (curl takes SECONDS) with ceil division and a clamp to [1s, 10s] — a unit test asserts the
  generated curl argument is in seconds and within the clamp (a raw `--max-time 2000` would be a
  ~33-minute fail-HANG, inverting the contract; `$((MS/1000))` on values <1000 would yield 0 =
  no timeout at all). The re-deploy is `migrateReplyScriptToPortConfig`
  (`PostUpdateMigrator.ts:9101`), gated by `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS` (`:9055`). Round-1
  found the CURRENT live template SHA (`3e30b2cd…`) is NOT in that set — so a stock script is
  treated as "unknown" and left untouched (writes a `.new` + degradation event). The PR MUST add
  the **current live SHA** to the allowlist (the new template's own SHA is the idempotent
  self-match and does NOT need to be in the prior-shipped set), or the preflight never reaches
  existing agents.
- **`messageKind` union (`src/`):** widen the union in all FIVE sites (`MessagingToneGate.ts:203`,
  `:281`, `:458`; `routes.ts:1313`, `:1501`); add `renderMessageKind` branch. NO B12 re-scope
  (§2.1 r2 change).
- **New routes (`src/`):** `POST /messaging/preflight` (Bearer-authed via the global middleware —
  verified not in the exemption list — deterministic detectors only, 64KB analyzed-text cap,
  fail-open contract documented in the route) and `GET /messaging/advisory-log` (read-only,
  Bearer-authed).
- **Config plumbing (r2 round-2):** `messaging.outboundFloor.jargonAlways`,
  `messaging.outboundAdvisory.{enabled, timeoutMs, ignoreEscalationThreshold}` are read LIVE per
  request with code-level `?? true`/defaults (no ConfigDefaults seed — absence = on — so the
  rollback-without-restart claim in §7 holds). Implementation note: `src/server/routes.ts` has no
  `liveConfig` handle today — thread `LiveConfig` (the existing mtime-staleness re-reader,
  `src/config/LiveConfig.ts`, precedent: `fileRoutes.ts:226`) into the route context; a
  boot-snapshotted `ctx.config` read would silently break the rollback claim.
- **PendingRelayStore + DeliveryFailureSentinel (r2 round-2/-3):** add the nullable serialized
  METADATA column (kind, senderClass, advisoryAck + overridden codes) to the queue schema — BOTH
  script queue writers (python3 + sqlite3-CLI fallback, quote-safe) AND `pending-relay-store.ts`,
  via the existing idempotent-ALTER conventions (`COLUMN_ADDS` entry + script inline ALTER; test:
  INSERT against a pre-column DB succeeds); thread through the sentinel's `postReply`; redrive
  sends carry the metadata whole (so an acked-then-queued send still audits `acked`); legacy
  metadata-less rows ride the delivery-id breadcrumb exemption (§2.1, exact header
  `X-Instar-DeliveryId`, id validated against an actual queue row).
- **Single-source jargon cleanup (`src/`):** dropping the `if (options.jargon)` opt-in
  (`routes.ts:1358`) makes the one existing caller that passes `jargon` — the attention/health-alert
  site (`routes.ts:8438`, `jargon: isHealthAlert`) — pass a now-vestigial arg; remove it in the same
  PR, and assert (test) the health-alert path still gets jargon via the new `messageKind` gate.
- **Route (`src/`):** read `metadata.messageKind`, pass to `checkOutboundMessage`; relay path
  forwards `metadata.messageKind`+`senderClass` to the holder (§2.5 three-layer widening).
- **CLAUDE.md awareness:** `generateClaudeMd()` (new agents) + a `migrateClaudeMd` appended,
  content-sniffed subsection (existing agents) documenting: automated/job messages get a preflight
  advisory for raw paths/jargon; the advisory is information — fix and re-send, or `--ack-advisory`
  to send unchanged; an advised job should publish a private view + send the link. **In the same
  pass: remove/redirect the template's hand-curl `/telegram/reply` example to `telegram-reply.sh`
  (r2 round-2 — don't ship a printed map to the named residual). Cross-framework parity: register
  the new section's marker in `migrateFrameworkShadowCapabilities` (`PostUpdateMigrator.ts:5124`)
  so codex/gemini AGENTS.md mirrors get it** (mitigation either way: the advisory block itself
  names both next moves inline at the moment they matter).
- **NO job-template migration:** the job `.md` files are unchanged (the kind is ambient).

## 6. Standards / parity + tests

- **Structure > Willpower:** the automated kind + sender class are injected by the scheduler, not
  declared by the model — a job cannot forget to be advised (§2.1, §2.4); the standing-pre-ack env
  hole is closed by design (flag-only ack).
- **Signal-vs-authority:** §3 — honest naming included; zero NEW blocking authority; the one r1
  authority (the floor) is deleted per operator constraint; §0 carries the full pre-existing
  blocker inventory so the separate operator conversation starts from true premises.
- **Migration parity:** §5 (concrete functions, the SHA allowlist amendment, queue-schema
  migration, shadow-mirror registration, no job-template change).
- **Testing Integrity (all three tiers):**
  - **Unit:** `detectRawFilePath` true/false table (paths shown as references match; backtick prose
    + `http(s)://` URLs + conceptual mentions do NOT); ReDoS pathological-input bounded-time test;
    bounded match echo stops before an adjacent `?token=…`; detector-throw → signal skipped, send
    proceeds (not 500); jargon computed for automated/health-alert but NOT reply; preflight
    decision logic: advisories for automated+llm-session, empty for reply kind, skipped for
    script class, fail-open on detector throw; advisory composition: static guidance keyed by
    code, match rendered only as inert quoted token (imperative-text match test); ack invocation
    still runs preflight and audits overridden advisories incl. `[]`; curl timeout arg is seconds
    within [1,10] clamp.
  - **Integration:** `POST /messaging/preflight` with an `automated` raw-path text → 200 with
    advisories (never 4xx); same text as `reply` kind → empty advisories; `/telegram/reply`
    DELIVERS a raw-path automated message exactly as today (proving the server never blocks — the
    advisory loop is script-side); `metadata.advisoryAck` → server writes the `acked` audit row;
    jargon signal reaches the gate on an automated send; a relayed automated send arrives at the
    holder with the kind intact (§2.5); a sentinel redrive carries the kind (new column) and a
    legacy kindless redrive does NOT fire the breadcrumb (delivery-id exemption);
    single-sourcing newly activates jargon on a NON-telegram channel (one slack/whatsapp assertion
    proves the inside-`checkOutboundMessage` single-source claim); `GET /messaging/advisory-log`
    reads a bounded tail (never the whole file); the §2.4(6) escalation raises ONE deduped
    Attention item after N ignored advisories; a clean interleaved send does NOT reset an advised
    signature's count (the reset-gaming case); the per-slug aggregate fires for topic-varying
    one-shots; a BURST of many distinct misbehaving signatures produces Attention topics ≤ the
    topic budget (P17 burst-invariant — proving the ride-the-budget claim, not just stating it);
    queue INSERT succeeds against a pre-column legacy DB (idempotent-ALTER path); an
    acked-then-queued send still lands its `acked` audit row after redrive (no escalation
    false-fire on transient delivery failure); an unrecognized `messageKind` in metadata is
    coerced to `'unknown'` end-to-end.
  - **E2E + WIRING (the Phase-1 "feature is alive"):** a job-spawned session carries
    `INSTAR_MESSAGE_KIND=automated` + `INSTAR_SENDER_CLASS=llm-session` in its env WITHOUT the
    model passing anything → a `telegram-reply.sh` send of a raw-path reminder (1) does NOT
    deliver on the first call, prints the LITERAL first line `NOT SENT — advisory (fix and
    re-run, or re-run with --ack-advisory to send unchanged)`, and exits 0; (2) a re-run with
    corrected text delivers; (3) a re-run with `--ack-advisory` and the ORIGINAL text delivers
    and the server audits the override; (4) **fail-open proof (r2 round-2 — reframed; "server
    stopped" is unimplementable since the send rides the same server):** with the preflight route
    disabled (`messaging.outboundAdvisory.enabled:false`) AND separately with the route forced to
    500/slow-past-cap while the server is otherwise up, the same first call DELIVERS. This is the
    structural-wiring test that proves the kind is ambient, the advisory informs, and the sender
    stays sovereign.
- **No-deferrals:** scheduler-injection + script-forward + union widening + jargon-always +
  raw-path signal + preflight route + advisory-log route + script advisory loop + ack annotation +
  escalation + queue-column threading + SHA-allowlist + config plumbing + CLAUDE.md (add + remove
  hand-curl + shadow mirror) + tests ship in ONE PR.

## 7. Risks + rollback

- **A sender that ignores the advisory drops its own message** — named + bounded in §2.4 (the
  REQUIRED escalation is the bound; recurring senders re-fire; one-shot senders are the accepted
  residual cost of inform-only, stated honestly).
- **`detectRawFilePath` false positives** — an advisory costs the sender one re-run with
  `--ack-advisory`; nothing is lost. On `reply` kinds the detector is only ever a signal to the
  existing authority.
- **ReDoS / route crash** — pinned linear regex + indexOf prescreen + fail-OPEN everywhere (§2.3) +
  64KB analyzed-text cap.
- **Latency + cost honesty (r2 round-2):** the server work is sub-ms, but the script-side reality
  per automated send is ~100ms of process spawns (preflight body build + JSON parse), and an
  advised bounce costs the sender one extra LLM turn plus a second preflight+send round-trip.
  Negligible against job cadence; stated so the "sub-ms" claim isn't read as end-to-end. The 2s
  cap bounds ONLY the preflight call; the main send POST is uncapped today (pre-existing,
  deliberate — its 408/queue machinery handles ambiguity).
- **Residual: proxy/system-template bypass** — system-composed sends have no sender to inform;
  out of scope, named (§2.5).
- **Residual: hand-curl + env mutation** — a session can unset its kind env or hand-curl the
  route; sovereignty over the send is accepted by design, the breadcrumbs (§2.1) make the dodge
  classes visible, and the CLAUDE.md map to the hand-curl pattern is removed (§5).
- **Rollback:** `messaging.outboundAdvisory.enabled:false` (read live via LiveConfig — no restart)
  disables the preflight + escalation entirely; `messaging.outboundFloor.jargonAlways:false`
  reverts the jargon signal. The scheduler env injection is inert without the script/route
  changes, so a partial rollback degrades safely.
