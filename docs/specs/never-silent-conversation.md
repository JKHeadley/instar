---
title: "Never-Silent Conversation — an unanswered message is judged, acted on, and always told"
slug: "never-silent-conversation"
author: "echo"
status: "draft"
created: 2026-11-13
parent-principle: "No Silent Degradation"
sibling-principles: "Intelligent Prompts — An LLM Gate Must Not String-Match; Signal vs Authority; Structure > Willpower; Verify the State, Not Its Symbol; Framework-Agnostic — and Framework-Optimizing; Close the Loop"
lessons-engaged: "CMT-1008 interactive login-expired swap (2026-10-25, Luna); rerouted login-expired slot hold (2026-10-18, #2200); framework-stall-coverage-matrix (stall classes discovered one incident at a time); relogin-last-resort-model (the repair of the only account cannot run on the dead account); skill-driven-signin-repair (pool health from the CLI's own login status; claude auth status can say loggedIn:true for an expired login); codex-device-limit-tripwire (Jev judge on a DIFFERENT account, bounded, content-free log); confined-spawn-subscription-reroute D2 (reworded dialog lands in dialog-unknown); Justin 2026-10-25 'mechanical checks are inputs only'; Justin 2026-11-12 'judge hung vs slow, not dumb timers'"
origin: "Operator directive 2026-11-13 10:36 + 10:40 PST, topic 33890 (Inspec silent login expiry)"
eli16-overview: "never-silent-conversation.eli16.md"
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

The trigger is the existing inbound ledger + StallDetector fact: *an inbound message was injected
into session S at time T, and no outbound reply for that conversation has been recorded since.*
That already exists per platform (Telegram, Slack, app). This spec adds no new wording detector.

When to look is judged, not timed (operator rule 2026-11-12, "judge hung vs slow"):

- **Fast path (seconds).** The turn ENDED without an outbound send: the session went from
  "working" back to idle-at-prompt (SessionActivityVerdict) within N seconds of injection, with no
  tool calls and no outbound send. A session that answers a user in 1–4 s with zero tool calls and no
  reply has not answered. This is a structural fact, not a text match, and is what all three Inspec
  panes showed ("Baked for 4s · done").
- **Slow path.** Still working with no reply: the existing hung-vs-slow evidence (activity verdict,
  tool-call progress, transcript growth) decides when to escalate to the judge, as today's triage
  does. A fixed minute count is only a backstop.
- **Startup path.** A session spawned or respawned for a pending inbound message that has not
  reached a ready prompt within its startup budget (covers the Codex trust dialog).

Counts and timers are inputs to the judge; none of them is an action by itself.

### 3.2 Judge — an LLM referee that does not share the failing engine

A new `ConversationSilenceJudge` (authority; the detectors in §3.1 and the hints below are its
signals). It follows the Jev pattern already proven by `CodexDeviceLimitJudge` + `JevCascade`:
Jev first, Luna referee (Codex fast tier) when Jev is unsure or on audit.

**Engine independence (the load-bearing rule).** The judge's call must not run on the stuck
session's framework+account. Selection order: (1) Jev (local, no subscription); (2) a signed-in
account on a DIFFERENT framework (Codex for a stuck Claude session, Claude for a stuck Codex one);
(3) a different signed-in account on the same framework; (4) the operator's repair-specific API key
(`ReloginLastResortProvider`, existing consent and caps). The chosen route is named in every
verdict record.

**Inputs** (prepared snippet, capped, secret-scrubbed and PII-masked exactly like the device-limit
judge):
- the pane tail (last ~40 non-empty lines, with lead glyphs preserved) and startup pane if any;
- the engine's own structured auth answer for the session's config home: `claude auth status`
  JSON (`loggedIn`, `authMethod`, `loginExpiresAt`) or `codex login status` verdict;
- pool state for the session's account (status, loginCheck, last reading age, statusCause, limits
  and reset times) and whether any other account on each framework is healthy;
