---
title: "Never-Silent Conversation — an unanswered message is judged, acted on, and always told"
slug: "never-silent-conversation"
author: "echo"
status: "approved"
approved: true
approved-by: "justin"
approval-note: "topic 141385, 2026-11-14 13:39 PST — answered Frontloaded Decision 2: ask, as long as it is robust and minimally interrupting for the user"
created: 2026-11-13
parent-principle: "No Silent Degradation"
sibling-principles: "Intelligent Prompts — An LLM Gate Must Not String-Match; Signal vs Authority; Structure > Willpower; Verify the State, Not Its Symbol; Framework-Agnostic — and Framework-Optimizing; Close the Loop"
lessons-engaged: "CMT-1008 interactive login-expired swap (2026-10-25, Luna); rerouted login-expired slot hold (2026-10-18, #2200); framework-stall-coverage-matrix (stall classes discovered one incident at a time); relogin-last-resort-model (the repair of the only account cannot run on the dead account); skill-driven-signin-repair (pool health from the CLI's own login status; claude auth status can say loggedIn:true for an expired login); codex-device-limit-tripwire (Jev judge on a DIFFERENT account, bounded, content-free log); confined-spawn-subscription-reroute D2 (reworded dialog lands in dialog-unknown); Justin 2026-10-25 'mechanical checks are inputs only'; Justin 2026-11-12 'judge hung vs slow, not dumb timers'"
origin: "Operator directive 2026-11-13 10:36 + 10:40 PST, topic 33890 (Inspec silent login expiry)"
eli16-overview: "never-silent-conversation.eli16.md"
review-convergence: "2026-11-13T18:56:10.213Z"
review-iterations: 6
review-completed-at: "2026-11-13T18:56:10.213Z"
review-report: "docs/specs/reports/never-silent-conversation-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 1
contested-then-cleared: 0
---

# Never-Silent Conversation

## 0. The operator's words (the requirement)

2026-11-13 10:36 PST, topic 33890, with a screenshot of Inspec's "beth vaughan" session:
> "Here's another failure. Please work with Inspec on the laptop to fix the issue and identify an
> Instar solution so the agent NEVER silently fails. The solution should include the possibility of
> leveraging other AI engines such as codex to fix a login/subscription issue"

10:40 PST, same topic:
> "A meta thought here: a Instar constitutionally aligned solution here would NOT be brittle/dependent
> on an array of string matching. It would be future proof and leverage AI intelligence (like Jev) to
> identify the "login" scenario and act accordingly"

## 1. Problem — measured, 2026-11-13

Inspec (`monroe-workspace`, laptop, port 4046, Instar 1.3.1756, Claude Code 2.1.323) had one Claude
pool account, `claude-monroe`. Its CLI login ran out overnight. Every conversation then failed with
no reply and no warning:

