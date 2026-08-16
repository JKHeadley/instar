---
title: "Outbound gate — close the jargon + raw-file-path gaps for automated senders"
slug: "outbound-jargon-filepath-gap"
author: "echo"
review-convergence: "2026-06-10T18:30:12.526Z"
review-iterations: 3
review-completed-at: "2026-06-10T18:30:12.526Z"
review-report: "docs/specs/reports/outbound-jargon-filepath-gap-convergence.md"
cross-model-review: "skipped-abbreviated"
cross-model-review-reason: "focused single-subsystem change; full internal 5-reviewer panel incl mandatory lessons-aware, 3 rounds; external models skipped per abbreviated path"
approved: true
approved-by: "Justin — explicit 'approved' (topic 12143, 2026-06-10) to build ACT-749; converged + reversible (config off-switches); recorded by echo per AGENT-AUTONOMY-PRINCIPLES (no operator stop-and-wait). Open-Q calls: Q1 jargon scoped to non-reply; Q2 structural scope (the only fix that closes the incident); Q3 allowRawFilePath hatch accepted."
---

# Outbound gate — close the jargon + raw-file-path gaps for automated senders

*topic 12143 · 2026-06-10 · tracked as ACT-749. The durable Structure-over-Willpower fix for the
2026-06-10 incident: a background job (`evolution-overdue-check`, Haiku) sent Justin an overdue
reminder that used dev jargon AND pasted a raw repo path instead of a clickable link — both
standing instar standards, both bypassed because the job composes its own Telegram escalation.*

> **Grounding correction (read first).** The original ACT-749 framing — "build a gate at the
> outbound chokepoint" — is WRONG: the chokepoint gate already exists. `MessagingToneGate` is
> "the single outbound-messaging authority," runs on `/telegram/reply` via `checkOutboundMessage`
> (`src/server/routes.ts:1281`), and ALREADY has a `B2_FILE_PATH` block rule + a jargon detector.
> This spec closes the SPECIFIC holes that let the job's message through, and — per a 5-reviewer
> convergence round — does so STRUCTURALLY (the kind is injected by the scheduler, not declared by
> the model) rather than re-introducing the willpower dependency the first draft hid.

## 1. Problem statement — why the existing gate missed it

`checkOutboundMessage` is well-built and signal-vs-authority compliant: deterministic detectors
emit signals, the LLM authority (`MessagingToneGate.review`) makes the single block/allow decision,
fail-OPEN so a slow gate never traps a legitimate message. Three grounded gaps let the job's
reminder through:

**Gap 1 — jargon is never detected on `/telegram/reply`.** `checkOutboundMessage` collects the
jargon signal only when its caller passes `options.jargon === true` (`routes.ts:1357-1364`); the
`/telegram/reply` handler calls it WITHOUT `jargon` (`routes.ts:7610-7614`). So `detectJargon`
NEVER runs for a Telegram reply — job OR main agent. The dev-jargon half is structurally
un-checked on the primary path.

**Gap 2 — raw-file-path protection rides only the fail-open LLM rule.** A literal repo path is
caught by `B2_FILE_PATH` — but only when the LLM authority runs AND fires. It does NOT run when
the send is `isProxy`/`isSystemTemplate`/`willRelay` (`routes.ts:7607-7609`), and the authority is
fail-OPEN on timeout/error/rate-limit (`routes.ts:1475-1477`). There is no deterministic floor for
a raw path.

**Gap 3 (the root cause the first draft missed) — an automated job send is indistinguishable from
a conversational reply.** `telegram-reply.sh` POSTs `{text}` with no message-kind, so EVERY send
defaults to `'reply'`. The gate therefore judges a background-job alert with the SAME lenient bar
it uses for the main agent's conversation ("prose discussion of internals is fine"). The incident
message was lenient-barred because nothing told the gate it was an automated alert, where the bar
should be strict. This is the gap that actually matters: **the system cannot currently tell an
automated message from a conversational one**, and both of the above gaps are downstream of it.

## 2. Design

Three targeted changes inside the EXISTING seam — NO new gate. The spine is making the
automated-vs-conversational distinction **structural**, so the strict bar binds every job send by
construction.

### 2.1 Structural automated-kind (the spine — model-proof for the mandated send path)

The first draft made a background job DECLARE `--kind automated` — which the same Haiku model that
already ignored the standards would have to remember to type. That is the willpower trap. Instead,
the **scheduler stamps the kind into the job session's environment**, so it binds regardless of
what the model does ON THE MANDATED RELAY PATH (`telegram-reply.sh`, which CLAUDE.md requires for
every reply):