- timing facts: injected at, turn end, tool-call count, outbound sends since;
- **hints**: the existing regex classifiers (`classifyLoginExpired`, `StuckSignatureClassifier`,
  `classifyConfinedStartupPane`, usage-wall detectors) run and their verdicts are passed in as
  labelled hints. They never decide; the prompt says so (Intelligent Prompts standard), and a
  hint-free run must still classify correctly (tested with today's unmatched wording).

**Output** (closed schema): `class` ∈ {`engine-login`, `usage-or-subscription-wall`,
`startup-dialog`, `crashed`, `working-slow`, `message-not-delivered`, `other`}, `confidence`
(0–1), `evidence` (which inputs decided it, quoted ≤160 chars each), and for `startup-dialog` the
dialog's question and the option the judge believes is the safe, intended answer.

**Judge unavailable** (no route, all calls fail, caps hit): the outcome is `undetermined`, which
still runs §3.4 (tell the user) with the honest wording "your message was not answered and I could
not yet work out why", plus an operator attention item. Never silent.

### 3.3 Act — existing funnels only

The judge decides the class; a deterministic policy maps class → action through funnels that
already exist and already carry their own brakes:

| Class | Action |
|---|---|
| `engine-login` | (a) `QuotaPoller.observeCliLoginExpired` marks the account needs-reauth (judge verdict ≥ confidence floor counts as the corroborating sighting, replacing the regex). (b) `QuotaAwareScheduler.onQuotaPressure` swap to a signed-in account on the same framework. (c) If none: **framework fallback** — the topic-profile write path (`TopicProfileOrchestrator`) switches the conversation to another framework with a healthy account, marked `intendedProfile`/`parked` so it returns when the original login is repaired. (d) Open the assisted sign-in repair (§3.5). |
| `usage-or-subscription-wall` | Existing UsageWallRescue / swap; same cross-framework fallback when no account on this framework has room. |
| `startup-dialog` | Answer only when the judge is confident AND the dialog is a known-safe class (workspace trust for the session's own registered cwd; decline optional features). The keypress goes through a per-framework dialog policy that extends `confinedStartupDialogs` to Codex. Otherwise: tell the user and the operator. |
| `crashed` / `message-not-delivered` | Existing respawn / re-inject paths (TriageOrchestrator actions). |
| `working-slow` | No action; a progress note to the user only if the slow-path wait passes the existing standby tier. |
| `other` / `undetermined` | Tell + attention item. |

Framework fallback is new as an automatic action but uses the existing switch: it is the same
restart-with-history the operator route performs. It is allowed only to a framework whose door
`/topic-profile/options` reports `available: true` and that has a pool account with loginCheck `ok`.

### 3.4 Tell — unconditional, plain, in the conversation

Every judged silence produces, in the affected conversation, one plain message sent by Instar's
own notification path (not the stuck session, not an LLM): what happened, what was done, what (if
anything) the person must do. Templates per class, e.g.:

> "Your message didn't get an answer: the Claude sign-in this conversation uses ran out. I've moved
> this conversation to Codex so it can answer now, and started the Claude sign-in repair."

Plus one operator attention item per account/incident (deduped by condition key, closed on cause),
so a fleet-wide expiry is one item, not one per conversation. The send uses the deterministic
notification path that does not need any LLM, so it works when every model route is down.

### 3.5 Repair — any engine can drive it

The assisted sign-in repair's model calls (step supervisor, navigator) select their engine with the
same independence rule as §3.2: a stuck Claude login is repaired by a Codex-driven helper when no
Claude account is healthy (and vice versa). This generalises ReloginLastResortProvider from "one API
key" to "any healthy engine". Operator approval rules for the repair are unchanged.

### 3.6 Pool health uses the CLI's own answer (asymmetric)

The pool must not report `active` while the CLI says signed out. Measured: `claude auth status`
can say `loggedIn: true` for an expired login (skill-driven-signin-repair), so a YES is not proof;
but `loggedIn: false` for an account's config home is a trustworthy NO. Rule: on each poll, and on
any judged `engine-login`, the poller reads `claude auth status --json` for the account's home. A
`loggedIn: false` answer, once confirmed by the existing canary (the check has been proven able to
say no on an empty home), moves the account to `needs-reauth` with cause `cli-auth-status-signed-out`
— no two-session rule needed. `loggedIn: true` changes nothing (the OAuth usage read stays the
positive signal). A usage reading older than its staleness bound reads `stale`, never `active`, on
the dashboard.

### 3.7 Brakes, switches, rollout

- Kill switch `monitoring.neverSilent.enabled` (live config). Per-action switches:
  `.frameworkFallback`, `.answerStartupDialogs`, `.judge` (off ⇒ every silence is `undetermined` and
  told — telling cannot be switched off while the feature is on).
- Per-conversation: one judge run per inbound message; one framework fallback per conversation per
  6 h; dialog answers max 2 per session.
- Spend: daily judge-call cap shared with the device-limit judge's counter style; over cap ⇒
  `undetermined` + told.
- Dev-gated: live on development agents (Echo), dark on the fleet until the graduation proof;
  registered in `devGatedFeatures.ts` with justification.
- Protected sessions are never moved; they are still told.

### 3.8 Migration Parity

ConfigDefaults for `monitoring.neverSilent` via `migrateConfig()` (only missing keys). CLAUDE.md
template: a Registry First row ("why did a conversation go quiet?" → `GET /never-silent/incidents`)
and a proactive trigger. No hook changes.

## 4. Observability

`GET /never-silent/incidents` — per incident: conversation, injected at, trigger path, judge route,
class, confidence, action taken and its outcome, user message sent (messageId). Feature metrics for
every judge call. The incident log is content-free beyond the capped evidence quotes.

## 5. Phases

0. **Verify the hypothesis in §1.4** from Inspec's logs (did StallTriage/PresenceProxy fire 06:01–10:40,
   and on which engine?) and record it here before building.
1. §3.6 pool rule (smallest, independently valuable).
2. §3.4 Tell for the existing CMT-1008 failure outcomes (closes failure 3 immediately).
3. §3.1 fast-path trigger + §3.2 judge (shadow: verdicts logged and told, no actions).
4. §3.3 actions incl. framework fallback; Codex startup dialog policy.
5. §3.5 cross-engine repair driver.

## 6. Tests (three tiers)

- **Unit:** judge prompt-builder (hints labelled, never required); engine-independence selector
  (never picks the stuck framework+account); class→action policy table, both sides of every
  boundary; asymmetric auth-status rule (false ⇒ needs-reauth after canary; true ⇒ no change);
  fixture: today's "Login reached its time limit" pane with ALL regex hints returning negative must
  classify `engine-login` via the judge stub; Codex trust-dialog fixture.
- **Integration:** HTTP — `/never-silent/incidents`; an injected message + turn-end-without-reply
  produces exactly one in-conversation notice even when the judge route throws.
- **E2E:** production init path, feature alive (200 not 503); a throwaway agent with one expired
  Claude account and one Codex account: message in → conversation answered on Codex + notice +
  attention item + repair opened.
- **Live proof:** Live-User-Channel Proof on a throwaway agent + demo Telegram group, never the
  operator's channel.

## 7. Open questions

1. Confidence floor for acting on `engine-login` without any regex hint (proposed 0.8; Jev band
   0.3–0.7 escalates to Luna).
2. Is automatic framework fallback acceptable for every conversation, or should a topic be able to
   opt out (e.g. a topic pinned to a specific model for quality)? Proposed: pinned topics are told
   and asked, unpinned topics fall back automatically.
3. Whether the fast-path "turn ended with no send" needs a per-framework allow-list for sessions
   that legitimately end without replying (job sessions, internal helpers) — proposed: the trigger
   applies only to conversation-bound sessions with a pending inbound.