| Conversation | First stuck turn | Pane |
|---|---|---|
| Chiara (topic 7165) | 06:01 PST (and Justin's 10:20 message) | `⏺ Login reached its time limit · Please run /login` |
| Paul (6648) | 10:22 | same |
| Beth Vaughan (10375) | 10:27 | same |

Five independent failures stacked, each one a silent one:

1. **Wording drift beat the detector.** `LoginExpiredSignature.ts` is a list of line-start regexes
   (`login expired`, `oauth token expired`, `invalid api key … /login`, `please run /login`, and a
   message-led `not logged in … /login`). Claude Code 2.1.323's new frame starts with
   "Login reached its time limit", so nothing matched. The CMT-1008 swap and the rerouted-session
   end never ran. This is the third rewording of this one frame since 2026-10-18; each was patched
   by adding a string.
2. **The pool said healthy.** `claude-monroe` stayed `status: active`, `loginCheck: unavailable`,
   last usage reading 09:01 UTC, `statusCause: null`, while `claude auth status` for its config home
   printed `"loggedIn": false`. Nothing in the pool consumed that structured answer.
3. **Recovery failures go to a log, not a person.** Even when CMT-1008 detects and cannot swap
   (`no-account`, `not-confirmed`, `swap-refused`, `gave-up`), the only output is a
   `DegradationReporter` row. The conversation stays silent.
4. **The watchers run on the dead engine (hypothesis — Phase 0 must verify).** StallTriageNurse,
   PresenceProxy and the TriageOrchestrator all call the agent's `sharedIntelligence`. On a
   one-Claude-account agent that is the same expired login, so every diagnosis call fails; a failed
   diagnosis is not a user-visible event.
5. **The manual fix hit another silent wall.** Moving the three topics to `codex-cli` through the
   topic-profile route worked (sessions restarted with history), and all three then sat at Codex's
   "Trust this folder?" dialog. `confinedStartupDialogs.ts` knows only Claude's measured dialogs;
   a Codex dialog is not "unknown" to it, it is invisible.

The class is not "a new login wording". The class is **a user's message was delivered and nothing
came back, and nobody was told why** — whatever the screen says.

## 2. The standard

**A message a person sends to an Instar conversation ends in exactly one of: a reply from the
agent, or a plain message from Instar in that conversation saying what went wrong and what is being
done. "Nothing" is never an outcome.** Detection is by behaviour; diagnosis is by an LLM judge that
does not share the failing engine; action reuses the existing funnels; telling the user is
unconditional and does not depend on the judge, the pool, or the stuck engine being healthy.

## 3. Design

### 3.1 Trigger — behaviour, not wording

**The unit is the inbound message, tracked until a terminal outcome.** Each inbound message
accepted for a conversation-bound session (Telegram, Slack, app) gets an *obligation record* in the
existing durable inbound store at acceptance time, with a **notice deadline** set then (the
conversation's existing PresenceProxy first-standby tier — already tuned for "a person is
waiting" — not a new constant). States: `pending → answered | told-pending → answered | released`.

- **answered** — SessionManager records which inbound ids each turn consumed (the injection it
  performed and the turn that took it in, including mid-turn input the CLI folds into the running
  turn). A substantive outbound reply from that turn, *confirmed delivered* (platform message id),
  closes every inbound id that turn consumed. Progress notes, standby messages and Instar's own
  notices never answer. **Honest limit:** "answered" means "the turn that took the message in
  delivered a reply", not "the reply addressed every point"; grading reply content is out of scope.
- **told-pending** — the §3.4 notice for that message was delivered; the obligation stays under
  watch so the real reply still closes it.
- **released** — the session was deliberately ended by the user or operator.

**Overdue sweep — independent of the session.** A reconciler over the durable store (run at boot
and on the existing monitor tick) finds every obligation past its notice deadline, whatever the
session did or did not do. This covers `input-not-draining` (an idle session that never starts a
turn, so no transition ever fires), lost injections, and server restarts. Being overdue opens
judgment and the §3.4 notice; elapsed time alone never authorizes a recovery action.

**When the judge looks** — on the overdue sweep above, and on every *state change* of a session
holding an open obligation:

- **turn ended without a reply** (SessionActivityVerdict: working → idle-at-prompt) — any turn,
  any duration, any tool count. All three Inspec panes showed this ("Baked for 4s · done");
- **not ready** — a session spawned/respawned for an open obligation has not reached a ready
  prompt within its existing startup budget (covers the Codex trust dialog);
- **still working, no reply** — the existing hung-vs-slow evidence (activity verdict, tool-call
  progress, transcript growth) marks a stall; the existing stall backstop timer is only the last
  deterministic rung;
- **session exited** with an open obligation.

A `working-slow` verdict does not close anything: the obligation stays open and the next state
change re-opens judgment. Counts and timers are inputs to the judge; none of them acts by itself.

### 3.2 Judge — an LLM referee that does not share the failing engine

A new `ConversationSilenceJudge` (the authority; §3.1 detectors and the hints below are its
signals). It reuses the Jev pattern proven by `CodexDeviceLimitJudge` + `JevCascade`: Jev first,
the Luna referee (Codex fast tier) when Jev is unsure or on audit.

**Engine independence (the load-bearing rule).** A judge call never runs on the stuck session's
framework+account. Route order: (1) Jev; (2) a signed-in account on a DIFFERENT framework (Codex
for a stuck Claude session and vice versa); (3) a different signed-in account on the same
framework; (4) the operator's repair-specific API key (`ReloginLastResortProvider`, existing
consent and caps). The stuck framework+account is excluded because its health is the question
being asked; when no other route exists, a bounded one-shot probe call on the stuck account is
made instead, and its own result (answers / refuses with an auth error / times out) is passed to
the deterministic floor as evidence — the probe never judges. The route used is recorded on every
verdict. The same selector is offered to
StallTriageNurse / TriageOrchestrator / PresenceProxy diagnosis calls (Phase 2) so the existing
watchers stop sharing the dead engine too.

**Inputs.** Prepared exactly like the device-limit judge's snippet (secret-scrubbed, PII and
provider ids masked):
- the pane since the message was injected (visible screen + scrollback since injection), and the
  startup pane if any. **Never silently cut:** the snippet budget is the referee transport's
  measured budget; if the since-injection pane exceeds it, the judge is told in-band
  (`truncated: true`, lines dropped, which end kept — the latest screen plus the first screen after
  injection, where errors and dialogs appear), and a truncated input cannot produce an acting
  verdict above the floor — it is capped at `told`;
- the engine's own structured auth answer for the session's config home (`claude auth status`
  JSON: `loggedIn`, `authMethod`, `loginExpiresAt`; or the `codex login status` verdict);
- pool state for the session's account (status, loginCheck, last reading age, statusCause,
  limits and resets) and which accounts on each framework are healthy;