- **Spawner env injection (BOTH spawn env blocks).** `SessionManager.spawnSession` injects
  `INSTAR_SESSION_ID`, `INSTAR_AUTH_TOKEN`, `INSTAR_AGENT_ID`, etc. via tmux `-e` and accepts
  `jobSlug` (`:1473`). Add, ONLY when `jobSlug` is set: `'-e', 'INSTAR_MESSAGE_KIND=automated'`
  (and `'-e', \`INSTAR_JOB_SLUG=${jobSlug}\`` — the slug is read at `PostUpdateMigrator.ts:8653` but
  currently NEVER set, a dead signal this revives). There are **TWO** env blocks that must both get
  this: the standard spawn block (`SessionManager.ts:1742-1756`) AND the **rerouted-interactive
  lane** (`~:2005-2039`, `launchLane === 'rerouted-interactive'`, which also carries `jobSlug`) —
  this is the lane the June-15 subscription-path lever routes job spawns through, so omitting it
  would leave a structural hole for exactly those job sessions. The script-mode job env
  (`JobScheduler.ts:757-761`, the `runScriptJob` env — NOT the `:1452` `gateEnv`, which is the
  zero-token pre-screen, not a send path) gets the same `INSTAR_MESSAGE_KIND=automated`. Interactive
  (non-job) sessions get NEITHER → they stay `'reply'`.
- **Script forwarding (BOTH body builders).** `telegram-reply.sh` reads `$INSTAR_MESSAGE_KIND`
  (default empty) and, when non-empty, adds a `metadata: { messageKind }` object to the POST body.
  The script has no `metadata` object today (it sends `{text, format}`), and it builds the body two
  ways — a `python3` one-liner AND a `sed`-based fallback used when python3 is absent. BOTH builders
  must carry the kind, or a python-degraded agent silently drops it → the incident recurs. The job
  model types nothing different — the script and env do it.
- **Route threading.** `/telegram/reply` reads `metadata.messageKind` and passes it to
  `checkOutboundMessage({ messageKind })` (the route already reads `metadata` at `:7538`).
- **No job-template change.** `evolution-overdue-check.md` (and every other job) is UNCHANGED — the
  kind is ambient.
- **Honest scope of "model-proof" (round-2 correction).** The guarantee binds for sends via
  `telegram-reply.sh` (the path CLAUDE.md mandates). A job that *hand-curls* `/telegram/reply`
  directly — a pattern the CLAUDE.md template also shows — bypasses the script, sends no `metadata`,
  and defaults to `'reply'`, evading the floor. A raw localhost POST carries no server-visible
  session identity, so deriving the kind server-side would need new infra (binding a per-session
  token to the kind) and is OUT OF SCOPE here. This residual is named in §7, not hidden. To make a
  silent regression of the spine VISIBLE rather than invisible, the route logs an observability
  breadcrumb when a send whose topic maps to a job session arrives WITHOUT a `messageKind` (the
  topic→session→`jobSlug` lookup is available server-side even when the body omits the kind).

A new `messageKind` value `'automated'` is threaded through the union — it exists in FOUR places
today (`MessagingToneGate.ts:203`, `:281`, `:458`; `routes.ts:1290`), all `'reply' | 'health-alert'
| 'unknown'`. All four widen to add `'automated'`, plus a `renderMessageKind` branch
(`MessagingToneGate.ts:458`) describing it to the authority, plus the **jargon strictness rule
B12** (today `health-alert`-scoped, `:315`) extending to fire for `health-alert | automated`. So
"the authority knows the bar is strict for an automated alert" becomes BACKED by a real rule, not
asserted. (Precision: the existing `B2_FILE_PATH` block rule is NOT health-alert-scoped — it
already fires for all kinds as a soft, fail-open signal; the new *path* strictness for automated
kinds comes from the deterministic floor in §2.3, NOT from re-scoping B2. Only B12/jargon is
re-scoped here. `'reminder'` is NOT a separate kind — `automated` covers all job escalations.)

### 2.2 Always-compute the jargon signal — for non-`reply` kinds (Gap 1)

