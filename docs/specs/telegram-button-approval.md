---
title: "Telegram-button approval — what a tap can authorise, what stays PIN-only, and the approval-volume verdict"
slug: "telegram-button-approval"
author: "echo"
eli16-overview: "telegram-button-approval.eli16.md"
parent-principle: "Structure beats Willpower"
lessons-engaged: "Structure beats Willpower; Know Your Principal; L15 Authorization Policy; Canonical Pipeline Operational Completeness; Self-Unblock rung FLOOR (capability is not authority); Signal vs Authority; Verify the State Not Its Symbol; Mobile-Complete Operator Actions; Agent Proposes, Operator Approves; Maturation Path; Migration Parity"
related-feedback: "fb-bc5da66f-f46"
related-specs: "docs/specs/a2a-pairing-invite-link.md (§6.1 Honest boundary); docs/specs/OPERATOR-AUTHORIZATION-REQUEST-SPEC.md (display-integrity rule); docs/specs/feedback-triage-and-execution.md (§4 review gate, per-PR floor, §5 action list)"
review-convergence: "2026-10-19T19:23:58.623Z"
review-iterations: 12
review-completed-at: "2026-10-19T19:23:58.623Z"
review-report: "docs/specs/reports/telegram-button-approval-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 12
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Telegram-button approval

**Answer in one paragraph.** No: a Telegram tap cannot be made worth a structural PIN, because Telegram
cannot prove that the operator's own hand pressed a button, and this agent can produce taps through his
account. But today's PIN is not structural either — the agent can read it, and so can anyone holding only
the agent's API token — so today a tap is no weaker than the PIN. This spec therefore builds no tap-approval
gate and no new buttons (the approval messages already carry tappable links). It records the rule for what a
tap may ever authorise where spec reviewers will meet it, and hands the PIN's real fixes — including the leak
it found (ACT-113) and an honest rewrite of the agent's PIN instructions — to one follow-up spec. On volume, no venue change
helps: each fix still needs a code review. A proposed "evidence card" that would make each review a ten-second
decision was examined and rejected: its key promise — every line comes from verified fact, never from prose —
cannot be enforced, because the code it would show was itself written by an untrusted hand. The standing
structural answer is a second trusted reviewer (option (a)), the operator's decision.

## Problem statement

The operator approves things in two places: the dashboard PIN for authority-bearing acts, and GitHub for
each code change the feedback executor produces. He has said twice that he must not be the bottleneck, and
he called re-typing the PIN per action redundant. The proposal on the table: let him approve with a button
tap in Telegram instead.

Two questions decide whether that feature should exist:

1. **Venue.** This agent can post, and can drive a browser, through the operator's own Telegram account.
   Can a Telegram tap ever be worth as much as a dashboard PIN? Worked out below from measured facts, not
   assumed.
2. **Volume.** The triage queue holds 298 work items. Does any change of venue fix that?

**Terms used below.** *Lifeline*: the small always-on process that polls Telegram and forwards updates to
the agent's server. *Tap*: a press on an inline button under a bot message, delivered as a Telegram
`callback_query`. *Readiness authority*: the operator-approved model that sorts feedback; a *brake* is
a rule that switches it off until re-approved. *Attention hub*: the single Telegram topic for alerts.

## Ground truth (verified 2026-10-19 on the Mac Studio, against `origin/main` at `bd340b087`)

Each line names the query that could have returned the opposite.

- **G1 — Where the PIN lives.** `dashboardPin` is a plain field in `.instar/config.json`, auto-generated
  there by `PostUpdateMigrator`. It moves into the encrypted vault only through `migrateSecrets()`, whose
  single caller is `src/commands/machine.ts` (machine pairing). A single-machine install therefore keeps
  it in plaintext — what fb-bc5da66f-f46 measured (6 characters, mode 664). On Echo (paired) the config
  holds `{ "secret": true }` and the PIN is in the vault, which the agent reads by design
  (`node .instar/scripts/secret-get.mjs <name>`). Either way the agent reads the PIN with ordinary tools.
  *Checked:* `git grep "migrateSecrets("`; a type-only read of Echo's `config.json` and its six backups
  (all `{secret:true}`; no value printed).