- timing facts: injected at, each turn start/end, tool-call count, outbound sends since;
- **hints:** the existing classifiers (`classifyLoginExpired`, `StuckSignatureClassifier`,
  `classifyConfinedStartupPane`, usage-wall detectors) run and their outputs are passed as labelled
  hints. The prompt states the intent it judges and treats hints and example phrasings as
  illustrative, never necessary (Intelligent Prompts standard; the
  `gate-prompts-judge-by-meaning` ratchet covers this prompt).

**Output** (closed schema): `class` ∈ {`engine-login`, `usage-or-subscription-wall`,
`startup-dialog`, `crashed`, `working-slow`, `message-not-delivered`, `other`}, `confidence`,
`evidence` (which inputs decided it, ≤160-char quotes), and for `startup-dialog` the dialog's
question and the option the judge believes is safe.

**Account evidence is shared; verdicts are not.** Account-scoped facts (CLI auth status, pool
state, a prior `engine-login` verdict on that account) are gathered once per account incident and
passed as inputs to every affected session's judgment, so a fleet-wide expiry costs one auth read,
not one per session. Each session still gets its own verdict (Jev first; on a matching account
incident Jev is usually confident, so the referee is rarely called) bound to its own generation,
turn and obligations, and each action is authorized per session. A startup dialog, crash or
delivery failure is never inferred from another session.

**Verdicts are bound to what was observed.** Each verdict carries the session generation (spawn
id), the turn id and the obligation ids it judged. Recovery for one conversation is serialized;
immediately before any action the policy re-reads the session and obligations, and discards the
verdict if the generation changed, the obligation closed, or the observed state is gone (for
example the dialog is no longer on screen). A discarded verdict is logged, never acted on.

**Judgment scheduling is evidence-gated.** At most one judgment is in flight per session; all of its
open obligations are coalesced into it. Each verdict is cached against an *evidence revision* (a
digest of the pane since injection, the auth answer, the pool state, the session generation, the
current turn id, the open obligation ids and the latest activity-verdict transition). A
`working-slow` verdict additionally expires at the activity verdict's next hung-vs-slow
reassessment, so an unchanged pane that turns into a hang is judged again.
A trigger whose evidence revision is unchanged reuses the cached verdict and makes no call; only
new evidence buys a new judgment. Failed calls retry with the referee transport's existing backoff.

**Bounded calls.** Every judge/referee call carries a deadline (the referee transport's existing
timeout). A call that does not return by its deadline is a failed call. Judge unavailable (no
route, all calls failed, spend cap reached) ⇒ verdict `undetermined`.

### 3.3 Act — existing funnels only

The judge decides the class; a deterministic policy maps class → action through funnels that
already exist and keep their own refusals and brakes:

| Class | Action |
|---|---|
| `engine-login` | (a) `QuotaPoller.observeCliLoginExpired` — a judge verdict at or above the floor counts as the sighting (replacing the regex as the trigger). (b) `QuotaAwareScheduler.onQuotaPressure` swap to a signed-in account on the same framework. (c) If none: **framework fallback** through the topic-profile write path (`TopicProfileOrchestrator`) to a framework whose door is `available` and which has a pool account with loginCheck `ok`, recorded as `intendedProfile` so the conversation returns when the original login is repaired. Pinned conversations are asked instead (Frontloaded Decision 2). (d) Open the assisted sign-in repair (§3.5). |
| `usage-or-subscription-wall` | Existing UsageWallRescue / swap; same cross-framework fallback when no account on this framework has room. |
| `startup-dialog` | Keypress only inside a fixed per-framework action space, and only while the session has not yet started its first turn (so no user text can be on screen to steer the judge): answer the workspace-trust dialog for the session's own registered cwd, or decline an optional feature offer. Extends `confinedStartupDialogs` with a Codex policy. Anything else ⇒ tell. |
| `crashed` / `message-not-delivered` | Existing respawn / re-inject paths (TriageOrchestrator actions). |
| `working-slow` | No action; obligation stays open (§3.1). |
| `other` / `undetermined` | Tell (§3.4); operator attention per §3.4's rule. |

**Replay boundary — one policy for every path that can repeat work** (swap, framework fallback,
crash respawn, re-inject). Automatic recovery is allowed only when the transcript since injection
is readable and shows no side-effecting tool call (zero tool calls, or read-only ones only — the
Inspec case: zero). A missing, unreadable or incomplete transcript is `unknown`, never "zero".
A replacement session does not reconstruct the original operation identities, so a completed
external-operation record does not make a repeat safe; durable cross-session operation identity is
out of scope (Left behind). Therefore, if any side-effecting call ran, or the record is `unknown`,
recovery is not automatic: the person
is told what happened and asked, and the resumed session's preamble lists the prior tool calls
with their recorded outcomes and an instruction not to repeat them. Reuse of operation
idempotency keys stays with the existing external-operation gate.

**One recovery owner per conversation.** Every recovery producer — this policy, CMT-1008's
InteractiveLoginExpiredRecovery, UsageWallRescue, TriageOrchestrator and StallTriageNurse actions —
acquires the same per-conversation recovery lease (held in the existing SessionRefresh in-flight
gate) and validates the session generation before acting; a producer that cannot take the lease
does nothing and logs it. Phase 2 moves the existing producers onto the lease.