Make `checkOutboundMessage` compute `detectJargon` itself (drop the `if (options.jargon)` opt-in),
single-sourced so ALL channels (telegram/slack/whatsapp/imessage) get it uniformly — gated by a
`messaging.outboundFloor.jargonAlways` flag (default on). **Scoped to non-`reply` kinds**: jargon
is computed for `health-alert | automated`, NOT for conversational `reply`. Rationale (a round-1
finding): the gate's jargon rule (B12) is scoped to alerts and explicitly does NOT apply to
conversational replies ("prose discussion of internals is fine"), so feeding a jargon signal on a
`reply` is dead weight that only adds LLM reasoning-drift / over-block tail — the exact over-block
the operator's repeated feedback warns against. `detectJargon` is cheap deterministic regex (~28
anchored terms, sub-ms), so the cost is negligible; the scope choice is about over-block, not cost.
The existing try/catch (a detector error skips the signal, never blocks) is preserved.

### 2.3 A deterministic raw-file-path SIGNAL + a scoped FLOOR (Gap 2)

Add `detectRawFilePath(text)` — a sibling of `detectLocalhostLink`, held to the SAME linear-regex
discipline (`localhost-link.ts`'s `LOCALHOST_LINK_RE` is bounded char-classes, no nested
quantifiers). Hard requirements (round-1 must-fixes):

- **ReDoS-safe + bounded.** Linear, non-backtracking pattern; bounded segment count/length; an
  `indexOf` prescreen for path-ish substrings (`/`, `~/`, `.instar/`, `src/`, `/Users/`) so the
  regex only runs when a path is plausibly present. Must NOT match inside an `http(s)://` URL
  (URLs containing paths are the legitimate form to preserve). A ReDoS regression test feeds a 4KB
  pathological input and asserts bounded time.