- **G2 — The file viewer.** Since #1905 (2026-08-15) `NEVER_SERVED_PREFIXES` contains `.instar/config.json`,
  and the prefix match covers `config.json.bak*`. Live on Echo: `GET /api/files/read` for
  `.instar/config.json` → 403, `.instar/config.json.bak` → 403, control `.instar/AGENT.md` → 200. So the
  "served by the file browser" half of fb-bc5da66f-f46 does **not** reproduce on current main (it may hold
  on an install older than #1905; the report does not name its version). The "agent can read it" half
  stands (G1).
- **G3 — The PIN is posted into Telegram, and from there into Bearer-readable history.**
  `TelegramAdapter.formatDashboardMessage` writes the PIN into the dashboard broadcast, and the agent's own
  instructions tell it to share the PIN with the operator ("give them the tunnel URL + PIN. Read the PIN from
  your config.json", `templates.ts` Dashboard section). Echo's message log (mode 644) holds 65 lines with the
  broadcast pattern. Anyone holding the operator's Telegram account, and any process on the host, can read
  them. **The API token alone can also read them** through the agent's message-history routes: a live probe on
  Echo returned PIN-shaped matches (values not printed). The route-level detail, the other copies and the other
  emitters are recorded in ACT-113 and deliberately not repeated in this public document until that fix lands.
  *Checked:* `grep -c` of the pattern (count only); one Bearer probe counting PIN-shaped matches only.
- **G4 — One OS user; an agent that edits its own server.** Every process on the host — sessions, lifeline,
  the server that checks the PIN — runs as one user, and the instar-developing agent writes and merges the
  code that performs every check. No host-local check is absolute against that agent; the useful measure is
  how deliberate and visible a bypass must be.
- **G5 — How taps are authenticated.** A tap reaches the server by one of two paths: when the lifeline polls
  Telegram it forwards the tap as `POST /internal/telegram-callback`; when the adapter polls Telegram itself (no
  lifeline), `TelegramAdapter.processUpdate` handles it directly (tunnel consent and the prompt gate act on it;
  pairing refuses that path and points to the dashboard). The forward route takes `callbackQueryId`, `data`, `fromUserId` and `chatId` **taken from the request body**. Once the
  lifeline-secret guard is armed, a request without the lifeline-only secret is refused; the secret is a
  0600 file in `.instar/state/` that, per its own documentation, no hook prevents a session from reading.
  So a session can forge a "tap from the owner" with `cat` and `curl` today. (The guard also accepts an
  unproven tap while unarmed — in observe mode, or in enforce mode within its pre-arm allowance — or when
  bypassed by config; what keeps an off-host caller out is the localhost-only rule on `/internal/*`, not the
  secret.) The bot token is equally
  readable, so a session could also pull Telegram updates itself. Three kinds of tap act on something today:
  - **pairing** (`pi:`, `src/threadline/PairingInviteTelegram.ts`): approve / finish an agent pairing, under
    five conditions (verified, guard in enforce mode, `from.id` = owner, chat = agent's chat, a one-time
    token bound to the invite and step). Its spec says the handler checks both chat ids; the code skips the
    chat check when either id is missing. Its spec calls the boundary cooperative, "the same as the PIN"
    (`a2a-pairing-invite-link.md` §6.1).
  - **tunnel consent** (`tc:g` / `tc:d`, `TelegramAdapter.processCallbackQuery`): grant or decline routing
    dashboard traffic through a third-party relay. Owner check `if (owner && from.id !== owner)` passes
    when no owner is configured.
  - **prompt-gate relay**: delivers the operator's answer to a session's on-screen prompt. Same
    `ownerId && …` pattern.
- **G6 — The agent can act through the operator's Telegram account.** The Playwright profile registry lists
  `justin-telegram` (operator-owned Telegram Web login, directory present). The typed browser broker
  exposes only `snapshot` and `send`; generic browser tools are steered away from it by a hook its own
  documentation calls cooperative. A button pressed in that profile yields a real `callback_query` whose
  `from.id` is the operator's; the Bot API carries no device or presence attestation.
- **G7 — The same holds for GitHub.** The registry lists `justin-github` (identity `JKHeadley`, directory
  present). `feedback-triage-and-execution.md` §4 already reacts: live `GET /feedback-factory/execute/status`
  returns `available: false, reason: approver-not-independent, dryRun: true`, limits `maxConcurrent 2,
  maxStartsPerDay 6, maxOpenPrs 4`. The operator may accept that condition through the PIN (G1).
- **G8 — PIN surface.** 31 route handlers in `src/server/routes.ts` call `checkMandatePin` (mandates, guard
  accept-fallback, external-hog arm, green-PR enable, pairing, and all feedback-factory mutations through
  `feedbackMutationIntentValid`, including readiness-authority create/replace/revoke/restore); routing-spend
  and money-layer plan/commit compare the PIN directly. A second, already-live venue: routes that accept the
  15-minute dashboard operator-session token issued by the PIN unlock (`verifyDashboardOperatorSession`):
  topic-profile new-topic default, identity-change reads, Playwright profile provision, subscription re-login
  configure and events, and the Telegram origin operator routes.
- **G9 — Volume.** Live `GET /feedback-factory/triage/summary`: `work 298`, `hold 195`, `ignored 0`;
  severities critical 29 / high 25 / medium 232 / low 12; `workPrecision: null`; rule-default agreement
  23/666. Nobody has measured how many of the 298 merit a fix. The action list already links each PR
  awaiting approval (`FeedbackExecutorService.actionItems`).
- **G10 — A planned Telegram countersignature.** `src/remediation/channels/TelegramApprovalChannel.ts` is a
  stub `TrustedApprovalChannel`, the default for personal agents in
  `SELF-HEALING-REMEDIATOR-V3-CONSOLIDATED-SPEC.md` §10, where a Telegram countersignature is meant to count
  as a *different principal* for un-quarantine, scope expansion and the `runbook-pr-gate.yml` check. Its
  real verification is a "Tier-2 follow-up"; nothing verifies through it yet.

- **G11 — The API token is full control of the host.** `POST /sessions/spawn` (`routes.ts`) starts a session
  with any prompt for any Bearer caller (rate-limited, no further check), and `POST /dashboard/unlock`
  (`AgentServer.ts`) exchanges the PIN, with no other credential, for that same API token (plus a separate
  15-minute operator-session token). So an off-host holder of the token can spawn a session that does
  everything the agent can (G1, G5), and an off-host holder of the PIN plus a reachable dashboard gets the
  token.

- **G12 — A planned tap surface with P-class actions.** `src/monitoring/BurnAlertButtons.ts` builds signed
  buttons Release (lift a burn throttle), Snooze 24h (mute the alert), Extend +1h and Investigate, "wired in a
  follow-up" under the approved `token-burn-detection-and-self-heal.md` (Phase 5). Nothing constructs it yet;
  its HMAC key is a constructor argument, so whatever key the server will hold is on the host, and "forged
  callback data fails verification" will hold against outsiders, not against the agent.

## The head-on answer

Three attackers matter. **T1** is off the host and holds only the Bearer token (a leaked token, a tunnel
caller). **T2** is the agent itself, using its ordinary tools. **T3** has taken over the operator's
Telegram account.

| Who is trying to approve | Dashboard PIN today | Telegram tap today |
|---|---|---|
| T1 | Does not stop: the token spawns a session that reads the PIN (G11, G1); history routes also return it (G3) | Does not stop: the token spawns a session that forges a tap from 127.0.0.1 (G11, G5) |
| T2 | Does not stop: read the vault or the log (G1, G3) | Does not stop: read the lifeline secret and post to the route (G5), or press a real button through an operator Telegram session where one exists (G6) |
| T3 | Does not stop: the PIN is in the chat (G3) — and with a reachable dashboard it yields the full API token (G11) | Does not stop |

One more attacker is specific to taps: on an install with no owner configured, **any chat member** can answer
prompt-gate buttons (G5) without holding the PIN; that is the fail-open check in ACT-115, a repair independent
of the PIN migration.

**Today neither the PIN nor a tap is a boundary against anyone who matters.** The API token is full control of the host
(G11), so T1 is T2 with one extra request. The PIN's real function is the dashboard door: it is exchanged for
the API token. Per-action PIN re-entry is therefore an *intent record* — proof that a PIN-shaped step
happened — and friction against an agent acting by mistake; it is not a boundary against anyone who holds
the token, the PIN, or a session. The same is true of a tap, which records intent in the same way. **Moving an approval from the PIN
to a tap would remove no boundary that exists today** — only the small friction of typing. Closing the history leak (ACT-113) does not change this while G11 holds.

**Once the PIN is replaced by a credential that lives off the host (sibling spec), a tap cannot be equivalent
in this architecture** (the agent, the lifeline and the bot token on one OS user). A passkey assertion from the
operator's own device cannot be produced by any session, even one spawned with a stolen token. A Telegram
callback can: on the lifeline path its sender is taken from a forwardable request body (G5); on the
direct-poll path Telegram asserts the sender, but the agent can press real buttons through an operator Telegram
session where one exists (G6) or, holding the bot token, take a genuine press in flight; and even a genuine
callback proves only
"something logged into the operator's account pressed this", never "the operator's hand on his own device
pressed this". Checking the callback id with Telegram proves some real press happened, not who pressed or what
was pressed. A Telegram approval relayed by an independently operated service with its own credentials could
change the comparison; it is outside this build.

> **Rule.** A Telegram tap may authorise only an act whose worst case, **if the agent forged the tap**, is
> reversible and stays inside an envelope the operator already granted through the stronger gate. An act
> that creates or widens authority, spends beyond an approved cap, publishes, accepts risk, changes a trust
> anchor, turns off a safety control or a notice, or restores after an integrity failure stays on the
> dashboard gate.

**What "structural" can mean on this host.** G4 bounds every host-local gate: the agent can change the code
or the state that performs the check. Moving the secret off the host makes approval **resistant to
extraction with ordinary tools** — forgery then needs a deliberate modification of the checking code or its
state, with no guarantee that anyone sees it. Full independence needs enforcement that runs where the agent
cannot write. **None exists in this pipeline today**: the per-PR review is checked by the executor's own
code, and `JKHeadley/instar`'s ruleset requires code-owner review only on owned paths
(`feedback-triage-and-execution.md` §4). **Measured on the live repository (coordinator, 2026-10-19):** the
per-PR approval floor for feedback pull requests is enforced by the executor's own code, which the agent can
modify. GitHub currently requires no review for a feedback-derived pull request touching `src/`: `main`'s
ruleset carries only `deletion`, `non_fast_forward` and `pull_request`; `pull_request` has
`required_approving_review_count: 0` with code-owner review covering exactly two paths
(`docs/STANDARDS-REGISTRY.md` and `.github/CODEOWNERS` itself); no required status checks; classic branch
protection returns 404; positive control PR 2182 (targeting main, unarmed) reads clean. And there is **no
path-scoped GitHub rule that could enforce review only for feedback PRs** without gating all ordinary work:
CODEOWNERS matches paths, not authors, and the executor publishes from a fork, which GitHub evaluates against
the base repository's CODEOWNERS — a `src/**` line would require the operator's review on every source pull
request, the bottleneck he has twice refused and the trade the existing CODEOWNERS already weighed and
rejected in writing ("~10 approvals vs ~1"). Closing the gap needs a different mechanism: a separate
repository whose CODEOWNERS can cover everything because everything in it is feedback-derived, or an enforcer
running where the agent cannot write — both the operator's call, neither in this build.

## Proposed design

### 1. Classify approvals by consequence, not venue (the rule; no code in this build)

Every approval point belongs to one class. **Any point not classified is P** (fail-closed). The rule binds the
sibling spec and any future spec that adds a tap approval; its carriers are in §4 (a lessons-index paragraph
and a class map checked by a unit test).

| Class | Meaning | Venue | Examples |
|---|---|---|---|
| **S** — less action | Moves toward less agent action **and can be undone, with an audit record**: stop, hold, cancel a run, decline an item (re-openable), freeze spend, disarm an armed merge. Never turns off a guard, monitor, alarm or an armed safety kill, never suppresses or snoozes a notice, never reduces logging; an act that cannot be undone is P. | No approval needed (Bearer, text, any tap). | stop, hold, freeze, cancel, decline, disarm a merge |
| **R** — re-grant within an envelope | Restores authority previously granted through the dashboard, byte-identical, within its caps, after a system-raised brake on that feature's allow-list — never after the operator's own revoke. | A tap or the dashboard. | **None today** (below) |
| **P** — everything else | Creates/widens authority, spends beyond a cap, publishes, accepts risk, changes identity or trust, turns off a safety control or a notice, restores after an integrity brake, undoes an operator revoke. | Dashboard. Telegram carries a link to it. | the G8 routes that grant, widen, restore, arm, publish or accept (their revoke/stop/freeze acts are S); pairing approve/finish; tunnel-consent grant; a remediator Telegram countersignature (G10) |

S acts need no approval, so a forged-tap flood could stop or freeze a lot of work. Undoing the state does not
undo missed work, so any future spec that adds S taps must bound their rate per hour and keep the way back
(resume, unfreeze) off the tap venue, on a route a forged tap cannot reach. This spec adds no S tap.

**Why R has no consumer.** The obvious candidate — resuming the feedback readiness authority after the
daily spend brake — fails the test of need: once the UTC day rolls over, the cap has reset and nothing about
the envelope changed, so a deterministic resume is correct and no human is needed (proposed to the drain
spec's owner as ACT-118). Resuming after the operator's own `revoke` is P (a forgeable tap must not undo a
deliberate stop). Integrity brakes (`readiness-schema-provenance-or-routing-failure`,
`triage-authority-mismatch`, drift) are P. So **this spec builds no R-class tap gate.** A future spec that
names a real consumer inherits the rule and must also specify a durable, atomically consumed token store on
the machine that holds the Telegram poll, at most one R tap between two dashboard approvals for the same
point, and a card authored entirely by the server (`OPERATOR-AUTHORIZATION-REQUEST-SPEC.md`
display-integrity rule).

The **per-PR approval floor** is outside the table: a GitHub review by the approver account on the exact head
SHA (`feedback-triage-and-execution.md` §4). The registry requires a rung-1 approval by a verified principal
for policy-sensitive acts, and the self-unblock spec defines rung 1 as "a yes/no the human taps"
(`self-unblock-before-escalating.md` §3); merging code written from untrusted external text is
policy-sensitive. It does **not** require one approval per
pull request or that the approver read the code: per-PR granularity and the review are the triage spec's
choices. That spec also cites Bounded
Blast Radius, which governs physical host resources, not review risk; the miscitation is handed to its owner
(ACT-117). No tap and no PIN substitutes for the review; this spec does not touch it.

### 2. The existing tap approvals (pairing, tunnel consent, remediator)

Pairing approve/finish and the tunnel-consent grant are P by the rule above, yet are tap-approvable today
(G5). They stay as they are **until the PIN stops being posted into Telegram and is rotated (sibling item 2)**,
because until then a tap is no weaker than the PIN (the table above): moving them to the dashboard now would
add a step and no protection. From that point an attacker holding the operator's Telegram account (T3) can no
longer read the PIN but can still tap, so the sibling spec must move every P-class tap to the dashboard **in
the same release** as item 2. This is an exception bound to an event, not a date.

Prompt-gate relay taps answer whatever prompt a session shows — permission prompts, plan approvals, questions,
pickers — with every parsed option as a button. The always-on permission floor (`PermissionPromptAutoResolver`)
answers only registered approval prompts, with the cursor on an approve option, and never the "Yes, and don't
ask again" row; so most prompt-gate answers carry choices the agent would not otherwise make. They are **P by
the rule**, kept for now under the same kind of event-bound exception as pairing: this is pre-existing
behaviour, and narrowing it (at minimum, dropping the always-approve row) is ACT-120; the unset-owner check is
ACT-115. Any session step that needs the operator's authority must use a dashboard route, not a prompt.

The planned burn-alert buttons (G12) classify as: Release and Snooze 24h are P (they lift a safety control
and mute a notice), Extend is S, Investigate changes nothing. Token-burn Phase 5 must be amended before it is
wired (ACT-119).

The planned remediator Telegram countersignature (G10) is P-class and must **not** count as a different
principal. Nothing verifies through it today; the remediator V3 amendment is ACT-116.

**Defect found while grounding (ACT-115, not fixed here):** the tunnel-consent and prompt-gate owner checks
are written `if (owner && from.id !== owner)`, which passes when no owner is configured, and pairing's chat
check is skipped when a chat id is missing. The tunnel-consent prompt itself is not sent without an owner,
so that path is reachable only by a forged callback; the prompt-gate path is reachable from any chat member
when `promptGate.ownerId` is unset. Making both fail closed can break installs that rely on an unset owner,
so the fix needs its own migration check rather than a one-line change here.

### 3. Make each approval cheap (option (c))

**What is already cheap.** Every action-list line that needs the operator already carries a tappable link:
the dashboard tab for PIN approvals and the pull request itself for fix reviews
(`FeedbackExecutorService.actionItems`, `FeedbackTriageService.composeActionList`). Telegram renders those
as links, so the operator is already one tap from each approval.

**What was considered and dropped: inline URL buttons.** Review found they add nothing a tappable link lacks
and add failure modes: the cross-machine relay path (`outboundRelay`) drops a keyboard silently; a refused
keyboard fails the whole send, and the action list is retried and refused again every day; on Echo the list
goes out as an attention item, which carries no keyboard at all. **No buttons are built.**

**The real cost left: re-typing the PIN per action.** Given G11 it guards nothing a token holder cannot reach
another way; it serves as an intent record. The dashboard unlock already issues a separate short-lived
operator-session token (`DashboardOperatorSessionStore`: random, in memory only, 15 minutes, issued only by a
PIN unlock). P-class routes could accept that session in place of a re-typed PIN while still requiring the
plan/commit nonce that binds each act to the plan the operator saw — the session replaces only the typed
secret, not the per-act confirmation. Because this changes the authentication of every PIN route, and the
session token must not become readable through a Bearer route, it belongs to the sibling spec (item 5).

**Pre-existing, not changed here:** with no public tunnel the dashboard link is `http://localhost:…`, which
a phone cannot open (a Mobile-Complete gap owned by the tunnel feature).

### 4. What this build ships, and what the sibling spec must do

**This build: the rule's two carriers.**
1. **Lessons index (docs, in this PR).** The existing entry *L15 (Authorization Policy + Sybil Protection)* in
   `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`, which the lessons-aware reviewer reads, gains a paragraph
   stating the rule in full: the S definition with its exclusions and the undo requirement, the R conditions,
   P as the default, the backtrack-tell, and that the rung-1 "yes/no tap" describes how small the request is,
   not where the approval happens.
2. **A class map with a failing test — split out, not load-bearing here.** The structural carrier (an
   annotated class map of every button-building and dispatch site, with a unit test that fails on an
   unclassified site) is specified in its own small spec, `docs/specs/telegram-callback-class-map.md`, to be
   converged separately. It is **not load-bearing for this build**: this build ships no code for the
   classification rule, and the rule binds through L15 and spec review until that test lands. During twelve
   review rounds the test's mechanics were the only part of this spec still changing (rounds 10–12), which is
   why it is separated. Its runtime decision point (the failing test) is classified there, not here; this
   build has no runtime decision point.

Supersession notes (docs, in this PR): `OPERATOR-AUTHORIZATION-REQUEST-SPEC.md` ("the agent can never approve
its own request") and `a2a-pairing-invite-link.md` (the Bearer token alone never approves) each gain a dated
note pointing here: by G1, G5 and G11 those guarantees hold against the token as a header, not against a
session the token can spawn.

**Not shipped here, deliberately: the agent-instruction honesty change.** Several lines in the agent
instructions tell the agent to give the operator the PIN, and the migrator carries its own copies of them.
Rewording them now would send the operator to a different PIN source than the one the sibling spec will
create. They are rewritten together with the change that stops posting the PIN (sibling item 2), so the
instructions change once and never contradict the system. The honest statement of what the PIN protects is
this spec, and the operator is told through the coordinator.

**The PIN leak (ACT-113, urgent, its own spec).** G3 shows a holder of the API token can read the PIN through
history routes. Given G11 that holder already has full control, so the leak's severity is that the **PIN** —
the dashboard door — is exposed to anyone who reads the agent's history; the fix touches every writer and
reader of that history, and any rewrite of stored history falls under *Archiving May Never Mean Deleting*.
This spec's conclusions do not depend on it.

**Sibling spec `dashboard-pin-structural` (ACT-113's deliverable). It must answer:**
1. Close the history leak (ACT-113).
2. Stop posting the PIN into Telegram from every emitter, including the agent instructions and the migrator's
   copies of them; decide where the operator reads it instead; rotate it **and** the API token (which the old
   PIN could have been exchanged for, G11), ending existing operator sessions — without that, someone who used
   the exposed PIN earlier keeps what it bought; and in the same release rewrite the
   agent instructions to say what the PIN does and does not protect (for Claude, Codex and Gemini agents).
3. Decide whether `POST /dashboard/unlock` should keep handing out the full API token now that an
   operator-session token exists (G11), and whether session-spawning should need a scoped credential distinct
   from the read-level Bearer token.
4. Do **not** treat a hashed PIN as a fix: a generated PIN is six digits (a million values), and a short
   operator-chosen one is little better; a readable hash falls to an offline search quickly.
5. Extend and audit the existing operator-session pattern (G8) so P-class routes accept that token in place of
   a re-typed PIN, keeping the per-act plan/commit nonce (§3) — the operator's actual complaint — and state
   where the token can and cannot be read.
6. Move the P-class secret off the host: a WebAuthn passkey on the operator's device, with user verification
   and the challenge bound to the rendered plan, or GitHub itself as the enforcer (a required review or
   environment approval) — compare the two. It must answer how the first credential is enrolled without the
   readable PIN, how later credentials need an existing passkey, why a software authenticator enrolled by the
   agent is refused, which relying-party domain is stable, and a break-glass path that alerts outside the
   agent's reach and is cancellable. A session minted by the readable PIN must then no longer satisfy a
   P-class route: P-capable sessions come only from the stronger credential, and legacy sessions are
   invalidated at migration.
7. Move every P-class tap to the dashboard in the same release as item 2 (§2): pairing approve/finish,
   tunnel-consent grant, and every authority-bearing prompt-gate answer on Telegram and Slack (permission and
   plan prompts; plain questions and pickers may stay as input), and delete each exception record from the
   class map in that release, with a test that the map holds no exception once the release's flag is on.
8. Consider tamper-evidence for taps on installs with a lifeline: the lifeline records every callback id it
   actually received, so a forwarded callback with no matching record is a detected forgery (cooperative, but
   visible). Installs where the adapter polls Telegram itself need a different design or none.
9. State what it does not achieve: resistance to extraction, not to an agent that rewrites the verifier (G4).

### 5. Rollout

Docs only, in this PR: the L15 paragraph and the two supersession notes. The class-map test ships with its own
spec (`telegram-callback-class-map.md`) after that spec converges.

## Maturation plan

- **test-agent-live:** not applicable — this build is documentation (a lessons-index paragraph and two spec notes); nothing runs on any agent.
- **dev-agent-live:** not applicable — the paragraph is in effect when merged, read by the lessons-aware reviewer on the next spec review.
- **fleet:** not applicable — nothing is installed on agents.
- **graduation criterion:** the next spec that adds a `callback_data` handler is reviewed with the L15 paragraph in the reviewer's input (its review report names it).
- **dark-window:** none — nothing ships dark.

## Tests

None in this build: documentation only. The class-map test and its seeded-failure tests are specified in
`telegram-callback-class-map.md`.

## Approval volume — the options, with their real costs

What the operator carries is bounded by the executor: at most 6 starts a day and 4 open PRs (G7). If every
one of the 298 work items were attempted and produced one PR, that is about 50 days at six reviews a day;
the real figure depends on how many items produce a PR at all (holds, not-reproducible results, spec PRs
that need two reviews), which nobody has measured. New reports keep arriving, so if PR-worthy arrivals exceed
what one person can review a day, the backlog grows without limit.

**The framing that matters.** The operator's words (2026-10-10): "a batched tap on a stream of pull requests
is not real review — you would be signing off diffs you have no time to read." That refuses a **rubber stamp**,
not a decision. So the question is not only how many approvals, but whether each one is a real decision he can
make quickly.

**(a) Move the repository into a GitHub organisation and designate a second trusted human approver.** The
only floor-preserving option that removes the operator as the bottleneck. Costs:
- a second trusted human must exist and be willing — possibly not true today;
- the ownership change is the operator's call alone (package publishing, Actions secrets, links and
  integrations move);
- for an org-owned repository the triage spec sets the approver through the dashboard PIN, which is not a
  boundary against the agent (G1, G3). So (a) is structural only if **GitHub itself** enforces the review and
  the reviewer's GitHub session never sits on an agent machine (G7). Today GitHub requires no review for a
  feedback PR touching `src/`, and no path-scoped rule can target only feedback PRs (head-on answer); the
  organisation move is therefore most useful with a **separate repository for feedback-derived work**, whose
  CODEOWNERS can cover everything.

**(b) Batch N verified fixes into one PR.** Fewer approvals, the same reading in one larger diff — exactly the
"signing off diffs you have no time to read" the operator refused. The rung floor would still be met (a batch
is one approval by a verified principal), so this is a judgment, not a constitutional bar, and the judgment is
against it: a hostile or subtly wrong change hidden among nine good ones is harder to see than one alone, one
bad change blocks or reverts the rest, and the head-SHA pin approves the whole batch at once. **Rejected.**

**(c) Accept the volume and make each approval as cheap as possible** — §3. For pull requests the approval is
already one tap from its review; the remaining saving is the PIN re-entry on dashboard approvals (sibling item
5). Necessary; it does **not** solve volume, and on its own it does nothing to make a review a real decision.

**(d) Make each approval a real ten-second decision: an evidence card built only from verification
artifacts.** Each executor pull request would reach the operator with a card stating what was reported, which
test reproduces it, that trusted code saw the test fail before and pass after, what the diff touches and does
not touch, and — for a small change — the changed lines. The constraint that would make it honest: every line
comes from a verification artifact, never from prose about intent, model-written or otherwise. Review showed
that constraint **cannot be enforced as specified**:
- **The changed lines are prose too.** The sandboxed session writes them, comments and string literals
  included; a comment such as "// harmless: only tightens a check" is exactly prose about intent, and it would
  sit in the part of the card that reads as verified. Labelling the diff as untrusted makes it honest, but then
  the card's central claim — that reading these lines *is* the review — rests on untrusted text.
- **"Reproduced" overclaims.** The base-run verdict (`classifyBaseFailure`) is a pattern match over output the
  session's own test prints, so only the non-zero exit is trusted; and nothing ties the session's test to the
  reported bug (the triage spec §4 says as much: the check "proves the test, not that the reported failure
  stopped"). A card saying "the bug is reproduced and fixed" would manufacture exactly the confidence the
  floor exists to prevent.
- **Every fix carries its test file**, which also runs on the host after merge; counting it, most fixes exceed
  a size an operator can judge in ten seconds, so the card would usually say "read it on GitHub" — the link the
  action list already gives.
- Making it safe would also need: binding the card to the verified head commit (a pushed update would
  otherwise leave an old card beside new code), recording the publish gate's real verdict (a held
  secret-shaped change can be published after a PIN approval), escaping against markup, link and bidi-character
  injection on both the Telegram and GitHub renderings, a message-size budget, a separate path for spec-draft
  PRs, and a store schema migration. That is a large surface for a card whose honest content reduces to "a test
  the session wrote fails before and passes after; lint and related tests pass; these files changed".

**Rejected as specified**, as the condition for (d) required: the promise that every line is verified fact and
that reading the card is a ten-second review cannot be kept. What remains possible is smaller and unproven: a
card bound to the verified head commit that lists only measured facts (a session-written test fails before and
passes after; lint and related tests pass; the full file inventory with line counts; the publish gate's actual
verdicts) and shows the diff explicitly as untrusted code — useful or not depending on how long reviews really
take, which cannot be measured until the executor has produced pull requests (it has produced none). Revisit
then. Two further ideas for that revisit: replaying the base-fail/head-pass check as a GitHub-side check on the
pull request head would move the evidence off the agent's host; and the card would need escaping, a size budget
and a spec-draft variant (listed above).

**(e) The agent's own automated reviewer as the default approver.** *Canonical Pipeline Operational
Completeness* prefers autonomous judgment unless a constitution-level requirement demands a human. The
registry's rung floor requires a rung-1 approval "against a VERIFIED principal"; the ladder frames its rungs as
what is asked of a human, and the self-unblock spec defines rung 1 as "a yes/no the human taps" — reading the
principal as necessarily human is this spec's reading of those texts, not words the registry states. An agent reviewer on the agent's own machines is also
not independent of the author (G7). **Rejected.**

**(f) An independent automated reviewer with its own identity off the agent's machines.** A reviewer service
whose GitHub identity and credentials never touch an agent host, enforced by a GitHub ruleset. It answers the
independence objection to (e) without a second human. Whether it satisfies the rung floor turns on whether a
"verified principal" must be human — the registry does not say, so it is the operator's call (and, if he
decides it should count, a registry clarification).

**(g) A standing, scoped operator grant over executor merges.** The rung floor asks for a verified human
approval, not one per merge, so the operator could approve once a bounded envelope ("merge executor fixes that
pass every gate, touch no protected path, at most N a day, for 30 days"). Cost: nobody reads the code, which is
exactly what the triage spec's floor was chosen to guarantee and what the operator refused; and the grant is
P-class, only as strong as the PIN until sibling item 6. Listed for completeness; not recommended.

**Recommendation.** Keep (c) — for pull requests it is already in place (one tap from each review); the PIN
re-entry saving goes to the sibling spec. Do not build (d): its honesty constraint is unenforceable. Name (a) as the standing structural answer if a
second trusted person exists, with its two prerequisites. Measure first how many of the 298 merit a pull
request (the triage lane): the answer may shrink the problem before (a) is needed. Do not build (b), (d), (e) or
(g); (f) is the operator's to weigh.

**Two further levers that keep every floor intact (operator decisions):**
- **Remove operator sessions from agent machines** (`justin-telegram`, `justin-github`, G6/G7). This closes
  the browser path to forged taps and lets the approver-independence gate clear honestly; it does not close
  the lifeline-secret forgery (G5) or the agent rewriting a verifier (G4).
- **Fewer, better work items.** With work precision unmeasured (G9), it is unknown how many of the 298 merit a
  PR.

**The coordinator's read, tested.** "(c)+(d) now, a Telegram button carrying machine-derived evidence; (a) as
the standing structural answer if such a person exists; explicitly not (b)" — (a) and not-(b) confirmed; (c) is
already in place for pull requests; (d) **fails its own condition** (above) and is rejected; and (a) is
structural only with GitHub-side enforcement and no reviewer session on an agent machine.

## Appendix — what option (d) would have shown, and why it is rejected

**Provenance.** The executor has produced no pull request yet (live status: `available: false`, no attempts),
so no real verification record exists. The report title is real (triage queue rank 4,
`cluster-singleinstancelock-trusts-a-recycled-pid-…`); values marked *(illustrative)* are of the right type from
a hypothetical attempt.

```
Fix PR #2231 — needs your review  (illustrative)

Reproduced: the test failed before the change (assertion error) and passes after it.
Lint passes. Related tests pass.
Touches: src/core/SingleInstanceLock.ts (+6 −1)  (illustrative)
Does not touch: build tooling, CI, package files, lockfiles, test-runner config, .claude/;
no secret-shaped content (checked by the publish gate).

The change:  (illustrative)
  -    if (this.pidAlive(holder.pid)) return { held: true };
  +    if (this.pidAlive(holder.pid)) {
  +      const startedAt = readPidStartedAt(holder.pid, this.pidAlive);
  +      // A recycled pid started after the lock was written: not our server.
  +      if (startedAt !== null && startedAt > holder.acquiredAt) return { held: false, stale: 'pid-recycled' };
  +      return { held: true };
  +    }

── Unverified text, shown as written ──
Reported as (the reporter's words): "SingleInstanceLock trusts a recycled pid: dead server pid
  reused by macOS (Reminders widget) blocked all restarts for hours"
Test (named by the sandboxed session): tests/unit/single-instance-lock-recycled-pid.test.ts —
  "treats a live pid that started after the lock was written as stale"  (illustrative)

Review and approve: https://github.com/JKHeadley/instar/pull/2231/files  (illustrative)
```

Where it fails, line by line:
- "Reproduced … (assertion error)": the assertion part is a pattern match over text the session's own test
  prints; and the test is the session's choice, so "reproduced" means "a test the session wrote fails then
  passes", not "the reported bug".
- The comment `// A recycled pid … not our server.` is prose about intent, written by the session, sitting in
  the part of the card that reads as verified.
- "Touches: one file (+6 −1)" leaves out the new test file, which every fix carries and which runs on the host
  after merge; counted honestly the change is several times longer than shown.
- "no secret-shaped content" would be false for a change set published after a PIN override of the secret
  check.

An honest version of this card says: "a test the session wrote fails before and passes after; lint and related
tests pass; these N files changed (M lines) — read them on GitHub". The action list already gives the link,
and the PR body already names the test.

## Decision points touched

*(none)*

## Verify the State, Not Its Symbol

This build adds no detector, metric or gate. The spec's factual claims are measured in Ground truth, each with
the query that could have returned the opposite; the GitHub ruleset facts in the head-on answer were measured
by the coordinator on the live repository on 2026-10-19.

## Self-Heal Before Notify (Standard B)

No new monitor or notice source.

## Multi-machine posture

- **L15 paragraph and spec notes:** repository files; no runtime state.

## Frontloaded Decisions

1. **Venue answer:** today a tap is no weaker than the PIN; once the PIN's secret is off the host, a tap can
   never match it; a tap never authorises an act a forged tap could abuse.
2. **Unclassified approval points are P;** S excludes turning off controls and suppressing notices.
3. **No R-class consumer exists; no R tap gate and no class table are built.** Spend-brake auto-resume is
   ACT-118.
4. **Pairing and tunnel-consent taps stay until the sibling spec moves them** in the same release that stops
   posting the PIN into Telegram (sibling item 2).
5. **No change to the callback route.** Checking the callback id with Telegram proves a real press, not who
   pressed; the fail-open owner checks are ACT-115.
6. **No inline buttons:** existing tappable links already put each approval one tap away; buttons add
   failure modes and no reach.
7. **PIN re-entry per action** is the real remaining cost; accepting a recent dashboard operator session
   instead is the sibling spec's item 5.
8. **Volume recommendation:** (c) is kept (already in place for pull requests); (d) is rejected because its
   honesty constraint cannot be enforced; (a) stands for the
   operator; (b), (e) and (g) rejected; (f) is the operator's.
9. **The PIN leak is its own urgent spec (ACT-113),** first item of the sibling spec; the sibling also owns
   the broadcast, the passkey, the GitHub-as-enforcer comparison and moving the P-class taps.
10. **Remediator Telegram countersignature is P and not a different principal** (ACT-116).
11. **This build ships** the L15 paragraph and two supersession notes (docs, in this PR). The class-map test is
    split into `telegram-callback-class-map.md`; it is not load-bearing here. The agent-instruction honesty change moves to the sibling spec (item 2)
    so the instructions change once, together with the PIN source.
12. **Public-document discipline:** the route-level detail of the open PIN leak stays in ACT-113 until it is
    fixed.

## Tracked hand-offs

All in this agent's evolution action queue (`GET /evolution/actions`), owner `echo`: ACT-113 PIN readable
with the API token (high, due 2026-10-26); ACT-115 fail-open owner checks (due 2026-10-26); ACT-116
remediator countersignature (due 2026-11-02); ACT-117 triage-spec miscitation (due 2026-11-02); ACT-118
spend-brake auto-resume (due 2026-11-02); ACT-119 burn-alert buttons in token-burn Phase 5 (due 2026-11-02); ACT-120 always-approve row on the
prompt-gate keyboard (due 2026-10-26). The sibling spec `dashboard-pin-structural` is ACT-113's
deliverable.

## Non-blocking operator decisions (handed to the coordinator's ACT-002)

- **The constitutional collision this pipeline sits on.** The rung floor requires a verified principal's
  approval for policy-sensitive acts; *Canonical Pipeline Operational Completeness* (whose "Earned from" names
  this feedback factory) says a manual approval queue "would merely have moved the terminal backlog onto
  operator attention" — which is what about 50 days of reviews is. Does the rung floor govern
  feedback-executor merges, and at what granularity — per pull request (today), a standing scoped grant
  (option (g)), or an independent automated reviewer (option (f))? Only the operator can answer it.
- Whether to move the repository to an organisation with a second approver (option (a)), and whether
  feedback-derived work should live in a separate repository so GitHub can enforce its review without gating
  ordinary work.
- Whether to remove operator Telegram/GitHub sessions from agent machines.

## Open questions

*(none)*