**Execution fence.** Before any recovery that replaces or re-drives a session, the original
executor is quiesced through the existing SessionRefresh in-flight-work gate (interrupt, wait for
the CLI to return to its prompt or exit, else stop it); only then is the transcript re-read and
the replay boundary evaluated, and execution ownership passes to the replacement. A tool call that
started during recovery is therefore seen by the re-read.

**Brakes (No Unbounded Loops).** A framework fallback that itself goes silent is a new incident on
the new engine; the policy never moves a conversation back to a framework whose incident is still
open, and once every framework with an account has an open incident for that conversation, the
only remaining action is tell. Re-attempts follow the existing swap funnel's anti-thrash
observation and refresh rate guard (no new counters). Protected sessions are never moved.

### 3.4 Tell — an obligation with a deadline, independent of the judge

**User notices (conversation) — two kinds, each deduplicated on its own.**
- *Waiting notice:* every obligation still open at its notice deadline gets one. A confirmed
  delivery of the existing PresenceProxy standby message for that obligation *is* the waiting
  notice (moves it to `told-pending`), so a slow but working session costs the person exactly the
  standby line they get today.
- *Status notice:* sent when the situation materially changes for open obligations — a judged
  failure class, recovery started, recovery succeeded, refused or exhausted. Deduped per incident
  plus *state revision* (class + action + outcome), so diagnosis → recovery started → recovery
  exhausted on the same unanswered message produces three notices, and a repeat of the same state
  produces none. A standby line never satisfies it.

Scheduling: a waiting notice goes at its deadline; a status notice goes at the material change
itself. If diagnosis or recovery is still pending at the deadline, the waiting notice uses the
"not answered yet, still working on it" template. Both are sent at the earlier of (a) the action finishing, or (b) the obligation's
notice deadline (set at acceptance, §3.1) — whether or not the judge or the action has returned. It is sent by Instar's deterministic notification path (no LLM, not the stuck session),
from fixed per-class templates, persisted and retried with the existing delivery retry. **Notices are batched per conversation**: each
delivered notice records the obligation ids it covered and covers every open, uncovered obligation
at send time ("your last 3 messages weren't answered…"). A message that arrives later and goes
overdue while the incident is still open gets its own later batched notice; covered obligations are
never re-noticed for the same kind; a fleet-wide incident is
also one operator item (Bounded Notification Surface). Examples:

> "Your message didn't get an answer: the Claude sign-in this conversation uses ran out. I've moved
> this conversation to Codex so it can answer now, and started the Claude sign-in repair."

> "Your message hasn't been answered yet and I couldn't tell why. I'm still on it and will tell you
> here when it's answered."

The notice is sent only when the person is actually affected: the conversation went unanswered
past the deadline, or its engine/account was changed (a visible change they should know about). A
session judged `working-slow` sends nothing new beyond the existing standby tier, satisfying
Near-Silent Notifications: every notice carries a consequence the reader needs.