- **Bounded match echo.** The returned match stops at the first whitespace/quote/`?`/`#`/`)`
  (mirror `localhost-link.ts`'s char-class boundary) and is truncated (≤120 chars) before it is
  echoed in any block message or audit line — so a secret adjacent to a path (`.../foo.env?token=…`)
  can never ride into logs/transcripts.
- **Fail-OPEN on error.** The floor's `detectRawFilePath` call is wrapped so a detector throw lets
  the message THROUGH (never a 500 / dropped message). The localhost guard it mirrors is unguarded
  and sits BEFORE the function's outer try/catch — a throw there would crash the route; the new
  floor must not inherit that. Unit test: "detector throws → message delivered, not 500."

Two uses:

- **SIGNAL to the authority (all kinds).** Feed `signals.filePath = { detected, match }` into
  `review`, anchoring the existing `B2_FILE_PATH` judgment with the exact deterministic match. On
  the conversational `reply` path this stays a SIGNAL the authority weighs — a legitimate "I edited
  `src/foo.ts`" is the authority's call, NOT a hard block (over-block avoidance).
- **Deterministic FLOOR (automated/health-alert kinds ONLY).** For `messageKind ∈ {automated,
  health-alert}`, a detected raw path is deterministically BLOCKED (422) with an ELI16, actionable
  message. This runs as a deterministic pre-check for those kinds so it holds even if the LLM
  authority fail-opens. Conversational `reply` is NEVER subject to the deterministic floor.

### 2.4 Floor placement + the honest bypass scope

Round-1 correctly caught that my first draft's claim — "the localhost guard blocks even under
`isProxy`/`isSystemTemplate`/`willRelay`" — is FALSE: that guard lives INSIDE
`checkOutboundMessage` (`routes.ts:1328`), which those flags short-circuit (`:7607-7609` returns
before the call). Honest placement decision for THIS spec:

- The automated raw-path floor runs **inside `checkOutboundMessage`** (alongside the localhost
  guard, before the `if (!ctx.messagingToneGate) return false` early-out at `:1343`), so it holds
  even when no LLM gate is configured and when the LLM fail-opens.
- It does NOT cover `isProxy`/`isSystemTemplate`/`willRelay` sends (those skip
  `checkOutboundMessage` entirely) — and that is acceptable for THIS incident class because a
  background-job escalation via `telegram-reply.sh` is NOT a proxy/system-template send, and the
  `willRelay` case re-gates on the lease holder (where the floor also runs) **provided the relay
  forwards `metadata.messageKind` to the holder's `/telegram/reply`** — so the cross-machine relay
  path MUST propagate the kind, or a relayed automated send floors on neither machine. The PR
  includes that relay-forward (and an integration assertion that a relayed automated send arrives at
  the holder with the kind intact). The pre-existing bypass gap for proxy/system-template sends is a
  SEPARATE, larger change (hoisting the guards above the short-circuit) explicitly OUT OF SCOPE
  here; it is named as a residual in §7, not silently inherited as a false claim.
- E2E proof: the test exercises the REAL incident transport (a job session → `telegram-reply.sh`
  with the ambient `INSTAR_MESSAGE_KIND=automated` → `/telegram/reply`, no proxy flag) and asserts
  the raw path is floored — it does NOT hand-pass the kind (that would test a path the model won't
  take).

## 3. Decision points touched (signal-vs-authority)

- **Jargon (2.2):** pure SIGNAL, scoped to alert kinds where a rule consumes it — no new authority.
- **Raw-path signal (2.3):** pure SIGNAL fed to the authority on all kinds — no new authority.
- **Raw-path floor (2.3):** deterministic block authority, scoped to automated/health-alert kinds.
  **Honest rationale (round-1 correction):** the justification is NOT "a raw path has no legitimate
  reading" (false — a path can have a legitimate reading, which is why the `allowRawFilePath` escape
  hatch exists). The real justification is the **cost asymmetry on automated kinds**: an automated
  alert SHOULD link-or-describe, so a false block there costs only "re-send describing it," while a
  false PASS re-leaks the incident — false-block-cost ≪ false-pass-cost. That asymmetry (matching
  `signal-vs-authority.md`'s irreversible-action-guard exception logic) is what licenses a
  deterministic block HERE, where it does not for the conversational path (whose soft, fail-open
  posture is retained by design — honoring the operator's "don't over-block legitimate agent work").

## 4. Open questions

1. **`jargonAlways` scope.** Rec: compute jargon for `health-alert | automated` only, NOT `reply`
   (a `reply` jargon signal is dead weight + drift tail). **Confirm.**
2. **Scope of the structural fix.** This expands ACT-749 from "close two gaps" to "make the
   automated-vs-conversational distinction structural" (scheduler env injection + a new `automated`
   kind). That is larger than the original framing but is the only fix that actually closes the
   incident (vs. the already-shipped job-prompt edit, which is the willpower layer). **Confirm the
   larger structural scope is wanted** (the lighter alternative — ship only always-on jargon + the
   raw-path signal, no structural kind — leaves the floor unreachable by the very job that
   motivated this, so it does NOT close the incident).
3. **`allowRawFilePath` escape hatch** — caller-controlled boolean, Bearer-scoped, same trust model
   as `allowLocalhostLink`/`allowDuplicate`; its use is recorded in the decision audit so a job
   self-exempting is visible. **Confirm acceptable.**

## 5. Migration parity (concrete)

- **Scheduler env injection (`src/` — auto-reaches all agents on update, no agent-file migration):**
  BOTH `SessionManager.spawnSession` env blocks — the standard one (`:1742-1756`) AND the
  rerouted-interactive lane (`~:2005-2039`) — plus the `JobScheduler` `runScriptJob` env
  (`:757-761`; NOT the `:1452` `gateEnv` pre-screen) add `INSTAR_MESSAGE_KIND=automated`
  (+ `INSTAR_JOB_SLUG`) when `jobSlug` is set.
- **`telegram-reply.sh` (agent-installed → needs the SHA re-deploy):** add `$INSTAR_MESSAGE_KIND`
  forwarding in BOTH body builders (python3 + sed-fallback). The re-deploy is
  `migrateReplyScriptToPortConfig` (`PostUpdateMigrator.ts:9053`), gated by
  `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS` (`:9007`). Round-1 found the CURRENT live template SHA
  (`3e30b2cd…`) is NOT in that set — so a stock script is treated as "unknown" and left untouched
  (writes a `.new` + degradation event). The PR MUST add the **current live SHA** to the allowlist
  (the new template's own SHA is the idempotent self-match at `:9073` and does NOT need to be in the
  prior-shipped set), or the forwarding never reaches existing agents.
- **`messageKind` union + gate rule (`src/`):** widen the union in all 4 sites; add `renderMessageKind`
  branch; extend the **jargon** strictness rule B12 to `health-alert | automated` (the path
  strictness for automated comes from the §2.3 floor, not a B2 re-scope).
- **Single-source jargon cleanup (`src/`):** dropping the `if (options.jargon)` opt-in
  (`routes.ts:1357`) makes the one existing caller that passes `jargon` — the attention/health-alert
  site (`routes.ts:8286`, `jargon: isHealthAlert`) — pass a now-vestigial arg; remove it in the same
  PR, and assert (test) the health-alert path still gets jargon via the new `messageKind` gate.
- **Route (`src/`):** read `metadata.messageKind`, pass to `checkOutboundMessage`; relay path
  forwards `metadata.messageKind` to the holder (§2.4).
- **Config flags:** `messaging.outboundFloor.{rawFilePath,jargonAlways}` read LIVE per request with
  a code-level `?? true` default (no ConfigDefaults seed — absence = on — so the rollback-without-
  restart claim in §7 holds; a boot-snapshotted default would break it).
- **CLAUDE.md awareness:** `generateClaudeMd()` (new agents) + a `migrateClaudeMd` appended,
  content-sniffed subsection (existing agents) documenting that automated/job messages are held to
  the strict path/jargon bar and that a floored job should publish a private view + send the link.
- **NO job-template migration:** the job `.md` files are unchanged (the kind is ambient).

## 6. Standards / parity + tests

- **Structure > Willpower:** the automated bar is injected by the scheduler, not declared by the
  model — a job cannot forget to be treated strictly (§2.1).
- **Signal-vs-authority:** §3 — signals strengthen the existing authority; the one deterministic
  block is scoped to automated kinds and justified by cost-asymmetry, not a false "no legitimate
  reading" claim; the conversational path stays soft.
- **Migration parity:** §5 (concrete functions, the SHA allowlist amendment, no job-template change).
- **Testing Integrity (all three tiers):**
  - **Unit:** `detectRawFilePath` true/false table (paths shown as references match; backtick prose
    + `http(s)://` URLs + conceptual mentions do NOT); ReDoS pathological-input bounded-time test;
    bounded match echo stops before an adjacent `?token=…`; detector-throw → message delivered (not
    500); jargon computed for automated/health-alert but NOT reply; the floor blocks a raw path in
    an `automated` kind but NOT a `reply` kind; `allowRawFilePath` escape hatch + audit record.
  - **Integration:** `POST /telegram/reply` with `metadata.messageKind:'automated'` + a raw path →
    422 (floor, even with the LLM gate unavailable); same path in a `reply` kind → goes to the
    authority (not hard-blocked); jargon signal reaches the gate on an automated send; a relayed
    automated send arrives at the holder with the kind intact (§2.4); single-sourcing newly
    activates jargon on a NON-telegram channel (one slack/whatsapp assertion proves the
    inside-`checkOutboundMessage` single-source claim).
  - **E2E + WIRING (the Phase-1 "feature is alive"):** a job-spawned session carries
    `INSTAR_MESSAGE_KIND=automated` in its env WITHOUT the model passing anything → a
    `telegram-reply.sh` send of a raw-path reminder arrives at `checkOutboundMessage` with
    `messageKind:'automated'` and is floored with the actionable "publish a view / describe it"
    message. This is the structural-wiring test that proves the kind is ambient, not model-declared.
- **No-deferrals:** scheduler-injection + script-forward + union/rule + jargon-always + raw-path
  signal+floor + SHA-allowlist + config + CLAUDE.md + tests ship in ONE PR.

## 7. Risks + rollback

- **Over-block on the conversational path** — mitigated by keeping `reply` on the soft signal-fed
  authority (no deterministic floor, jargon not computed there).
- **`detectRawFilePath` false positives** — a signal on `reply` (harmless — authority weighs it); a
  block only on automated kinds (acceptable — those shouldn't show paths; cost-asymmetry §3).
- **ReDoS / route crash** — pinned linear regex + indexOf prescreen + fail-OPEN floor (§2.3).
- **Residual: proxy/system-template bypass** — the floor (like the existing localhost guard) does
  NOT cover `isProxy`/`isSystemTemplate` sends, which skip `checkOutboundMessage`. Named, not hidden;
  out of scope (hoisting the guards above the short-circuit is a separate change). The incident class
  (job → telegram-reply.sh, no proxy flag) IS covered; the `willRelay` cross-machine case is covered
  via the relay forwarding the kind (§2.4).
- **Residual: a job that hand-curls `/telegram/reply`** (bypassing `telegram-reply.sh`) sends no
  `metadata` → defaults to `'reply'` → evades the floor. The "model-proof" guarantee is honestly
  scoped to the mandated relay-script path; the route's observability breadcrumb (§2.1) makes a
  job-session send-without-kind VISIBLE so this silent-regression class is detectable rather than
  invisible. Closing it fully needs server-side per-session kind derivation (new infra), out of scope.
- **Rollback:** `messaging.outboundFloor.rawFilePath:false` / `.jargonAlways:false` (read live per
  request — no restart) revert to today's behavior. The scheduler env injection is inert without the
  route/gate changes, so a partial rollback degrades safely.