**Operator attention (Self-Heal Before Notify).** This watcher's escalation is reachable only
after self-heal: `selfHealAttempted && selfHealExhausted`. Exhaustion is a recorded *evaluation*,
not a wait for another session event: the policy records `no-eligible-recovery` when no healthy
account exists on any framework, the repair needs an operator action (approval/2FA), recovery was
refused by the replay boundary, or the verdict is `undetermined`. Independently — as Standard B itself
requires ("a recoverable watcher MUST tell the operator even while self-heal is still running once
this ceiling passes") — the overdue sweep enforces the latency ceiling from the obligation's acceptance time: an obligation still open at
`recoverableLatencyCeiling` escalates whether or not self-heal is still running. Declared per Standard B:
- remediation-actions: swap (idempotent via the swap funnel's in-flight gate), framework fallback
  (idempotent: the topic-profile write is a set, compensation = restore `intendedProfile`),
  dialog keypress (single key, startup-only), repair open (existing orchestrator dedupe);
- brakes: max-attempts per the swap funnel's existing rate guard; breaker = the §3.3 "every
  framework has an open incident" stop; flapping = an account re-entering `engine-login` after a
  repair reported success escalates as critical at once (the repair did not hold — Distrust
  Temporary Success); dedupe-key = account + class;
- max-notification-latency: `standards.selfHealBeforeNotify.recoverableLatencyCeiling` (the
  registry value; missing ⇒ escalate sooner);
- class: `recoverable` (the message is preserved in the inbound store; replay is bounded by the
  §3.3 replay boundary, so no side effect is repeated automatically); audit-location: the
  incidents log (§4).
The in-conversation user notice is a direct obligation to the person who wrote, not an operator
escalation, so it is not gated on self-heal exhaustion.

### 3.5 Repair — any engine can drive it

The assisted sign-in repair's model calls (step supervisor, navigator) choose their engine with
the §3.2 independence selector: a dead Claude login is repaired by a Codex-driven helper when no
Claude account is healthy (and vice versa). This generalises ReloginLastResortProvider from "one
API key" to "any healthy engine". Operator approval rules for the repair are unchanged.

### 3.6 Pool health uses the CLI's own answer (asymmetric)

The pool must not report `active` while the CLI says signed out. Measured: `claude auth status`
can say `loggedIn: true` for an expired login (skill-driven-signin-repair), so a YES is not proof;
`loggedIn: false` for an account's config home is a trustworthy NO once the empty-home canary has
proven the check can say no. Rule: on each poll, and on any judged `engine-login`, the poller reads
`claude auth status` for the account's home. Canary-backed `loggedIn: false` moves the account to
`needs-reauth` with cause `cli-auth-status-signed-out`. `loggedIn: true` changes nothing (the OAuth
usage read remains the positive signal). Unreadable ⇒ `unknown`, status unchanged. A usage reading
older than its staleness bound renders `stale` on the dashboard, never `active`.

**Built 2026-11-15 (CMT-1781 item 3), for the case the existing reads cannot see.** The read runs
on each poll for an account whose stored credential cannot be read at all
(`credential-absent-or-unreadable`); every other case already has a positive or negative signal
from the usage read and the refresh exchange. A NO counts only while the engine's credential store
is open (macOS: `security show-keychain-info` exits 0 for the login keychain), because a locked
keychain after a reboot makes a working login read as absent; a locked or unreadable store is
`unknown`. Two trusted NOs at least 5 minutes apart move the account to `needs-reauth` (cause
`cli-auth-status-signed-out`, admitted by the repair like the other signed-out causes); one NO
shows `signed-out` next to the status at once. Engine-specific parts live in
`ENGINE_LOGIN_READERS` / `ENGINE_CREDENTIAL_STORE_OPEN` (adapter tree).

### 3.7 Switches, spend, rollout

- Kill switch `monitoring.neverSilent.enabled` (live config). Per-action switches
  `.frameworkFallback`, `.answerStartupDialogs`, `.judge` (judge off ⇒ every opened obligation is
  `undetermined` and told). Telling cannot be switched off while the feature is on.
- Spend: judge + referee calls count against the agent's existing LLM daily spend cap (LlmQueue),
  in a dedicated lane; over cap ⇒ `undetermined` + told. No new numeric cap.
- **Acting requires measured reliability.** Phase 3 runs the real judge in shadow (verdicts
  logged, users told, no actions) over (a) a held-out corpus of real panes — every login,
  usage-wall, dialog and stall pane collected in incident history, with rewordings never shown to
  the prompt author — and (b) healthy and slow-but-working counterexamples. Actions turn on per
  class only when that class's measured false-action rate on the corpus is zero and its recall
  beats the regex hints. The confidence floor starts at 0.8 and is recalibrated from that
  measurement (Frontloaded Decision 1).
- Maturation path: throwaway test agent first (the §6 live proof and the judge corpus run), then
  dev-gated live on development agents (Echo), then the fleet on graduation; registered in
  `devGatedFeatures.ts` with justification.

### 3.8 Migration Parity

ConfigDefaults for `monitoring.neverSilent` via `migrateConfig()` (only missing keys).
CLAUDE.md awareness reaches existing agents through `migrateClaudeMd()` with a content-sniffing
guard (a Registry First row "why did a conversation go quiet?" → `GET /never-silent/incidents`,
and a proactive trigger), and through `generateClaudeMd()` for new agents. No hook changes.

## 4. Observability and provenance

`GET /never-silent/incidents` — per obligation: conversation, injected at, trigger, judge route,
class, confidence, action and outcome, notice sent (messageId), terminal state. The full scrubbed
judge input and raw verdict are kept in the machine-local provenance file (mode 0600, 14-day
retention, the device-limit judge's pattern), so every verdict can be audited. Two
records are kept apart: the *recovery outcome* (was the conversation answered afterwards) is an
operational fact, never a correctness label; *diagnosis/action correctness* is graded by Decision
Provenance & Outcome Review — an independent referee read of the stored input plus a sampled
operator review — and only those grades feed recalibration (§3.7).

## 5. Phases

0. Verify the §1.4 hypothesis from Inspec's logs (did StallTriage/PresenceProxy fire 06:01–10:40,
   on which engine, with what outcome?) and record the answer here before building.
   **Result (2026-11-14, read from Inspec's `logs/` on the laptop, window 2026-11-13 14:00–18:45Z):**
   no StallTriage, PresenceProxy, triage or standby record exists anywhere in the window, and no
   standby line reached any of the three conversations. Over the same window every scheduled job
   session ended `process-exited-during-startup` (`logs/reap-log.jsonl`, about every 5 minutes),
   which is the dead login killing every Claude spawn. So the watchers either never fired or failed
   without leaving a trace; either way they were no protection. The hypothesis stands as stated,
   and the build treats it as confirmed: the notice path (§3.4) uses no LLM, and the judge (§3.2)
   never runs on the stuck engine.
1. §3.6 pool rule.
2. Obligation records + §3.4 telling (judge-off ⇒ `undetermined` notices) — closes "nothing" as
   an outcome on its own; route existing CMT-1008 failure outcomes into it; independence selector
   for the existing watchers.
3. Judge in shadow + the held-out corpus measurement (§3.7).
4. Actions per class as each passes its measurement; Codex startup-dialog policy.
5. Cross-engine repair driver (§3.5).

## 5a. As built — first version (2026-11-14)

Everything below that this version leaves for later is tracked as one commitment. <!-- tracked: CMT-1781 -->

> **CMT-1781** — "After the first never-silent PR merges: (1) run the held-out pane corpus measurement and turn actions on per class (spec 3.7); (2) move the other recovery producers onto one shared per-conversation lease (Phase 2); (3) add the every-poll claude auth status read; (4) engine moves and the one-tap ask on Slack and app conversations; (5) the bounded probe rung on the stuck account."

What the first build does differently from §3, and why. Each item is the smaller version of the
same rule, not a dropped rule.

- **"Answered" (§3.1).** The turn-consumption ledger does not exist yet: SessionManager keeps one
  in-memory pending injection per session, and the delivery journal covers only Codex with Stage B.
  So a message is answered when a real agent message is delivered in that conversation after it
  (the agent's own row, not a standby line, not a lifecycle notice and not Instar's own notice).
  No wording list decides what counts as a real message: a short acknowledgement counts as an
  answer, which can miss "said 'on it' and then died" but never sends a false "not answered".
- **Notice deadline (§3.1).** `monitoring.neverSilent.noticeAfterSeconds`, default 120 — the
  PresenceProxy second-tier delay, its existing "a person has waited" point. A delivered standby
  line still counts as the waiting notice.
- **Never held quiet.** Notices go through a new `never-silent-notice` conversation category whose
  selectivity rule always delivers when the notice names its waiting inbound message (the producer
  is internal; the category comes from `categoryForProducer`, never from request metadata). The
  existing `message-loss-notice` floor holds anything older than 15 minutes, which would have made
  a "repair worked" notice silent.
- **Judge (§3.2).** Jev answers two choice questions (the silence class, and what the session did
  after the message) with a probability each; at or above 0.7 Jev decides, otherwise the referee —
  a Codex account for a stuck Claude session, a different Claude account for a stuck Codex session —
  answers the same two questions as JSON. The stuck framework+account is never asked; with no
  independent route the verdict is `undetermined` and the person is told. The bounded probe rung on
  the stuck account is not built (no route ⇒ tell). The held-out corpus measurement (§3.7) is not
  run yet; that is why actions ship off. <!-- tracked: CMT-1781 -->
- **Replay boundary (§3.3).** "Side-effecting tool call since the message" is read from the judge's
  second answer, not from a transcript parse: `none`/`read-only` allow an automatic move, `some` or
  `unknown` turn the move into the one-tap ask.
- **Engine move (§3.3c).** The topic-profile store is written as `system:never-silent` (keeping the
  previous profile as the undo target) and the session is restarted through the same path as the
  `/route` switch, carrying the waiting messages and the instruction to open with one line on why
  the reply is late. `intendedProfile` is not used (it is the §14 dry-run shadow); the incident
  records where it moved from, and the move is undone once that account's sign-in works again and
  the conversation is idle, only if nobody changed the profile since. Moves and the ask are
  Telegram-only in this version (topic profiles are keyed on Telegram topics); Slack conversations
  get plain notices (no button), and only top-level Slack channel messages are tracked, because an
  agent's Slack reply is logged without its thread. Known limit: an agent reply in an unrelated
  thread of the same channel also counts as the answer to a top-level message. <!-- tracked: CMT-1781 -->
- **Moving back.** Only after the original account passes its sign-in check (`loginCheck: ok` and
  `active` — never "not known to be broken"), only when the conversation is idle, and only if the
  profile still carries this feature's label. It applies at the conversation's next restart (the
  notice says so). An operator pin comes back under `system:never-silent:restored-pin:<who>`,
  which still counts as a pin; writing it in the operator's own name would count as a fresh
  operator write. A new silence within 6 hours of a move back asks instead of moving (the repair
  did not hold). A failed restart undoes the move, and nothing is written when there is no session
  to restart.
- **Config (§3.8).** No `ConfigDefaults` block: every `monitoring.neverSilent` key has its
  default in code (absent ⇒ judge on, actions and engine moves off, floor 0.8, notice after 120 s)
  and `enabled` is dev-gated, so existing agents need no config migration. The CLAUDE.md section
  reaches existing agents through `migrateClaudeMd` as specified.
- **Spend bound.** Judge calls for one incident back off: 60 s, doubling, up to 10 minutes,
  whatever changes on screen.
- **Startup dialog (§3.3, §1.5).** Instead of a judged keypress, the agent's own launch folder is
  recorded as trusted in the Codex home before an interactive Codex launch
  (`ensureCodexProjectTrusted`), so "Trust this folder?" never appears. Any other startup dialog is
  told, never answered.
- **Pool health (§3.6).** Claude Code's own `auth status` is read for the session's home when a
  silent Claude conversation is judged (with the empty-home canary), and a judged `engine-login` at
  or above the floor goes through `QuotaPoller.observeCliLoginExpired` — the existing funnel that
  moves the account to `needs-reauth` and holds it there, so the pool stops saying "active". The
  every-poll read for an account with no readable credential was added 2026-11-15 (§3.6).
- **Recovery lease (§3.3).** Recovery is serialized per conversation inside the watcher; moving the
  other recovery producers onto one shared lease is Phase 2 and not in this build. <!-- tracked: CMT-1781 -->

## 6. Tests (three tiers + live proof)

- **Unit:** a standby line followed by a judged login failure still produces the status notice;
  an unchanged evidence revision makes no judge call; a tool call started during recovery is caught by the post-fence re-read; a message
  arriving after a notice gets its own later notice; a session with a different failure on the
  same account is not acted on from the account incident; verdict discarded on generation change / closed obligation / vanished dialog; one notice
  for three open messages in one conversation; a continuously working session crossing the deadline
  gets only its standby line; obligation state machine (answered only by a delivered reply from the turn that consumed
  that inbound id; mid-turn consumption; two producers racing for one conversation — only the lease
holder acts; status notices for diagnosis → recovery started → exhausted; overlapping messages; progress/notice never answers;
  told-pending closes on a later reply); overdue sweep catches an idle session that never starts a
  turn and an obligation that survived a restart; replay boundary refuses an automatic move after a
  side-effecting tool call;
  engine-independence selector never picks the stuck framework+account; truncation disclosure
  caps the verdict at tell; class→action table both sides of every boundary; asymmetric
  auth-status rule; startup-dialog keypress refused once a turn has started; fallback breaker.
- **Integration (HTTP):** `/never-silent/incidents`; an injected message + turn end without reply
  yields exactly one notice when the judge (a) throws, (b) never returns, (c) returns
  `undetermined`; the action never blocks the notice deadline.
- **E2E:** production init path, feature alive (200 not 503); throwaway agent with one expired
  Claude account and one Codex account: message in → answered on Codex + notice + repair opened.
- **Judge evaluation (not a stub):** the held-out corpus run of §3.7 with the real referee route,
  reporting precision/recall per class and false-action count; a stub test alone never enables an
  action.
- **Live-User-Channel Proof:** throwaway agent through the real Telegram demo group AND the Slack
  test workspace AND the app, never the operator's channels.

## Maturation plan

- **test-agent-live:** a throwaway agent with one deliberately expired Claude account and one
  signed-in Codex account, driven through the real Telegram demo group, the Slack test workspace
  and the app: a message in → waiting notice, judged `engine-login`, conversation answered on Codex,
  status notice, repair opened. Also an idle-at-prompt session that never starts a turn (overdue
  sweep) and a Codex trust dialog at startup.
- **dev-agent-live:** Phases 1–2 (pool rule, obligations + telling) live on Echo from merge; Phase 3
  judge in shadow on Echo; each action class turns on only after its held-out measurement passes.
- **fleet:** obligations + telling + pool rule first (they only add notices and an honest status);
  judge actions per class after graduation on Echo.
- **graduation criterion:** per action class, the held-out corpus shows zero false actions and
  recall above the regex hints, AND on Echo at least one real silence of that class was judged,
  acted on and closed by a delivered reply, with no outcome-review grade of `wrong`. A zero count is
  not a pass.
- **dark-window:** at most 30 days from merge to the fleet decision for telling; action classes that
  have not met the criterion by then get the reason and a new date recorded on the tracking action —
  never left dark silently.
- **ladder:** monitoring.neverSilent

## 7. Decision points touched

| Decision point | Classification | Floor / justification |
|---|---|---|
| Is this inbound message still owed an answer? (obligation state) | invariant; basis: enumerable-domain; evidence: an obligation has four recorded states (pending, answered, told-pending, released) set by structured send/turn records, not by text | Detector only; it never acts by itself — it opens judgment and the §3.4 notice deadline. |
| When to judge (state changes of a session holding an open obligation) | judgment-candidate | Floor: SessionActivityVerdict transitions + existing hung-vs-slow evidence; arbiter: the judge; ladder ends at the existing stall backstop timer (deterministic rung). |
| Why is it silent? (class) | judgment-candidate | Arbiter: ConversationSilenceJudge (Jev → Luna referee). Bounded action space: the closed class enum. Conservative default: `undetermined` (tell, attention item, no automatic move). Fallback ladder: Jev → other-framework account → other same-framework account → repair API key → `undetermined`. |
| Which engine runs the judge | invariant; basis: irreversible-consequence; evidence: a call on the stuck framework+account is asking the broken thing whether it is broken — with a dead login it cannot answer at all (2026-11-13 Inspec: `claude auth status` loggedIn false on the only Claude account). Whether the existing watchers actually failed this way is the §1.4 hypothesis, verified in Phase 0; the rule stands as a design precaution either way | Never the stuck framework+account. |
| Act on a class (swap / framework fallback / dialog answer / respawn) | judgment-candidate | Floor: the class→action table, confidence floor, per-action switches and brakes in §3.7; arbiter: the judge's verdict; each action through its existing funnel, which keeps its own refusals. Below floor ⇒ tell only. |
| Answer a startup dialog | judgment-candidate | Floor: fixed per-framework action space (workspace-trust for the session's own registered cwd; decline optional features), only before the first turn; arbiter: judge verdict at or above the floor; else tell. |
| Operator attention | judgment-candidate | Floor: Self-Heal Before Notify — reachable only after self-heal exhaustion (§3.4), flapping escalates as critical; arbiter: the exhaustion predicate over the funnels' recorded outcomes. |
| Enable actions for a class | invariant; basis: irreversible-consequence; evidence: an automatic engine/account move or keypress is a user-visible change that cannot be unsent; acting on an unmeasured judge is the failure the Intelligent Prompts standard names | Per class, only after the §3.7 held-out measurement shows zero false actions. |
| Tell the user | invariant; basis: irreversible-consequence; evidence: an unanswered person with no notice is the harm this spec exists to prevent (Justin 2026-11-13 10:36) | Always, via the deterministic notification path; not switchable while the feature is on. |
| Pool status from `claude auth status` loggedIn:false | invariant; basis: external-constraint; evidence: the CLI's own structured answer; measured asymmetric reliability (false is trustworthy after the empty-home canary, true is not — skill-driven-signin-repair) | false ⇒ needs-reauth; true ⇒ no change; unreadable ⇒ no change, `unknown`. |

## 8. Multi-machine posture

- Silence detection and judging: `unified` through the existing session ownership — the machine that holds the session (and its inbound ledger) runs the trigger and judge; on topic transfer the pending-inbound record moves with the existing durable inbound queue.
- Incidents log (`/never-silent/incidents`): proxied-on-read via `?scope=pool`, the same merged-read pattern as `/jobs?scope=pool`.
- Pool auth-status reads: machine-local-justification: physical-credential-locality — a Claude/Codex login lives in one machine's config home; the resulting account status already replicates through the existing subscription-pool sync.
- User notices: one-voice — sent only by the machine that owns the conversation's session (existing notice ownership).
- Operator attention items: deduped by condition key across machines through the existing attention-condition clear/raise path.

## 9. Frontloaded Decisions

1. **Confidence floor for acting:** starts at 0.8 after the cascade (Jev's 0.3–0.7 band escalates to the Luna referee) and is recalibrated per class from the §3.7 held-out measurement. Cheap-to-change-after: a live config value; actions are off until that measurement passes, and the feature is dev-gated.
2. **Automatic framework fallback scope — operator-decided 2026-11-14.** Justin, topic 141385, 2026-11-14 13:39 PST, answering "if you've pinned a conversation to Claude, should it ask you before moving it to Codex?":
   > "ask, as long as it is robust and minimally interrupting for the user"

   So: conversations with NO topic-profile pin fall back automatically; a conversation with an explicit framework or model pin is told and asked. The ask is built to his two conditions:
   - *Minimally interrupting:* the ask is the status notice itself — one message, one tap ("Move to Codex"), on the conversation's own surface (a Telegram inline button, a Slack button, an app action) through the existing topic-profile propose route. No second message, no typed reply, no dashboard trip. One open ask per conversation per incident; a later message in the same incident joins it rather than asking again.
   - *Robust:* the ask never gates the notice (the person is told what happened in the same message); a tap is applied idempotently (a second tap or a stale tap after the incident closed does nothing and says so); a tap on another machine is routed to the session owner by the existing propose route. **No tap is a sane outcome, not silence:** the conversation stays on its pinned engine, the sign-in repair (§3.5) keeps running, the obligation stays `told-pending`, and the next status notice (repair succeeded ⇒ the waiting message is re-driven on the original engine; repair exhausted) goes out as usual. The ask is never re-sent on a timer.

   The automatic move (unpinned) is recorded as `intendedProfile` so the conversation returns to its original framework once the original login is repaired.
3. **Fast-path trigger scope:** only conversation-bound sessions (Telegram, Slack, app) with a pending inbound message. Job sessions and internal helpers are out of scope — they have their own rerouted-session login handling.
4. **Notice wording owner:** fixed per-class templates in code (no LLM), reviewed in the PR; the judge's evidence is not shown to the user.

## 10. Open questions

*(none — the pinned-conversation question was answered by the operator on 2026-11-14 13:39 PST; see Frontloaded Decision 2.)*
