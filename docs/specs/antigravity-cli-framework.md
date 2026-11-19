---
title: "Antigravity CLI framework and Gemini Enterprise seat provider"
slug: "antigravity-cli-framework"
author: "echo"
eli16-overview: "antigravity-cli-framework.eli16.md"
parent-principle: "Framework-Agnostic — and Framework-Optimizing"
parent-principle-fit: "Adds a sixth execution engine to the framework union so the fleet can use the Gemini model family under a licensed subscription — which Instar's existing Gemini CLI adapter cannot do (Google refuses that client under this seat). It reuses the Grok integration's threading, dark-ship pattern and reviewer reserve/settle budget, and the Gemini CLI adapter's capacity policy, rather than building parallel ones."
lessons-engaged: "P1 (one confinement floor for tool-less lanes, proven by canary; a separate home and deny floor for tool lanes); P3 (§11 migration parity, skill marker-block pattern); P4 (§12 three tiers); P5 (§11 awareness entry); P19 (bounded retries; no retry of tool-capable processes; one lift-prober; no account switching); P20 (§0 evidence table; symbol/state declarations in §3.2, §4.1, §6.3, §6.4; quota unknown stays unknown); P21 (§10 posture; one slot host per project so project state is local, replication deferred to Phase C); Grok round-18 (vendor-policy review first — §1); Grok round-17 (multi-line live proof — L1); Grok round-22 (no internal provider means no outbound gate — §5.4); Grok round-9 (enrolment widening is part of the build — §8.1); extend-don't-duplicate (Grok reviewer budget generalised, §5.2); self-unblock before escalating (§3.3); a dark feature needs a dated owner (Maturation plan); check the topic before asking the operator (FD-7 reuses the outstanding ask). Declined: none."
motivation: "Justin, topic 145625, message 145637, 2026-11-19: 'I would like us to move forward with what the best option is to leverage gemini with a subscription within Instar.' One Gemini Enterprise Standard seat was bought the same day (.instar/state/gemini-enterprise-purchase-2026-11-19.json)."
review-convergence: "2026-11-19T20:38:26.521Z"
review-iterations: 6
review-completed-at: "2026-11-19T20:38:26.521Z"
review-report: "docs/specs/reports/antigravity-cli-framework-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 17
cheap-to-change-tags: 0
contested-then-cleared: 22
approved: true
approved-by: "echo (design lane, Mama PC), 2026-11-19 — converged at the 6-round Tier 2 cap on the 80/20 basis (see report); touches neither the constitution nor a CODEOWNERS path, so agent approval applies. Approval covers PHASE A only; Phase B needs its security addendum converged (§4.2). Operator decisions FD-4/FD-7/FD-8 are runtime asks, not spec approval."
---

# Antigravity CLI framework and Gemini Enterprise seat provider (`antigravity-cli`)

**Author:** echo (design lane, Mama PC). **Date:** 2026-11-19.

## Problem statement

The operator wants Instar to use the Gemini model family through a subscription
rather than per-token billing. On 2026-11-19 one Gemini Enterprise Standard seat was
bought for `justin@sagemindai.io` (project `gen-lang-client-0314128237`, location
`global`, $35/month, month to month), and three facts were established by running
the tools:

1. **Google's Antigravity CLI (`agy` 1.5.12) works under the seat** — tier
   `gcp-ge-standard-tier`, default model Gemini 4 Carbon (Medium); the trivial prompt
   returned `ok` (`.instar/state/gemini-enterprise-purchase-2026-11-19.json`, `cliTest`).
2. **Instar's existing `gemini-cli` adapter cannot serve this seat.** Gemini CLI
   0.69.0 signs in, then every prompt is refused `#3501 ... no valid license` (HTTP 403
   from `onboardUser`, which wants a Code Assist `standard-tier` licence)
   (`.instar/state/gemini-cli-enterprise-test-2026-11-19.json`).
3. **Workspace Business Standard alone grants neither** (Mac Studio record
   `gemini-cli-sagemind-test-2026-11-19.json`).

So a subscription-billed Gemini lane must drive `agy`. This spec adds `antigravity-cli`
as an Instar framework and a subscription-pool provider, modelled on the approved
`grok-build-framework-integration.md`, consistent with
`DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md` (which lists `antigravity-cli` as a candidate
doorway), and extending — not duplicating — `gemini-capacity-policy.md` (§7).

**What the seat actually buys changes what "best option" means.** A Standard seat gives
the project a pooled $10/month of model credit enforced weekly — about **$2.50 of Gemini
use per seat per rolling 7 days**, shared with everyone licensed on the project,
including the owner (§6.1). The seat is therefore a licence + identity + Enterprise-terms
ticket, not capacity ($35 for $10 of credit). The design follows: the seat is the
identity and terms ticket; **the project's own pay-as-you-go overage, under a capped
spend limit, on the same identity**, is the real capacity (§8.3, FD-7); switching
accounts is never a capacity source. The topic session already put this to the operator
(topic 145625, message 145713: "may I turn on pay-as-you-go for extra Gemini use with a
monthly cap of $30?"); FD-7 reuses that ask.

**What this increment delivers (said up front — Grok round 18).** Phase A: framework
identity threading, a canary-proven tool-less one-shot lane, the Gemini-family
cross-model reviewer with a reserve/settle budget, enrolment through the production
route, capacity and error mapping, all on ONE slot-host machine per project (§3.1). Phase B:
headless jobs and interactive sessions on a separate tool home behind their own opt-ins.
Phase C: further identities, gated on the §1 vendor confirmation. §13 is each phase's
acceptance bar.

## 1. Terms and vendor policy (read first; launch-blocking)

Full record with every quote, URL and date:
`.instar/state/antigravity-terms-verdict-2026-11-19.json`. Decisive quotes, re-read
directly on 2026-11-19:

- **Antigravity FAQ** (https://antigravity.google/docs/faq, no page date). Q: "Can I use
  Antigravity CLI headless mode in third-party coding agents or automate account
  switching?" A: "Antigravity CLI headless mode ( agy -p ) is intended for direct
  scripting and CI workflows. Wrapping agy inside third-party coding agents or
  applications, or automating account rotation, **is not supported under consumer
  plans**."
- **Same FAQ**, under "Why can't I use third-party software ... **with my Antigravity
  login**?": "Using third-party software, tools, or services to access Antigravity is a
  violation of our Terms of Service ... To use a third-party coding agent with Gemini, we
  recommend using a Gemini Enterprise or Google AI Studio API key." Additional Terms item
  6's example is "using OpenClaw with Antigravity OAuth" — the ban is on another client
  using the Antigravity *login*.
- **Headless docs** (https://antigravity.google/docs/cli/headless/): "Headless mode uses
  your cached credentials. Authenticate once with an interactive agy session first." —
  Google's own documented headless path runs on the interactive login's cached
  credentials, including in CI. (Round 3: this is why the round-2 detour through ADC is
  reverted, §3.4.)
- **Enterprise docs** (https://antigravity.google/docs/enterprise): Enterprise sessions
  run "under ... the Google Cloud Terms of Service", and "For headless environments and
  automated terminal workflows, Antigravity supports authentication using ... ADC".
- **Gemini Enterprise quotas** (docs.cloud.google.com/gemini/enterprise/docs/quotas-and-pay-as-you-go-usage,
  last updated 2026-11-13): "Usage by an agent acting on a user's behalf counts toward
  the limit of the agent's owner."

**Verdict.** On a licensed Enterprise seat, Instar MAY run Google's own `agy` binary,
headless (on its cached login, as Google documents) and interactively, for the seat
holder's own work. The one express ban on wrapping `agy` names consumer plans.

**Invariants the verdict imposes** (each enforced in code, §3–§8):

- **T1. Only Google's binary touches Google.** Instar never reads, parses, copies or
  replays `agy`'s OAuth token or credential-scope file, and never calls an
  Antigravity/Cloud Code backend itself. It may observe a credential file's existence,
  mode, size, mtime, ctime and inode.
- **T2. No switching.** Which Google identity runs a piece of work is decided by whose
  work it is, never by quota. Instar never moves work to another identity because the
  current one is limited, walled or slow. (Attribution, round 3: this is Echo's design
  rule, not a quoted operator instruction. It rests on the FAQ's rotation clause for
  consumer plans and on Google pooling quota project-wide, so switching would buy nothing;
  Echo explained it to the operator in topic 145625 message 145684 — "Google's terms forbid
  switching between accounts to stretch limits" — and he replied "Sounds good", 145686.) In Phases A–B each agent additionally holds exactly one identity — a
  blast-radius floor, not a reading of the terms (§8.2).
- **T3. No credential leaves its machine.** Each machine signs in itself; config homes
  sit outside every git-synced and backed-up tree (§3.1).
- **T4. Business sign-ins only.** A slot must authenticate as a Google Cloud business
  sign-in with a licensed tier (§3.2); a consumer/Google One sign-in is refused, because
  the FAQ text above applies to it.

**Residual ambiguity and its boundary.** Additional Terms item 6 is not expressly
limited to consumer accounts; its preamble hands Enterprise users to "the terms of use
accepted or signed by your administrator" (Google Cloud ToS). T1 removes the conduct
item 6 describes at any scale. What scale changes is the **blast radius** if Google reads
it differently: every Google identity Instar runs is an account that could be suspended.
So the boundary is drawn on identities, not on volume: Phases A–B run one identity.
**Enrolling a second identity (Phase C) requires ONE of** (round 4, codex): (a) Google's
affirmative written answer to "May an agent framework run the official agy binary for a
licensed user's own work?" (FD-11); or (b) if Google has given no answer 30 days after the
case was filed, the identity holder's informed acceptance on the FD-8 card, which states the
risk. **A refusal from Google blocks both.** (30 days: long enough for a support case to be
answered, short enough not to strand the purchase decision; the agent may extend it with a
logged reason.)

**Sanctioned alternative.** The FAQ's recommended route for third-party agents — an Agent
Platform or AI Studio API key, billed per token — is the doorway registry's
`gemini-direct-api` lane. Not built here; §8.3 names it as the second burst route.

## 0. Evidence base (VERIFIED vs ASSUMED)

| Claim | Status | Source |
|---|---|---|
| `agy` 1.5.12 runs a prompt under the seat (tier `gcp-ge-standard-tier`) | VERIFIED live | purchase record `cliTest` |
| Gemini CLI 0.69.0 refused under the seat (#3501, 403) | VERIFIED live, 4 runs incl. after 10 min | gemini-cli-enterprise-test record |
| Flags `-p`, `--output-format json\|stream-json`, `--input-format stream-json`, `--print-timeout`, `--sandbox`, `--mode`, `--model`, `--effort`, `--conversation`, `--settings`, `--log-file`; subcommands `acp`, `models` | VERIFIED (`agy --help`, isolated HOME) | this session |
| Headless runs use the interactive login's cached credentials | DOCUMENTED | headless docs |
| JSON envelope `{conversation_id,status,response,error?,duration_seconds,num_turns,usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}}`; status ∈ SUCCESS/ERROR/CANCELED/INTERRUPTED/INVALID/WAITING/RUNNING; failure exits non-zero, reason on stderr | DOCUMENTED, NOT yet observed on a real failure | headless docs |
| Unauthenticated headless run exits "authentication required" rather than hanging | DOCUMENTED | headless docs |
| A tool needing approval in headless mode is SOFT-DENIED: run continues, exits 0, stderr notice | DOCUMENTED, text not observed | headless docs |
| What `--sandbox`, `--mode plan` and per-run `permissions.deny` actually block | UNKNOWN — P7 gates Phase A | — |
| `agy models` lists 25 models incl. `gemini-4-argon-*`, `gemini-4-neon-*`, `gemini-4-carbon-*`, `gemini-3.8-flash-*` | VERIFIED | this session |
| An `agy models` run logs `applyAuthResult: email=<identity>, authMethod=gcp, quotaProject=<project>`; the licence tier appears in the sign-in log (`SelectLicense ... Tier: gcp-ge-standard-tier`) and on the interactive banner | VERIFIED (logs 11:14, 11:45; banner in purchase record) | this session |
| On WSL (no keyring) the login is a 0600 file `HOME/.gemini/antigravity-cli/antigravity-oauth-token` plus `HOME/.config/antigravity/credential-user-scope`; HOME override isolates it | VERIFIED | purchase record |
| `agy` reads `HOME/.gemini/config/{config.json,mcp_config.json}` and keeps cross-run state in `HOME/.gemini/antigravity-cli/{brain,annotations,conversations,implicit,builtin}` | VERIFIED (files/dirs present in the test home) | purchase record; security reviewer round 2 |
| macOS: login goes to Keychain; whether HOME isolates it | ASSUMED NOT; probe P2 | authenticate docs |
| `/usage` under Enterprise shows no numbers | VERIFIED | purchase record |
| Seat allowance: pooled $10/month Standard credit, enforced weekly (monthly/4 × seats), shared, no rollover, reset 7 days after the window's first prompt by anyone | DOCUMENTED | pricing + quotas pages |
| A project monthly spend limit exists ("To control costs, you can set a monthly spend limit for your project"); whether it hard-stops or only alerts, and its scope | DOCUMENTED / UNKNOWN (P5) | ai-developer-tools-settings |
| Pool-exhaustion text/exit; concurrent `agy` processes on one HOME; behaviour after licence removal | UNKNOWN — fixture / P8 / P9 | — |
| Binary references env names `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `AGY_ADC_AUTH`, `AGY_BUSINESS_PAYGO_TIER`, `AGY_LLM_GATEWAY_URL`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_ENTERPRISE`, `GOOGLE_CLOUD_PROJECT`, `XDG_CONFIG_HOME` | VERIFIED (strings); semantics of undocumented ones UNKNOWN | this session |

## Proposed design

`antigravity-cli` is a sixth framework: a provider adapter over a pinned private copy of
`agy`, registered only on opt-in, with an admission policy enforcing T1–T4 (§3), a
canary-proven tool-less lane and (Phase B) tool lanes on a separately signed-in tool home
(§4), honest quota-unknown handling plus a reserve/settle reviewer budget (§5.2, §6), a
shared CLI capacity-policy factory (§7), and enrolment that holds one identity per agent
and never switches (§8). It ships dark (§9).

## 2. Framework identity

- **Id** `antigravity-cli`; **display** "Antigravity CLI"; **aliases** `antigravity`,
  `agy`, `gemini enterprise`. Bare "gemini" stays an alias of `gemini-cli`.
- **Provider kind** `google` (already in `SUBSCRIPTION_PROVIDERS`). Because `google`
  already maps to `gemini-cli` in `DEFAULT_ENROLL_LOGIN_COMMANDS`, the login command and
  flow kind are resolved by **framework**, not provider (§3.3).
- **Threading.** Adding the id to `IntelligenceFramework`
  (`src/core/intelligenceProviderFactory.ts:49`) forces the compiler-exhaustive Records
  (`FRAMEWORK_DISPLAY_NAMES`, `BUILDERS`, `HEADLESS_BUILDERS`,
  `FRAMEWORK_INJECTION_PROCESS_NAMES`, `PROCESS_SIGNALS`, `ACTIVITY_SIGNALS`,
  `FRAMEWORK_RENDERERS`, `KNOWN_MODEL_IDS`, `SWAP_CAPABILITY` = `launch-time-only` —
  MODEL swap, unrelated to account swap). The hand-written lists are those the Grok map
  named — including `SUPPORTED_FRAMEWORKS` and its derived lists,
  `SUBSCRIPTION_FRAMEWORKS`, `UsageFramework` **and `normalizeFramework` in
  `UsageLedger.ts`** (which would otherwise map the id to `'api'`), `Config.ts`,
  `types.ts` unions, CLI unions, `route.ts`, `AgentMdJobLoader`, `FrameworkSessionStore`,
  `OriginHarness`, `QuotaTracker`, `SessionReaper`, `ResumeValidator`,
  `PreCompactionFlush`, `PendingLoginStore`, `FrameworkLoginDriver`, `EnrollmentWizard`,
  `IdentityRenderer`, `SessionManager` env maps, `internalFrameworkDefault`,
  `PermissionPromptAutoResolver`, `bootRegistration`, `crossModelReviewer`, and
  `PostUpdateMigrator.getEnabledFrameworks` (return type and runtime filter). The
  `framework-list-drift`, `framework-agnosticism`, `framework-resolver-drift`,
  `framework-id-ratchet` tests and `lint-framework-list-completeness.mjs` are the
  carrier; **the builder runs them first, as a census, on a branch that only adds the
  union member.**
- **Binary: pinned private copy.** Instar-managed slots run
  `~/.instar/accounts/<agent>/antigravity-cli-bin/agy-<version>`, copied at enrolment
  from the installer output — never the PATH `agy`, so neither `agy update` nor the
  owner's own upgrades change it. Each probe reads the copy's `--version`; a mismatch
  with `PROBED_AGY_VERSION` (e.g. the copy turns out to be a launcher that runs another
  version) is `antigravity-parser-drift`. Upgrading is a deliberate step (§3.2 step 5);
  the current version and one rollback version are kept (§3.1). Resolution
  goes through `resolveFrameworkBinaryPath()`, never `claudePath`.
- **Process signal:** exact basename on argv[0] (`/(^|\/)agy(-[0-9.]+)?$/`), never a
  substring; the reaper's tmux-ownership gate still decides any kill.

## 3. Authentication

### 3.1 What is held, where

An **account slot** = one Google identity, on one machine, for one agent. A slot has one
or two **homes**, each its own `agy` sign-in for the SAME identity:

- **tool-less home** (Phase A): `~/.instar/accounts/<agent>/antigravity-cli-<n>/toolless`
  — used only by the canary-proven tool-less lane (one-shot, reviewer, A2A).
- **tool home** (Phase B): `~/.instar/accounts/<agent>/antigravity-cli-<n>/tools` — used
  only by headless jobs and interactive sessions.

Why two sign-ins for one identity: `agy` keeps cross-run memory (`brain/`, `annotations/`,
`conversations/`, `implicit/`) inside its home; if tool lanes and the reviewer shared a
home, content a job read could be fed back into a later review. Two sign-ins for the same
identity on the same machine is not switching (T2). Both live under the existing per-agent
sign-in folder convention (`src/install/accountEnroll.ts`), OUTSIDE the agent's stateDir,
so git sync and backups never see them (T3); a unit test asserts this. Each home is 0700;
`agy` runs with `HOME=<that home>`. The pool stores paths, never tokens.

**One slot host per project in Phases A–B (round 4 scope cut).** Every antigravity slot on
a given `cloudProject` — across all agents — lives on ONE machine, the **slot host**. This
is what lets the wall, the reviewer budget, the lift probe and the overage record be plain
local state in this increment instead of replicated state (rounds 2–3 found every
replicated version of them unsound: unfenced prober elections, cross-clock merges, hosts
that move with the lease, claims that do not survive failover). It is enforced at
enrolment (§8.2) and re-checked daily. Other machines report the framework unavailable
(`antigravity-not-slot-host`) with the normal fallback disclosure. Phase A's slot host is
the Mama PC (the Studio is refused until P2 anyway). Replicating project state so a second
machine can hold slots is Phase C's own spec.

**Run archive (rounds 2–4: security N2, adversarial R6, conformance, lessons F1).** Each
tool-less run holds the home's lock (below) from BEFORE the run to AFTER its final cleanup.
Under it, Instar moves the contents of the tool-less home's `brain/`, `annotations/`,
`conversations/` and `implicit/` (agy state, not credentials — T1 holds; P1 diffs the whole
home tree across a run to confirm the full set) into
`<stateDir>/state/antigravity-archive/<slotId>/<run-id>/` (0700) both before the run starts
and after it ends, so a run never sees another run's memory, even after a crash mid-run.
The archive is OUTSIDE every slot root and on every tool lane's deny list. **Classification
(the archiving standard's continuity test):** these are telemetry, not agent memory — the
run's output is held durably by its caller (the review result file, the ledger row) and
the archive holds the model's own scratch state. As telemetry they are pruned by age (14
days, an advisory default — two seat windows of evidence for post-incident reading) by the
adapter itself at the start of each run under the home lock, through `SafeFsExecutor`, with
each prune logged. (The earlier
draft named a Disk Steward budget; the Disk Steward's prune categories are closed
(`pruneCategories.ts`) and have no such budget, so the adapter owns this retention.)
`<stateDir>/state/` is git-ignored; the archive path is also added to `BackupManager`'s
exclusions.

**The home lock (rounds 3–4: scalability D1 and N1, codex).** A dedicated long-hold lock per
home — NOT the `withGrokBudgetLock` pattern, which reclaims any lock older than 30 s and
gives up after 2 s. It is an OS advisory lock (`flock`) on `~/.instar/accounts/<agent>/antigravity-cli-<n>/<home>.lock`,
held by **one wrapper process per run** (round 5: scalability, integration): every run is
launched through one bash run-wrapper (`#!/usr/bin/env bash`) that itself takes the lock —
`exec 9>"$lockfile"; flock -w "$deadline" 9` (util-linux; Phase A–B are Linux only, macOS being
refused until P2) — and holds it until the wrapper exits, AFTER its post-run archive. Every
child it spawns, `agy` included, is started with fd 9 closed (`9>&-`), so the lock is held
only by the cleanup supervisor and is never inherited by `agy` or anything it spawns (final
fix-verification read) (round
6, scalability N1, security; applied after the last review round, not re-reviewed). The
wrapper runs the pre-run archive, `agy`, and the post-run archive in its own process group,
and the post-run step kills the whole group after the wrapper has recorded its exit code, so
a helper or backgrounded process cannot outlive the run (a process that leaves the group with
`setsid` is caught by the any-process-with-this-HOME check before the home is reused). Node cannot hold `flock` itself, and the existing
`UnixFlockProvider` (`PhysicalEffectLock.ts`) releases when the server's pipe closes, so it
is NOT used for this long-hold lock. The server and the spec-converge script both launch
runs through the same wrapper and wait asynchronously on its exit (a distinct exit code
means `antigravity-home-busy`). For an interactive session the wrapper IS the tmux pane's
launch command, so the lock lives exactly as long as the pane and survives server restarts. The lock file also records the
supervisor's pid and process start time (Linux `/proc/<pid>/stat`, macOS `ps -o lstart`)
in one shared format read by both the server and the script. Because `flock` is released by
the kernel when its holder dies, a crashed supervisor frees the lock; before using a freed
home the next holder checks for ANY surviving process whose HOME is this home (not only the
pinned binary) (`/proc/<pid>/environ`; on macOS, once admitted, `ps eww` for the same uid, failing
closed to `antigravity-home-busy` when unreadable) and stops it first. A pid alone is never trusted (pid
reuse). Waiting is asynchronous
and polled, never a busy-spin on the server's event loop. Failing to acquire within the
caller's deadline refuses `antigravity-home-busy` and never proceeds without the lock. It
serialises calls on a home until P8 shows concurrent processes are safe (basis: a
token-refresh race could invalidate the refresh token, a forced re-sign-in). An interactive
session holds its tool home for its lifetime; a headless job wanting it waits up to its own
start deadline. Tests: a hold longer than 30 s is never stolen; a waiter cannot enter
between `agy` exiting and the post-run archive finishing; a supervisor crash frees the lock
and the surviving child is stopped before reuse; a server restart in the middle of a
interactive session does not release its lock (tmux owns the pane); a server restart during
a headless or one-shot run ends that run (its process group is killed at boot), releases the
lock, and records an interrupted failure (headless wrappers are not re-adopted in this increment); a tool that backgrounds a
sleeper neither keeps the lock nor survives cleanup. A lock-busy result in the identity oracle
or gap sweep is `unavailable`, never counted toward re-sign-in or disabling.

**macOS.** Keychain is per OS user, not per HOME, so a macOS enrolment is refused
`antigravity-keychain-isolation-unproven` until P2 proves isolation or a forced file store.

**Credential fingerprint.** Instar records `{inode, size, mtime, ctime}` of each credential
file per home (stat only — T1). A change outside an Instar-initiated sign-in invalidates
that home's probe cache before the next spawn.

**Binary retention.** Validated pinned binaries are kept as the current version plus one
rollback version; on each upgrade the adapter prunes anything older through
`SafeFsExecutor`.

### 3.2 Admission policy

In `policy.ts`, mirroring Grok's `assertGrokAuthAllowed`. Steps 1, 2, 6 and 7 run on every
spawn; steps 3–4 run on a cached probe (TTL 1 h, plus invalidation on any auth- or
licence-shaped failure or credential-fingerprint change), so a one-shot does not pay a
second process launch.

1. **Env allowlist (the billing floor).** The child env is exactly PATH, LANG, TERM, TZ,
   TMPDIR and HOME=<the lane's home>. Everything else is dropped — on every lane AND on
   the sign-in pane (round 2, integration N4). Tests also assert by name that each
   billing/auth switch is absent: `GEMINI_API_KEY`, `GOOGLE_API_KEY`,
   `GOOGLE_APPLICATION_CREDENTIALS`, `AGY_ADC_AUTH`, `AGY_LLM_GATEWAY_URL`,
   `AGY_LLM_GATEWAY_MODELS`, `AGY_BUSINESS_PAYGO_TIER`, `GOOGLE_GENAI_USE_VERTEXAI`,
   `GOOGLE_GENAI_USE_ENTERPRISE`, `GOOGLE_API_HTTP`, `GOOGLE_CLOUD_PROJECT`, `CLOUDSDK_*`.
2. **Config files are judged against a closed schema (rounds 1–2: security 2, adversarial
   N7, lessons D1, conformance c).** Before every spawn Instar re-reads the files `agy`
   reads from the home — `.gemini/antigravity-cli/settings.json`,
   `.gemini/config/config.json`, `.gemini/config/mcp_config.json` — and checks them
   against the closed schema, not against a frozen copy. Allowed: `gcp.{project,location}`
   equal to the slot's; `trustedWorkspaces` entries that are the home's own scratch root
   or (tool home) a known session/job cwd; UI keys. Forbidden: `modelProvider`; any
   `auth.type` other than the business OAuth type; any `permissions.allow`; any MCP
   server. A change within the schema is logged and accepted (agy writes its own
   `trustedWorkspaces`). A change outside it, a project/location mismatch, or a file that
   does not parse refuses `antigravity-config-drift` with one Attention item; Instar never
   rewrites the file (the change may be the operator's). **Plugins and skills (round 3,
   security 1):** at enrolment Instar records the file hashes of
   `.gemini/antigravity-cli/builtin/` as shipped by the pinned version; before every spawn
   the tree must match them, and any plugin, skill or sidecar directory outside `builtin/`
   refuses `antigravity-config-drift`. Per-run settings disable plugins and sidecars when
   the CLI offers a switch (P1 checks for `pluginsDisabled`).
3. **Business-auth gate (T4).** Each probe runs `agy models` (read-only; no model call)
   with `--log-file <0700 scratch>/probe.log`, extracts only the `applyAuthResult` line,
   then deletes the log. It requires `authMethod=gcp`, `email=` = the slot identity,
   `quotaProject=` = the slot project. Otherwise `antigravity-consumer-plan-refused` /
   `antigravity-identity-mismatch`. Run once per home (each is its own sign-in).
4. **Licence, re-read daily.** Once per day and on cache invalidation, the probe opens
   `agy` interactively in a private tmux pane under each home, reads the banner line
   `<email> (<tier>) / GCP Project: <project>` (VERIFIED shape), and quits without
   sending a prompt (no spend). The tier must be in the checked-in **observed-tier list**
   (today exactly `gcp-ge-standard-tier`; a tier is added only from a recorded live
   observation of that tier under a known licence, e.g. Plus or PAYG in P6/Phase C). A
   `gcp-` tier not on the list, a missing or an unreadable banner is
   `antigravity-licence-unverified` and the home is not admitted. **Honest scope:** the
   banner is positive-only evidence (it shows a licence was present at the probe) until P9
   shows what a removed licence does. The independent second check is call-time: a licence
   refusal (§7.2) disables the slot at once. If a removed licence instead fell through to
   pay-as-you-go billing, the bound is the Google-side spend limit (§6.4), not this probe.
5. **Version and parser drift.** `PROBED_AGY_VERSION = '1.5.12'`. A new version enters
   only through the deliberate upgrade step: copy the new binary beside the old, run
   probes 3–4, **P1**, the L1 shape and **P7** under it, record the new version's `builtin/`
   hashes, and switch only if all pass. P1's results are stored against the `agy` version they
   were measured on; any version change reverts to the FD-16 fail-closed defaults until P1
   passes again for that version (round 6, adversarial (post-cap fix, round 6; not re-reviewed by a full round — see the convergence report's fix-verification pass)). A log or banner
   line that fails to parse on the pinned version is `antigravity-parser-drift`, which
   NEVER triggers re-sign-in and raises one Attention item (§10). The resolved absolute
   path and version are logged with each probe.
6. **Authority still current (round 5, codex; binding added round 6 (post-cap fix, round 6; not re-reviewed by a full round — see the convergence report's fix-verification pass)).** The FD-4
   approval record (`~/.instar/antigravity-project-state/<cloudProject>.json`, field
   `authority`) is written only from a verified FD-4 card tap. The tap itself is recorded
   wherever the Work Board is served (`WorkBoardService.tap`, owner-only, `by.kind ===
   'person'`); the slot host pulls that tap record ONCE through the existing replicated card
   read, verifies it (person, owner, card id, and a `materialHash` matching the card material
   it reads in the same pull), and writes the snapshot `{cardId, recordId, materialHash,
   identity, cloudProject, slotHostMachineId, scope, expiresAt}` itself — the slot host stays
   the file's single writer (§6.4), and no agent text can produce the record. Every launch AND
   every enrolment checks ONLY that local snapshot — never the board — that the identity,
   project and THIS machine's id equal it, that the lane is in scope and the record unexpired, and that no
   recorded Google answer says this use is not allowed. Otherwise the launch refuses
   `antigravity-authority-expired` / `antigravity-vendor-refused` /
   `antigravity-not-approved-slot-host`. When authority ends, live interactive sessions get one
   in-session notice and end at their next idle point or after 30 minutes, whichever is first
   — at the next turn boundary when Google has refused; headless and one-shot runs simply stop being admitted. A Google answer that
   the CURRENT use is prohibited closes the whole lane, not only Phase C.
7. **Per-run settings.** Each run gets its settings from a 0600 file outside the home
   (`--settings <file>`), built from a closed schema admitting only
   `permissions.allow`/`permissions.deny`. For the tool-less lane `allow` MUST be empty
   (asserted at build time); step 1's billing checks apply to it too.

### 3.3 Signing in (agent first, operator only for physical steps)

**Per machine, per home (T3).** Each machine mints each home's login itself; a token is
never copied; `antigravity-cli` is not added to Account Follow-Me's sealed-transport
allowlist.

**What gets built — new machinery, not a command row:**
- `enrollmentIsolationEnv` gains an `antigravity-cli` arm that returns the full §3.2 step
  1 allowlist env with `HOME=<home>`, and the login-pane call site (`server.ts`, where it
  builds `env ${prefix} ${baseCmd}`) runs this framework under `env -i` so the tmux server's
  environment is not inherited (round 3, integration N4). The §12 test inspects the live
  pane's environment.
- `enrollmentCredentialPath` returns the token-file path; sign-in completion requires that
  file to be NEW (its fingerprint changed during this sign-in) AND a fresh §3.2 step 3–4
  probe to pass for the enrolled identity and project — a stale 0600 file from a failed
  login never counts (round 4 conformance).
- A **menu driver** walks `agy`'s first-run screens by their verified prompt texts
  (recorded in the purchase record): "Use a Google Cloud project" → "Continue with Google
  Cloud" → capture the OAuth URL → the identity's browser completes the account chooser
  and consent → capture the callback code → paste through a named tmux buffer deleted
  immediately, then clear the pane's scrollback → billing model "Subscriptions" → the
  licence whose `Project:` and `Location:` match the enrolment → terms → workspace trust.
- The login command and flow kind are keyed by framework (`google/gemini-cli` vs
  `google/antigravity-cli` cannot be confused).

**Who signs in, and the consent.** Phase A's identity is `justin@sagemindai.io`, the only
licensed seat (FD-4). The agent completes the account chooser in that identity's normal
(non-CDP) Chrome profile with the vault password. The terms screen is covered by the
standing terms grant. **The OAuth consent screen is not** — it grants the "Google
Antigravity" app (`cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`,
`experimentsandconfigs`, `openid`, as recorded) on the identity, a permission grant that
is the operator's call. That grant was made during the purchase run (disclosed to the
operator in message 145705: "Antigravity now has access to the Sagemind account"). Before
acting on any consent screen, the driver checks deterministically that the OAuth
`client_id` in the captured URL (not the app's display name), the identity and the scope
list equal the recorded grant; anything else stops and goes to the
operator, never to the classifier. FD-4 asks the operator to confirm that exact grant
once, together with the scope of use it covers — the tool-less lanes in Phase A AND the
Phase B tool sessions that can edit files and run approved commands (round 3, lessons F3) —
and the residual terms risk (round 4, lessons N2);
re-minting it for the second home is the same app, identity and scopes and needs no new ask. A new identity's consent is part of FD-8.

**Self-unblock ladder before any operator ask.** An unrecognised screen: (1) capture its
text; (2) an LLM classifier maps it onto the enumerated verified intents — never onto a
consent screen, whose check above is deterministic; (3) one fresh-pane retry; (4) the
`subscription-signin` procedure. Only a physical or personal step (2-step code, CAPTCHA,
passkey) reaches the operator, as a one-tap link through Needs-you, with the code
returning through the existing code-paste-back route.

### 3.4 ADC is not used

Round 2 routed headless lanes through ADC on the reading that it was Google's documented
headless path. Three reviewers showed it created a general-purpose `cloud-platform`
refresh token in the standard location every Google library finds (readable by any job
subprocess), a second identity to verify, and an ADC "quota project" error family that
would match the pool-wall classifier. Google's headless docs document headless runs on the
interactive login's cached credentials (§1), so ADC is unnecessary. **Decided: OAuth
business sign-in only, on every lane; `AGY_ADC_AUTH` is always stripped.**

### 3.5 Expiry, re-sign-in and the deadlock check

An unauthenticated failure maps to `AntigravitySessionExpired`: terminal for the call,
never retried, and sets slot status to the existing enum value **`needs-reauth`** with the
expired home recorded as the reason, which drives the existing relogin flow (one attempt
per backoff) for THAT home. `antigravity-parser-drift` and `antigravity-config-drift` set
**`disabled`** with a recorded reason (`disabledReason`, §8.1) and NEVER drive relogin. A
licence refusal sets `disabled` / `licence-missing`; the next successful licence probe
clears it **only when `disabledReason` is `licence-missing`** — a disable set for any
other reason, including by hand, is never auto-cleared.

**Re-sign-in takes the home lock (round 6, integration (post-cap fix, round 6; not re-reviewed by a full round — see the convergence report's fix-verification pass)).** The sign-in pane runs
under the same `flock -o` wrapper as every run, so it never writes a token file while a run on
that home is refreshing the same token. A home needing re-sign-in cannot make progress
anyway, so an interactive session holding it is told why and ended at its next idle point or
after 5 minutes, then the relogin runs; nothing on the run path can block the repair
(deadlock check below).

**Deadlock check (Grok's class).** Re-sign-in runs through the menu driver in its own pane,
not through any §4 lane, so admission steps 2–5 and 7 cannot block the action that repairs them.

## 4. Transports

### 4.1 One-shot completion (internal calls, reviewer, A2A) — tool-less

`agy -p --input-format stream-json --output-format stream-json --print-timeout <T> --mode plan --sandbox --model <slug> --settings <per-run deny-all file>`, HOME = the tool-less home.

- Prompt on stdin, never argv; the final result event is the envelope (P1 confirms the
  pairing). Cwd is a fresh 0700 scratch dir swept after the run, orphans swept at boot.
  One-shot conversations are moved to the run archive (§3.1).
- **Confinement is proven by canary, not by model manners. P7 gates Phase A.** It plants:
  a token file outside the cwd, **a token file inside the tool-less home next to the
  credential paths**, a local HTTP listener counting hits, a shell command that would
  create a marker, and a write target. It runs the exact production command line with a
  prompt instructing the model to use each. Pass: no token in any output, zero listener
  hits, no marker, no written file, and the event stream shows each tool call attempted
  and denied, and no new listening socket appears during the run (plugins can start
  sidecars). A **positive control** runs the same prompt with an allow-grant in a
  throwaway home and must trip each canary, proving the probe can detect a breach. If
  `--sandbox` needs an absent container runtime or is a silent no-op, the lane does not
  open (`antigravity-confinement-unproven`). P7 re-runs at every binary upgrade. Reviewer
  output is quoted as untrusted data (Grok round 3).
- **Envelope parse** tolerates raw newlines inside strings (tested on a 100+ line
  reviewer-shaped response). Whether `total_tokens` includes thinking tokens is settled by
  P1 before the sum canary is written; the canary is a signal and never decides a result.
- **Result authority.** Floor: a status other than `SUCCESS` is never success. A
  recognised soft-deny notice attaches `softDenied[]`; any other stderr on exit 0
  attaches `unclassifiedStderr`. Neither decides `ok` — the caller's own output check does
  (the reviewer's verdict parse; a job's declared required outcome).
- **Retry and fallback** apply only to this lane, because P7 proves no side effect is
  possible here.
- **Timeout:** `--print-timeout` from the caller's deadline; Instar's kill timer backs it
  at +30 s so the CLI's clean INTERRUPTED path runs first; hard kill
  `control/agyHardKill.ts`.

### 4.2 Tool lanes (Phase B) — tool home

- **Headless jobs:** prompt from a 0600 file on stdin, `--output-format stream-json`, the
  job's real cwd, `--sandbox`, `--mode auto`, HOME = the tool home. Grants come only from
  the job definition's declared `permissions.allow`, written into the per-run settings
  file, and **only from a checked-in allowlist of fixed command forms** (round 5,
  security): a grant must equal an allowlisted form exactly, never a command family whose
  arguments the model chooses — and a form that runs code the model can write (a test runner,
  a script runner) is admitted only under the Phase B security gate's requirements below, because `npm`, `npx`, `pnpm`, `make`, `git`, `find -exec`, test
  runners and the like can run code the model writes. **Refused at job load:** any generic shell or interpreter grant (`command(bash)`,
  `sh`, `zsh`, `python*`, `node`, `perl`, `ruby`, `deno`, `bun`, `env`, `xargs`, or a regex
  grant matching any of them) — a command-name deny floor is bypassable through an
  interpreter, so interpreters are not grantable at all. **Applied after the grants:** a
  checked-in deny floor (network-egress tools; paths outside the job cwd; writes to
  `.git/hooks/`, `.git/config` or any `core.hooksPath` target in the cwd (a planted hook would
  run outside the sandbox on the next git command); invoking `agy`,
  `gcloud`, `instar`, `git push`, `curl`, `wget`; the tool home itself). Widening either
  list is a spec change. A cwd that is an instar source checkout is refused
  (`antigravity-headless-source-tree`, Grok's fail-closed detector). The job reports its
  declared required outcome; a soft-denied required action is a named partial failure.
- **Workspace config in the cwd (round 3, security 2).** Tool lanes run in a real cwd,
  where `agy` may read workspace-level settings, MCP, plugin or skill files. P1 enumerates
  exactly which workspace paths `agy` reads; at spawn those paths are checked under the same
  closed schema as the home files, or the run refuses `antigravity-workspace-config-refused`.
  Those workspace config paths are also on the WRITE deny floor of both tool lanes, so a
  session cannot write its own config (round 4, security N1); P1 records whether `agy`
  reloads workspace config mid-run, and the Phase B canary includes "write a workspace MCP
  file — must be denied". (Tool-less runs are unaffected: their cwd is a fresh scratch dir.)
- **Interactive tmux sessions:** `agy --mode accept-edits`, HOME = the tool home, with the
  **same per-run `--settings` deny floor and interpreter refusal as headless jobs** (round 3,
  security 3), plus the tool home, the run archive and the reviewer store on the deny list.
  `PermissionPromptAutoResolver`'s antigravity arm is an ALLOWLIST (round 4, security N2):
  it approves only a prompt for an action the run's per-run settings already allow, always
  with the once-only option (never a session-wide or "always" choice — the Grok lesson), and
  refuses everything else. It ships off until a live `agy` prompt has been characterised,
  as the Codex and Gemini arms did. A session that needs broader rights is the operator's
  call, not the resolver's. Git
  identity for tools inside `agy` comes from `.gitconfig` and `.config/git` **copied** into
  a per-session overlay at spawn (the host files cannot be modified; copies deleted at
  session end). `.config/gh` is not provided. The tool home is never inside a session's
  writable workspace. Two keys: `enabledFrameworks` contains `antigravity-cli` AND
  `sessions.antigravityInteractiveSessions: true`.
- **Phase B tool-lane canary (round 2, security N1).** Phase B acceptance runs a P7-style
  canary in BOTH tool lanes (headless and interactive) with the broadest grant set a job may declare: a token file in
  the tool home and one outside the cwd must not appear in output, and the egress listener
  must see zero hits.
- **No retry or replay of a tool-capable process.** A tool can complete an edit before its
  event reaches Instar, so "no tool event seen" is not evidence that nothing happened. Once
  a tool-capable `agy` process has started, Instar never retries it — not the short-hint
  retry, not framework re-placement. Any failure is reported, with the `conversation_id`
  and the events seen; re-running is the caller's explicit decision.
- **A2A ingress:** peer messages reaching an antigravity session run in the §4.1 tool-less
  lane, never a tool lane; a peer message never reaches `--settings` grants. Both sides
  tested.
- **Resume:** `--conversation <id>` (tool home only — the tool-less home is scrubbed).
  **ACP** (`agy acp`) is a candidate transport for a later spec.

**Phase B security gate (round 6, post-cap).** Phase B — both tool lanes — is specified here
as design intent and **may not be built until a Phase B security addendum passes its own
spec-converge round**. Its entry requirements are the round-6 security findings: (1) breakout
through an allowlisted fixed form — a test runner or script runner runs code the model
writes, outside `agy`'s permission layer, so either a form is admitted only if it runs nothing
the run can write, or each admitted form gets its own canary (write a script, run it through
the form, and it must not read the tool-home token, reach the listener or write `.git/hooks`);
(2) whether `--sandbox` confines child processes (measured, not assumed); (3) path deny rules
enforced after symlink resolution; (4) the fixed-form allowlist binding interactive sessions'
grants too; (5) every descendant of a granted command inherits OS-enforced filesystem and
network restrictions, proven by a fixture whose own test code attempts the prohibited
operations through the production grant, in both tool lanes (round 6, codex); (6) message injection into interactive antigravity panes is decided by whether an `agy`
process runs under `pane_pid`. (Liveness by `pane_pid` rather than `pane_current_command` —
which reads `flock` under the wrapper, observed live in round 6 — applies to EVERY
antigravity pane from Phase A, including the banner-probe and sign-in panes; it is part of
the Phase A build, not this gate.) Phase A (tool-less lanes only) is unaffected.

### 4.3 Lane matrix

| Lane | Phase | Home | Opt-in keys | Confinement | Automatic retry / re-placement |
|---|---|---|---|---|---|
| One-shot internal | A; excluded from default routing (§5.1) | tool-less | `enabledFrameworks` | P7-proven, memory scrubbed | yes |
| Cross-model reviewer | A | tool-less | `enabledFrameworks` + detection + budget (§5.2) | same | retry yes; **re-placement never** — a walled pool reports the family `unavailable` |
| A2A ingress | B | tool-less | headless keys | same | yes |
| Headless jobs | B | tool | `enabledFrameworks` + `sessions.antigravityHeadlessJobs` | sandbox + auto + declared grants (no interpreters) + deny floor | **never** |
| Interactive tmux | B | tool | `enabledFrameworks` + `sessions.antigravityInteractiveSessions` + FD-4 approval | accept-edits + the job deny floor and interpreter refusal; allowlist auto-resolver; copied git config | n/a |

## 5. Routing and integration

### 5.1 Internal routing

Not in `INTERNAL_FRAMEWORK_PREFERENCE` or `LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE`
(marked `framework-list-subset-ok` with this reason): about $2.50 per seat per week,
shared with the owner, is plausibly exhausted quickly by high-cadence sentinel traffic — a
hypothesis the §6.3 ledger will measure. A named component can still be routed there
(`sessions.componentFrameworks`); whether to is the agent's judgment, informed by the
estimate.

### 5.2 Cross-model reviewer: the Gemini family returns, on a reserve/settle budget

Gemini CLI is dead under this seat, so the Gemini family is `unavailable` on this agent
today. The build adds:

- `antigravity-cli` in `SUPPORTED_REVIEWER_FRAMEWORKS` and `TRUSTED_REVIEWER_FRAMEWORKS`.
- **A family key** on each registry entry and detection that deduplicates by family: with
  `gemini-cli` and `antigravity-cli` both available, ONE Gemini pass runs (prefer
  `antigravity-cli`). The result books `crossFamily: true` with the family of the framework
  that **actually ran**; the reviewer lane never takes framework fallback. (A spec authored
  by a Gemini session reviewed by this family would not be cross-family; Instar specs are
  authored by Claude sessions, and the detector already compares against the authoring
  session's framework.)
- **Passes run only on the slot host.** On any other machine the family reports
  `unavailable: not-slot-host`. There is no remote reviewer pass in this increment
  (round 3, integration D3: no existing route runs `cross-model-review.mjs` remotely and
  returns a `ReviewerResult`). The script learns slot-host status from the local server; with
  no server it reports `unavailable`.
- **The budget extends Grok's store, reshaped (round 2 scalability F1; round 3 scalability
  D2/D3, adversarial R3, lessons P3).** Reviewer passes run in the spec-converge script's own
  process, which never writes `UsageLedger`, so the budget cannot be ledger-based. Grok's
  reserve/settle store (`withGrokBudgetLock`, `reserveGrokBudgetSlot`, settle-by-reservation-id
  in `crossModelReviewer.ts`) is generalised into a per-family store with these differences
  for antigravity:
  - **Path and scope:** `~/.instar/antigravity-reviewer-budget/<cloudProject>.json`, per OS
    user (like Grok's store) — so several agents on one identity share one share, not one
    each.
  - **Slot-host replacement:** a new slot host on the project admits no reviewer pass until
    seven days after the previous host's last recorded pass, unless the previous host's store
    file is recovered intact (final fix-verification read). Its first pass then starts from a
    full window it can prove.
  - **Shape:** each reservation carries `{id, estUsd, expiresAtMs}`; each settled entry
    carries `{ts, usd, tokens, model}`. Settled spend is the sum of entries in the **last 7
    days** (rolling, matching Google's rolling window — never a calendar or UTC-day reset);
    entries are kept at least 8 days (not capped at a count).
  - **Reservation TTL and crashed passes (round 5, codex):** the reviewer timeout plus 5
    minutes. Each reservation records `attemptStartedAt` when the `agy` process starts. A
    reservation that expires without settling is NEVER dropped: it converts to a settled
    entry at its reserved estimate (`{ts, usd: estUsd, provisional: true}`) for the 7-day
    window, replaced only by a LARGER figure or by a usage figure from Google, matched by
    reservation id. **Every attempt reserves, not every pass** (round 6, codex (post-cap fix, round 6; not re-reviewed by a full round — see the convergence report's fix-verification pass)): a
    retry of a tool-less pass is admitted only against the remaining share with its own
    reservation, and an attempt whose usage is unknown is charged provisionally at its
    estimate. So a crash between the CLI finishing and
    settlement can never spend outside the recorded budget.
  - **Admission:** lock (fails closed on an unacquired lock, as Grok's does), re-read, refuse
    `antigravity-reviewer-budget-reserved` if settled spend + live reservations + this pass's
    estimate exceed the share, else write a reservation and release.
  - **First-pass seed:** `bytes ÷ 3` tokens in plus the model's maximum output tokens out,
    priced at the highest rate-table row for the model — replaced by the observed
    tokens-per-byte once a pass has settled, and L3's measured pass seeds it before Phase A
    closes. **Fit, don't deadlock (round 4, lessons N1):** if the strongest model's estimate
    does not fit the remaining share, the reviewer steps down the ladder
    `gemini-4-argon-high` → `gemini-4-neon-medium` → `gemini-3.8-flash-medium` (each only if
    listed by `agy models` and present in the rate table) and runs the strongest that fits,
    recording the model used; it refuses only if none fits. A model with no rate-table row is
    skipped (a rate row for every ladder model is a build item before L3).
  - **Share (round 3, lessons F2):** half of the estimated weekly spendable amount, where
    spendable = the seat allowance (about $2.50 per seat per week) PLUS, when the overage
    record is `approved` and verified, the approved monthly cap prorated weekly (cap × 7 ÷
    30). The other half is
    reserved for the owner's own use — a self-restraint, since the agent cannot see his
    usage. The agent may change the fraction with a logged reason in the spec-converge
    iteration log.
  - A skipped pass reports the family `unavailable: budget-reserved`, never a silent pass.
  The pooled ledger estimate (§6.3) is an additional restraint when readable; its absence
  does not block (the local store is the admission authority).
- **Skill text** (`skills/spec-converge/SKILL.md` lists the trusted families in prose) gains
  `antigravity-cli` and the family-dedupe sentence, shipped by migration (§11).
- Model choice follows the ladder above; each pass records its model and dollar cost (L3).

### 5.3 Doorway registry

The canonical registry gains an `antigravity-cli` row by PR (the scan never writes it —
doorway spec §2.7): `accessMethod: subscription`, probe kind `cli-model-list`,
`metered: false`, `topModels` from `agy models`. The live probe runs inside the existing
prober script against the slot's tool-less home, so the scan job's sanctioned-command
guard needs no new shape.

### 5.4 No internal provider ⇒ no outbound gate (Grok round 22)

`instar init` and `PATCH /config` refuse any `enabledFrameworks` set for which the
internal-provider resolver (`internalFrameworkDefault` plus `buildIntelligenceProvider`'s
exclusions) would produce **no** internal provider — `no-internal-provider-framework`,
naming the reason in plain words. Covers `['antigravity-cli']`,
`['antigravity-cli','grok-build']` and any future combination, because it checks the
resolver, not a list. A channel-less, reviewer-only agent is the counterexample,
deliberately out of scope.

## 6. Quota, budget and accounting

### 6.1 What the seat buys (external constraint)

Documented, not measured: first-party Gemini models draw from "pooled edition seat credits
($10/month Standard, $15/month Plus)", enforced "on a rolling seven-day basis as a shared
pool" (monthly per-user ÷ 4 × licensed seats), no rollover, cycle starting at the window's
first prompt by anyone. Exhaustion stops usage "for all users in that edition until the
pooled quota resets", unless overage is enabled (then billed at Agent Platform rates). One
seat ≈ $2.50 per 7 days, shared with the owner.

### 6.2 Quota visibility: unknown at the CLI

`antigravity-cli` joins `NO_USAGE_SURFACE`: `frameworkHasNoUsageSurface` is true, the pool
refuses a `lastQuota` write, and the dashboard renders **quota unknown**, never a bar.
Placement is framework-scoped (`placeNewSession(nowMs, framework)`), so an antigravity slot
never wins a Claude or Codex draw. The QuotaTracker pool path's `boundedDegradedDecision`
branch for no-usage-surface frameworks gains the id, tested both sides.

### 6.3 The ledger estimate — may restrain, never permit

Server-side runs write their envelope `usage` to `UsageLedger` under framework
`antigravity-cli` (requires the `UsageFramework`/`normalizeFramework` fix, §2).
`GET /subscription-pool/:id/estimate` (plus a dashboard line) prices **all
`antigravity-cli` rows in the agent's pooled ledger** within the current window (no
per-account join: pooled rollups carry no account dimension, and while each agent holds one
identity (§8.2) the framework filter equals this agent's share of the project). It adds the
reviewer store's settled spend (§5.2), which the ledger cannot see. It answers from the
lease holder's pooled view (`?scope=pool`); on a standby whose pool read fails it answers
"this machine only", stated in the response. It always states what it excludes (other
people and agents in the project). With no rate-table row for a model it reads "unknown",
never $0. A test asserts that a pooled one-shot row appears in the estimate.

**Its authority (P20).** Symbol: a sum of our own token counts. State it stands for:
"remaining pool". Corroboration: Google's pooled-usage view — not wired (P5). Because it
can only under-count real pool use, it is used ONLY to restrain spending (as an extra
reviewer restraint; to time the lift probe), never to permit spending, never shown as
"healthy".

### 6.4 The brakes (all local to the slot host in Phases A–B)

- **Two kinds of wall.** A rate-limit shape (429, `RESOURCE_EXHAUSTED`, "rate limit", "too
  many requests", "per minute" — with or without a hint) opens only a short **cooldown** in
  the factory instance (§7) — in-process memory, lost on restart, which costs at most a few
  repeated 429s. Project-credit wording (§7.2 row 8) opens the **pool wall** for the project.
  A wall moves work onto other frameworks' quota, so it is not free; until a confirmed
  exhaustion fixture is checked in (§7.2), row 8 is matched only loosely, and its wall is
  re-probed after 1 h like any other — so a misread clears at the first lift probe.
- **The wall record.** A local, durable file on the slot host, per OS user (round 4,
  adversarial N1, integration R2, codex), `~/.instar/antigravity-project-state/<cloudProject>.json`,
  carrying the wall
  (`{walledAt, reason, resetAt?, backoffStep, nextProbeAt, failedLiftProbes, clearedAt?}`) and
  the overage record (below). Single writer: the one agent enrolled on the project (§8.2),
  under a `flock` on the file. No
  replication, no merge rule, no new journal kind in this increment (round 4 scope cut; §3.1).
  Because only the slot host holds slots on the project, no other machine can spend against
  the wall.
- **Lift probe.** `probeLift()` — the one path that bypasses the wall check — is run by the
  slot host. Timing: Google's stated reset if any; otherwise the earliest of (a) the
  window-start estimate + 7 days (window start = the earliest ledger row of the current
  window — a lower bound on our own use, so the true reset is earlier or equal) and (b) the
  deterministic backoff, 1 h doubling to a 24 h ceiling. A real call that hits the wall can
  only push `nextProbeAt` later. Each new wall after a clear starts a fresh episode at
  `backoffStep: 0`. On a lift the wall is cleared and queued antigravity work is re-admitted
  gradually (one call, then doubling).
- **Lift-probe breaker (round 3 conformance: No Unbounded Loops).** After 14 consecutive days
  of lift probes that each fail with the wall pattern (network errors, a busy home and
  sign-in failures do not count) (two full seat windows — beyond any documented reset), probing stops,
  the lane stays closed, and one Attention item tells the operator in plain words that Gemini
  has been unavailable for two weeks and why. This is the self-heal-exhausted escalation; it
  re-arms when the operator clears it or the agent clears it with a logged reason.
- **Overage — one record per project (rounds 2–4: adversarial N4/R5/N3, integration R4,
  codex).** The record carries `overage: {state: 'off' | 'approved', capUsd?, approvedAt?,
  approval?, verifiedAt, verifiedVia}`. `approved` is written only from an approval **bound to
  the project, the action and the cap**, never from text the agent writes:
  - a **Work Board card tap** (`WorkBoardService.tap`, owner-only, `by.kind === 'person'`)
    whose card material — and so its `materialHash` — names the project, "enable overage" and
    the cap; the cap is taken from the card and the tap is snapshotted as `{cardId, recordId,
    materialHash, capUsd, cloudProject}` so later checks never depend on reading the board; or
  - a **direct reply to the FD-7 ask (message 145713)** from the verified operator uid,
    `forwarded === false` (the `standing-authorization.ts` rule), whose text is one of the
    reply forms that ask offered — "yes, $30 cap" or "yes, $N cap". It is read once from the
    holder's topic history through the existing pool read and snapshotted into the record
    as `{messageId, replyToMessageId, uid, forwarded: false, textHash, capUsd, cloudProject}`
    (one reply approves one project), so later checks never depend on
    a cross-machine read. Any other operator message — however approving — does not count.
- **The gap between checks, disclosed (round 5, codex; round 6 lessons and
  decision-completeness (post-cap fix, round 6; not re-reviewed by a full round — see the convergence report's fix-verification pass)).** Seat-only use is unpaid while overage is OFF. If someone
  with console access turns overage on between scheduled checks, Instar could make paid calls
  until the next check. The FD-4 card ALWAYS states this gap ("if pay-as-you-go is turned on in
  Google's console, Echo may use it for up to a week before its next check"). The agent never
  changes the billing console on its own judgement; no project-wide stop is offered in this
  increment, because a project hard stop can halt other services on the project and its exact
  effect is unknown until P5 (fix-verification pass).
- **Reconciliation.** The billing state is verified **before the first live model call of
  any kind** — P1, P7 and L1 included — by a successful observation that overage is OFF, or
  that approved capped overage matches the record (final fix-verification read: someone can
  turn overage on in the console independently, so a local `off` record alone proves nothing).
  Enrolment against a project where overage is already ON without an approval leaves the lane
  closed. After that, it and then on a schedule: daily where P5 finds an
  API, otherwise weekly through the console in the agent's browser, plus before each
  graduation step. It checks the overage setting, its cap, the spend limit, and the project's
  other spend. Outcomes:
  - recorded `off`, console OFF → expected (seat-only use is not paid).
  - recorded `approved`, console ON at exactly the approved cap, hard stop present, no other
    project spend → expected.
  - **console ON without an approval, ON at any other cap, cap or limit removed, other
    project spend appeared while overage is approved, or the state cannot be verified** → the console is never changed
    by the agent, and the **antigravity lane closes** (`antigravity-billing-unverified`) with
    one Attention item, until the state matches the record again or a new approval exists.
  - **recorded `approved`, console OFF** → a possible revocation: never re-enabled by the
    agent; the lane continues seat-only and the topic session asks.
- **The spend limit.** Before overage is enabled, P5 records from Google's docs and the
  console whether the project monthly spend limit hard-stops or only alerts, its scope
  (project vs billing account), and current spend at both scopes. **Overage is enabled under
  the $30 answer only if P5 shows a project-scoped hard stop settable at the cap AND the
  project's other spend this month is zero** (decision-completeness round 3 N1: a project
  hard stop caps everything on the project, so non-zero other spend would both stop that
  other work and shrink what the $30 buys). Any other arrangement — alert-only, account-wide,
  or other spend present — is a new money decision the topic session asks with the mechanism
  stated plainly. Until then overage stays off.
- **Load-shed:** antigravity work is pass-through at the job brake (as Grok); the ledger, the
  reviewer store and the wall are its budget signals.

## 7. Capacity and error mapping (extend, do not duplicate)

### 7.1 Shared factory

`gemini-cli/observability/geminiCapacityPolicy.ts` becomes
`src/providers/shared/cliCapacityPolicy.ts`, exporting `createCliCapacityPolicy(opts)`;
each call returns an instance with its own state. **The Gemini wrapper holds ONE shared
instance** for both of today's callers (`gemini-cli/transport/oneShotCompletion.ts` and
`GeminiCliIntelligenceProvider.ts`), preserving today's shared module-level state. Options,
all NEW and named: `source`, `knownModels`, `defaultModel`, `extraCapacityTokens`,
`noHintClass: 'retry' | 'local-cooldown'`, `modelFallback: boolean` (when false it disables
BOTH `pickGeminiFallbackModel` and the immediate-retry path's `resolveKnownGeminiFallback`
substitution), and `poolWallClassifier?: (text) => boolean`.

**Gemini parity, traced before extraction (round 2, codex).** The approved
`gemini-capacity-policy.md` requirement 4 says long or unknown windows open a cooldown;
the implementation (`decideGeminiCapacityPolicy`, `retryAfterMs === undefined` branch)
retries once when there is no hint. Before extracting, the builder traces a no-hint failure
through both Gemini entry points, records spawn counts for consecutive calls in
`.instar/state/`, and preserves the OBSERVED behaviour (`noHintClass: 'retry'`) — the
extraction is behaviour-preserving, not a fix. The requirement/implementation mismatch is
filed as its own Gemini follow-up. Proof of parity: the unchanged Gemini CLI tests plus a
recorded-corpus equivalence test.

### 7.2 Antigravity mapping (rows are checked in order; first match wins)

| # | Observed | Class | Action |
|---|---|---|---|
| 1 | "authentication required" / auth-reason error | `AntigravitySessionExpired` | terminal; `needs-reauth` for that home |
| 2 | licence refusal (`no valid license`, `#3501`-shaped, 403 on onboarding) | `AntigravityLicenseMissing` | terminal; `disabled`/`licence-missing`; one Attention item naming identity + project |
| 3 | unknown model (`is not recognized as a known model`) | `AntigravityModelUnknown` | terminal; one refresh of the model list, then fail loud |
| 4 | INVALID / WAITING / RUNNING | `AntigravityRunIncomplete` | `ok:false`, never retried |
| 5 | CANCELED / INTERRUPTED after our kill | timeout | existing mapping |
| 6 | rate-limit wording ("rate limit", "too many requests", "per minute", 429, `RESOURCE_EXHAUSTED`) with a hint ≤ 30 s | rate-limit | the factory's single bounded retry (tool-less lane only) |
| 7 | rate-limit wording with a hint > 30 s or no hint | rate-limit (long/unknown) | local cooldown only |
| 8 | project-credit wording — "credit", or "quota"/"usage" naming the edition, project, pool or subscription — with NO rate-limit wording | pool-exhausted | terminal; **no model fallback**; write the pool wall |
| 9 | exit 0, `status: SUCCESS` | completed | caller's output check decides `ok`; `softDenied[]` / `unclassifiedStderr` attached |
| 10 | anything else non-zero | provider error | existing generic mapping, stderr scrubbed |

**Only failure diagnostics are classified** — stderr and the envelope's `error` field on a
non-SUCCESS run — never the model's `response` text, so a successful review that discusses
credit limits is row 9. Rows 1–3 precede capacity matching so that an auth or licence
message containing "quota" (e.g. `quotaProject`) never reads as capacity.

**Before a confirmed fixture exists**, a row-8 match opens the (local, slot-host) wall and
records the diagnostics as a candidate fixture; the wall is re-probed at 1 h like any other
(§6.4), so a misread clears at the first lift probe, and the one Attention item for the
adapter owner is raised only if that first lift probe also fails (self-heal before notify). A
fixture counts as confirmed only when it is **checked in by PR** to the classifier's fixture
set — never by a runtime write (round 3, adversarial PRECISION). "Rate limit reached" matches row 6/7,
never row 8 (tested with and without a short hint). **Why no model fallback:** the credit
is pooled across all first-party models. **Honesty about the classifier:** the exhaustion
text is UNKNOWN; the first real occurrence is a stall-matrix completion item — its stderr,
envelope and exit are pinned as a fixture, and the session that owns the adapter on the
slot-holding machine confirms it and tunes rows 6–8 against it.

## 8. Subscription pool: enrolment, identity, bursts

### 8.1 Enrolment through the production route

`POST /subscription-pool` requires `isIdentityVerifiableSlot`; the build adds
`google/antigravity-cli` with a real identity oracle in
`CompositeCredentialIdentityOracle`. `resolveSlotTenant(slot)` dispatches by the slot's
**declared framework** for `antigravity-cli` (not by sniffing), and probes the slot's
tool-less home, `<slot root>/toolless/` — `configHome` is the slot root (round 3, codex,
integration). The arm reuses the 1 h cached probe, takes the home lock with a time limit,
and returns `unavailable` (never a mismatch) on timeout, since it also runs inside the boot
email barrier and the gap sweep. The oracle IS §3.2 step 3's `applyAuthResult` email check (returning
`{email}`; the project check stays in admission), shared by the enrolment route, the
admission probe, `SubscriptionReloginRuntime` and the pool gap sweep. The slot record keeps
the existing fields (`provider: 'google'`, `framework`, `configHome` = the slot root,
`status` from the existing enum) plus local, non-secret metadata: `googleIdentity`,
`cloudProject`, `location`, `licenseKind` (`standard-seat`|`plus-seat`|`payg`),
`subscriptionId`, `homes: {toolless, tools?}`, `pinnedBinaryVersion`, `disabledReason?`,
`credentialFingerprints`.

### 8.2 Identity: no switching; one identity and one slot host per project in Phases A–B

- **No switching (T2, invariant).** The reactive swap (`selectAccount`) and
  `ProactiveSwapMonitor` exclude `antigravity-cli` slots as sources and as targets, and
  placement never chooses between two identities on quota grounds. Tested both sides.
- **One agent, one identity, one slot host, per project (rounds 2–4: codex, adversarial
  R4/N1/N2, integration D1/R1/R2; round 6 codex: the slot host is now NAMED on the FD-4 card by
  `machineId` and checked at enrolment and every launch (§3.2 step 6), so a second machine
  cannot become a slot host even under a simultaneous enrolment or a partition (post-cap fix, round 6; not re-reviewed by a full round — see the convergence report's fix-verification pass)).** In Phases A–B a project has exactly one enrolled agent,
  using the single identity the operator approved in FD-4, on one machine (the slot host,
  §3.1). Enrolment checks this deterministically, with no new store:
  - it reads every local agent's pool file (agent registry; metadata only, same OS user)
    and every peer machine's slots through the existing pool read (`?scope=pool`);
  - **fail-closed against the registry, not the answers:** it compares the peers that
    answered with the full registered machine list (`listPoolMachines`, every non-revoked
    machine). A registered machine that did not answer — including one silently dropped for
    having no resolvable URL (`_resolvePeerUrls` filters those out today) — makes enrolment
    refuse `antigravity-identity-check-unreachable` (retry later);
  - it refuses `antigravity-phase-ab-single-agent` if another agent holds a slot on the
    project, `antigravity-phase-ab-single-identity` for a different identity, and
    `antigravity-not-slot-host` if a slot on the project exists on another machine; email
    comparison is case-normalised.
  - **Local race (round 5, codex):** enrolment takes a project-scoped `flock` on
    `~/.instar/antigravity-project-state/<cloudProject>.lock` across the local read and the
    durable slot creation, so two local agents enrolling at once cannot both succeed.
  - **Scope of "every agent", honestly (round 5, adversarial):** enrolment sees this agent's
    machines and same-OS-user local agents. An agent from another mesh on the same project
    is invisible to it and is treated like any other user of the shared pool (the estimate
    restrains; the billing reconciliation closes the lane on mismatch). If the mesh list is
    not yet initialised, enrolment refuses `antigravity-identity-check-unreachable` unless
    multi-machine is not configured at all.
  - A permanently dead slot host is retired through the existing mesh machine-retirement
    flow (only for a machine that is truly gone); until then it blocks moving the slot host,
    which is the intended fail-closed direction.
  - **The residual race and its detector.** Two machines enrolling at the same instant
    could both pass. That needs two deliberate enrolments at once, and both would be the same
    approved identity on the same project (no terms exposure, only Instar-state
    duplication). The daily probe re-runs the same pool-wide read; if two machines hold slots
    on one project, each machine disables only ITS OWN slot when its `enrolledAt` is later
    (ties broken by the larger `machineId`), with one Attention item. If any registered peer
    is unreadable, the detector takes no action and raises nothing (it never disables on
    partial evidence). Deterministic detect-and-resolve; no lock service needed.
- **Several agents on one project: Phase C.** Two agents doing the owner's work under his
  one seat adds no identity, so no blast radius — but it needs shared project state across
  agents, so it waits for Phase C rather than being half-supported here (round 4).
- **Phase C** relaxes the count to one identity per person whose work the agent does, still
  never chosen by quota, and adds replicated project state so a second machine can be a slot
  host — its own spec.
- **Seats and cost, honestly.** A seat is $35/month and adds $10/month of pool credit; the
  design is seat-agnostic (`payg` is a valid `licenseKind`). Whether one project can hold a
  Standard subscription and a PAYG edition together, and the PAYG tier string, are checked
  from Google's docs in P6 (nothing bought); the observed-tier list widens only on a live
  observation.

### 8.3 Bursts

When the pool is walled, burst capacity is (a) **the project's own overage** on the same
identity — no switching — capped by the spend limit and approved through FD-7, or (b) the
`gemini-direct-api` doorway (per-token API key) once that lane exists, not built here. With
overage approved, a pool-exhausted error does not occur; spend continues to the cap — so in
that state the estimate and the reviewer store are the only visibility, and the awareness
entry tells the agent so.

## 9. Rollout: ships dark

The adapter registers only when `enabledFrameworks` contains `antigravity-cli` AND the
pinned binary resolves AND at least one slot is enrolled.

**Surfaces that change for every agent regardless of opt-in** (the list is the count):

- `antigravity-cli` becomes an expressible pin value (an un-opted-in pin resolves to the
  default framework with a notice naming the refusing gate).
- The alias table learns `antigravity` / `agy` / `gemini enterprise`.
- The awareness entry appears in every agent's feature notes.
- The orphan reaper recognises an exact-basename `agy` process (a digest line only).
- The reviewer detection report gains an `antigravity-cli` row (`antigravity-not-enabled`).
- `POST /sessions/spawn` accepts the name and refuses it by name unless opted in.
- **The Gemini capacity policy moves into the shared factory** (behaviour-preserving).
- **The Grok reviewer budget store is generalised to per-family** (Grok's behaviour
  unchanged; its existing tests stay green).
- `loadConfig` binary detection gains an `agy` arm using `existsSync` candidates only.
- **`init` and `PATCH /config` refuse `enabledFrameworks` sets with no internal provider
  (§5.4)** — for every agent; existing configurations are not rewritten and gain a
  one-time Attention item at boot.
- **The job-brake wiring counts only accounts whose framework equals
  `config.sessions.framework` (FD-10)** — an agent with a codex or grok account in a
  single-Claude-account pool moves back to the single-account brake at its next boot. It is
  evaluated at boot (`server.ts` `size() > 1`), so enrolment and unenrolment change the
  brake only after a restart; the enrol response and the awareness entry say so.
- The account-metadata emitter (`setMetaReplicationEmitter`, `server.ts`) gains an explicit
  `framework === 'antigravity-cli'` skip, so an older peer never receives an
  `antigravity-cli` account record (which would stop its batch). Emission is a Phase C step.
- The spec-converge skill text gains the family sentence (§11).

None of these registers the adapter, starts `agy`, or spends anything.

**Graduation and rollback:** registered → reviewer → headless → interactive → second
identity (Phase C), each reversible by its own key. Removing the id from
`enabledFrameworks` does NOT unenrol a slot; unenrolment is its own step, `DELETE
/subscription-pool/:id`, which for `antigravity-cli` slots only also removes the slot's
homes, pinned binary and run archive through `SafeFsExecutor` — but **never the project-state
file**: the FD-4 authority, the wall and the overage approval belong to the project, not the
slot, and survive unenrolment and re-enrolment unchanged, including the approval's original
expiry (round 6, codex (post-cap fix, round 6; not re-reviewed by a full round — see the convergence report's fix-verification pass)); refusing any path that
`isProtectedConfigHome` protects.

## 9a. Stall-coverage matrix (gating requirement)

Onboarding a framework requires a stall-coverage matrix, as for Grok:
`docs/frameworks/antigravity-cli-stall-coverage.md`, and `antigravity-cli` is added to
`REQUIRED_MATRIX_FRAMEWORKS` in `src/data/stall-classes.ts`. Every session-stop class is
listed with its detection, its recovery, and an explicit disposition for any gap. A
provisional matrix gates Phase A; a matrix verified from live state gates Phase B.
Framework-specific classes, at minimum:

- **Login expired mid-run** — detection: row 1 of §7.2 or an "authentication required"
  exit; recovery: `needs-reauth` and the relogin flow for that home; gap to verify in P1:
  whether `agy` silently renews from a stored refresh token (as Grok's CLI did), in which case
  the ordinary case self-heals and only a missing refresh credential reaches the operator.
- **Pool exhausted** — detection: row 8; recovery: wall, lift probe, breaker (§6.4); gap:
  the real text is unknown until the first fixture.
- **Exit 0 with the work not done** — detection: soft-deny notice or `unclassifiedStderr`
  plus the caller's own output check (§4.1); recovery: none automatic for tool lanes.
- **Run hangs** — detection: `--print-timeout` then Instar's kill timer; recovery: hard kill;
  stream-json stall (no event for the timeout window) maps the same way.
- **Home busy** — detection: lock acquisition deadline; recovery: named failure.
- **Licence removed or seat lapsed** — detection: row 2 or the daily banner; recovery:
  `disabled`/`licence-missing`, cleared by the next good probe.
- **Parser or config drift after an upgrade** — detection: §3.2 steps 2 and 5; recovery:
  never relogin; one Attention item.
- **Billing state unverified** — detection: §6.4 reconciliation; recovery: lane closed.

Standing duty carried by the matrix: on every binary upgrade, re-verify P7, the deny lists
and the `builtin/` hashes against the new version.

## 10. Multi-machine posture

- Slot homes (credential files, agy state) and the pinned binary — machine-local.
  machine-local-justification: physical-credential-locality
- Wall record, lift probe and overage record (`~/.instar/antigravity-project-state/<cloudProject>.json`)
  — machine-local on the slot host in Phases A–B. Their locality is inherited from the
  credential, not chosen for convenience: the only machine that can spend against the
  project, probe for a lift, or be refused by the wall is the one whose login holds the slot,
  and enrolment enforces that there is exactly one, fail-closed against the machine registry
  (§8.2). Phase C unifies them. If the slot host is lost, nothing is unrecoverable: the wall
  is re-learned by one refused call and the overage approval is re-read from its snapshot or
  the replicated topic history.
  machine-local-justification: physical-credential-locality
- Reviewer reserve/settle store — machine-local on the slot host, per OS user, for the same
  reason (only the slot host's login can run a pass).
  machine-local-justification: physical-credential-locality
- Slot metadata — unified by read: kept on the slot host and read pool-wide (`?scope=pool`)
  by the §8.2 enrolment check and the daily duplicate detector. Not emitted on the
  account-metadata kind (§6.4 emitter skip), for wire compatibility with older peers.
- Lock files (home locks, the enrolment lock) — machine-local: they guard this machine's
  credential homes and files. machine-local-justification: physical-credential-locality
- Rate-limit cooldown — not durable state: in-process memory, lost on restart, outside the
  posture taxonomy; its loss costs a few repeated 429s.
- Usage rows and the estimate — unified via the existing pull to the lease holder; the
  estimate route proxies to the lease holder and labels a standby fallback.
- Framework availability on other machines — unified by read: they report
  `antigravity-not-slot-host`, and the normal framework fallback and disclosure apply;
  antigravity sessions never travel (FD-17), and the reviewer detection report says where the
  family is available ("available on <slot host>").
- Per-slot Attention items (config drift, parser drift, licence, overage unapproved, lift
  breaker) — raised by the slot host (only it can observe them), condition key
  `antigravity-<cond>:<slotId>:<machineId>`, close-on-cause resolver (the
  `SubscriptionReloginAttention` pattern); Needs-you already aggregates Attention across
  machines.
- Sign-in asks to the operator — through Needs-you, already pool-aware.

Phase A's slot host is the Mama PC; the Studio waits for P2.

## 11. Agent awareness and migration parity

- **Awareness:** one new file `src/data/awareness/antigravity-cli.md` (no template edit, no
  migrator block). It says: what the lane is; that it ships off; that quota is unknown and
  the seat credit is small (about $2.50/week per seat, shared with the owner and any other
  agent on the same identity); that it never switches Google accounts; that Gemini runs on one machine (the slot host) and other machines report it unavailable; that overage, when approved, is visible only
  through the estimate and reviewer store; that enrolment/unenrolment changes the job brake
  only after a restart; that bare "gemini" still means Gemini CLI.
- **Config defaults:** none written; `sessions.antigravityInteractiveSessions` and
  `sessions.antigravityHeadlessJobs` default absent (off) inline.
- **`PostUpdateMigrator.getEnabledFrameworks()`:** type and runtime filter gain the id.
- **Built-in skill content (round 2, integration N1):** a new migration modelled step for
  step on `migrateSpecExperienceReview` — a marker block (`<!-- INSTAR:REVIEWER_FAMILIES -->`)
  sourced from the bundled `skills/spec-converge/SKILL.md`, inserted on existing installs
  immediately after the paragraph that names the trusted reviewer families (the
  "Trusted-provider allowlist" bullet), and patched into the canonical
  `.instar/skills` copy and the `.claude` and `.agents` renderings, honouring body-hash
  stamps, holding on a user-edit conflict, refusing symlinks; idempotent.
- **Hooks:** none changed.
- **Retention owned by the adapter:** the run archive (14-day prune) and pinned binaries
  (current + one) — §3.1 — with their paths added to `BackupManager` exclusions.
- **Live test homes:** the purchase-run test homes under `.instar/state/antigravity-sagemind-test/`
  and `.instar/state/gemini-cli-enterprise-test/` hold live sign-ins under the stateDir
  (git-ignored, 0700). At Phase A start the builder signs the slot in fresh at the §3.1
  path, then deletes both test homes through `SafeFsExecutor` and records it.

## 12. Testing (all three tiers)

**Census first:** the drift, agnosticism and ratchet tests on a branch that only adds the
union member, before any adapter code.

**Unit** (`tests/unit/`):
- `antigravity-policy.test.ts` — env allowlist on lanes and on the sign-in pane (each switch
  by name); config schema (an in-schema `trustedWorkspaces` write accepted; a planted MCP
  server / allow-grant / billing switch / project mismatch / unparseable file refused); a
  non-builtin plugin or skill dir refused; a modified `builtin/` file refused; business-auth
  gate both sides; observed-tier list (`gcp-ge-standard-tier` admitted, an unlisted `gcp-*`
  tier refused); parser-drift never triggers relogin; a credential fingerprint change
  invalidates the cache; **T1**: an `fs` spy proves only `stat` touches the credential paths.
- `antigravity-paths.test.ts` — homes outside git-sync and backup roots; archive outside
  every slot root and excluded from backup; two homes per slot.
- `antigravity-home-lock.test.ts` — a hold longer than 30 s is never stolen; a dead holder
  pid is reclaimed; waiting does not block the event loop; acquisition failure refuses.
- `antigravity-run-archive.test.ts` — a planted `brain/` file is archived, not deleted,
  before the next run; an interrupted run's state is archived before the following run; the
  lock spans pre- and post-run moves; archives older than 14 days are pruned and logged.
- `antigravity-envelope.test.ts`; `antigravity-result-authority.test.ts`.
- `antigravity-error-mapping.test.ts` — every §7.2 row in order; an auth message containing
  `quotaProject` → row 1; "rate limit reached" with and without a hint → rows 6/7, never 8;
  a SUCCESS review whose response discusses "credit limits" → row 9; a runtime-written
  fixture is never treated as confirmed.
- `cli-capacity-policy-factory.test.ts` — instance isolation; Gemini's two callers share one
  instance; each option; `modelFallback:false` blocks both substitution paths; Gemini
  recorded-corpus equivalence.
- `reviewer-budget-per-family.test.ts` — Grok behaviour unchanged; antigravity store is per
  OS user and keyed by project; rolling 7-day sum (an entry 8 days old does not count, one 6
  days old does); entries retained ≥ 8 days; first-pass seed admits; no rate row refuses;
  two simultaneous admissions against the last balance → exactly one; an approved FD-7 cap
  widens the share by cap × 7 ÷ 30 × the fraction; a non-slot-host machine reports
  `unavailable: not-slot-host`.
- `antigravity-identity.test.ts` — a different identity on the same project (same agent,
  other local agent, or a peer) refused; a slot on the project on another machine refused;
  an unreadable peer refuses, including a registered peer with no resolvable URL;
  case-normalised emails; another agent on the same project refused (Phase C); no swap source/target; the daily detector disables the
  later of two slot hosts.
- `antigravity-project-state.test.ts` — lift probe bypasses the wall; a real call only
  extends `nextProbeAt`; a new wall after a clear starts at `backoffStep: 0`; gradual
  re-admission; the 14-day breaker stops probing and raises one Attention item; overage:
  ON without an operator-origin approval closes the lane and never touches the console;
  `approved` with console OFF never re-enables; an approval from the agent's own message, an
  unrelated operator message, or a forwarded message is rejected; a card tap without the
  project and cap in its material is rejected; console ON at a different cap, a removed
  limit, new other project spend, or an unverifiable console each close the lane without
  touching the console.
- `antigravity-authority.test.ts` — an expired or out-of-scope approval refuses a launch with
  an otherwise valid login; a recorded vendor refusal closes the lane; an interactive session
  ends at idle after expiry.
- `antigravity-enrol-race.test.ts` — two local agents enrolling the same project at once:
  exactly one succeeds; locks are always taken enrolment-lock first, then state-lock.
- `antigravity-lock-cleanup.test.ts` — killing `agy` or the server mid-archive with a second
  run already waiting: the waiter does not enter until the wrapper's archive finishes.
- `antigravity-first-call-billing.test.ts` — no live call before a successful OFF (or matching
  approved) observation; a project with overage already ON and no approval stays closed.
- `antigravity-slot-host-binding.test.ts` — a machine whose id is not the card's slot host is
  refused at enrolment and launch even with an empty pool read (simultaneous enrolment,
  partition); an authority record not written by the card handler, or whose `materialHash`
  does not match, is refused.
- `antigravity-unenrol-keeps-project.test.ts` — unenrol and re-enrol with an active wall and a
  card-approved cap: both persist with the original expiry.
- `antigravity-wrapper-shell.test.ts` — the run wrapper is `#!/usr/bin/env bash` and runs
  correctly when invoked from the slot host's real `/bin/sh` (dash on the Mama PC).
- `reviewer-crash-accounting.test.ts` — a crash between CLI exit and settlement charges the
  reserved estimate; real usage arriving later replaces it.
- `no-internal-provider-refused.test.ts`; `antigravity-no-replay.test.ts` (a fake CLI that
  edits a file and exits non-zero BEFORE emitting the event, and one that hits a short-hint
  429 after editing: exactly one edit, no retry, no re-placement);
  `antigravity-job-grants.test.ts` (interpreter grants refused, for jobs and interactive
  sessions); `antigravity-auto-resolver.test.ts` (a prompt touching the tool home, archive or
  an interpreter is never auto-approved); `antigravity-a2a-toolless.test.ts`;
  `antigravity-consent-check.test.ts`; `antigravity-process-signal.test.ts`;
  `antigravity-awareness-matches-behaviour.test.ts`.

**Integration** (`tests/integration/`):
- `antigravity-registration.test.ts` — all three gates; the `antigravity-not-enabled` row;
  a non-slot-host machine registers the framework as unavailable with the named reason.
- `antigravity-fake-binary.test.ts` — the full one-shot path through HTTP with a fake `agy`
  emitting recorded envelopes and stderr, including wall → refusal without spawn → lift.
- `antigravity-enrolment-route.test.ts` — through `POST /subscription-pool` with the exact
  two-level slot layout: the oracle (declared-framework dispatch, `toolless/` home) admits the
  matching identity; consumer sign-in, identity mismatch, macOS and a second slot host refused.
- `antigravity-two-machine.test.ts` — two state dirs as two machines with the real pool read:
  the second machine's enrolment is refused; a forced duplicate is detected and the later
  slot disabled by the daily check; the account emitter never sends an `antigravity-cli`
  record to the peer.

**E2E** (`tests/e2e/`): `antigravity-adapter-lifecycle.test.ts` — the production init path
mirroring `server.ts` with the fake binary: the reviewer door returns 200 with a parsed result
and the estimate route returns 200; without opt-in, the named refusal, not a 503.

**Live proof before "done":** L1 a reviewer-shaped multi-line one-shot (envelope, ledger
row, dollar cost recorded); L2 a tool-less run told to use a tool, returning `softDenied[]`
and judged on its answer; L3 a real spec-converge Gemini pass with its cost recorded ("the
seat buys about N passes a week"); L4 (B) a headless job editing a throwaway repo plus the
tool-lane canary; L5 (B) an interactive session through Telegram AND Slack on a throwaway
agent, with the interactive canary.

**Builder probes** (each recorded under `.instar/state/` before the code that depends on it):
P1 stream-json pairing, whether `total_tokens` includes thinking, a whole-home diff across
one run (state dirs), a plugins-disabled switch, and which workspace paths `agy` reads; P2
macOS Keychain isolation; P5 pooled-usage API/metric, overage readability, and the spend
limit's enforcement, scope and current spend; P6 Standard+PAYG coexistence and the PAYG tier
string (docs only); **P7 tool-less confinement by canary with a positive control (gates
Phase A)**; P8 concurrent processes on one home; P9 behaviour after licence removal (on the
FD-8 seat before it goes to a second identity).

## 13. Acceptance by phase

- **Phase A:** census green; P1 and P7 passed; the provisional stall-coverage matrix (§9a) written; L1–L3 pass; quota shows unknown, the estimate
  is labelled, the reviewer store settles real passes; the two-machine test passes; no
  metered/gateway/ADC env reaches any spawn or the sign-in pane; Gemini CLI and Grok reviewer
  tests unchanged and green; FD-4 asked, FD-7 answered or still outstanding (overage stays off
  until answered and verified), FD-11 case filed; the §9 surfaces match; the purchase-run test
  homes deleted; the Gemini no-hint requirement/implementation mismatch (§7.1) filed to the
  Studio's feedback store.
- **Phase B:** its security addendum converged (§4.2 Phase B security gate); the live-verified stall-coverage matrix (§9a); the tool home signed in; workspace paths from P1 under the schema; L4 and L5
  (with both tool-lane canaries); copied (not linked) git config; interpreter grants refused
  in both tool lanes; no automatic retry or re-placement of any tool-capable process.
- **Phase C (its own spec):** the §1 second-identity predicate satisfied and recorded; replicated project state so a second machine can be
  a slot host; per-agent or per-person identities and seats (FD-8); each identity signs
  itself in; P9 passed; slot-metadata emission after all peers advertise support.

## 14. Frontloaded Decisions

- **FD-1 Route:** drive `agy` under the Enterprise seat; the API-key route is the second burst
  door.
- **FD-2 Id/aliases:** `antigravity-cli`; "gemini" stays `gemini-cli`.
- **FD-3 Auth:** OAuth business sign-in on every lane (Google documents headless runs on the
  cached login); ADC is not used and `AGY_ADC_AUTH` is always stripped (§3.4).
- **FD-4 Phase A–B identity and its use.** `justin@sagemindai.io`, the only licensed seat.
  The topic session `echo-topic-145625` (owner of the operator conversation) first looks for an
  existing valid FD-4 card tap; if there is none it asks once, on a Work Board card (if he has
  already said yes in chat, the card is still presented, explaining in one line that the tap
  is what lets the system check his approval at every launch — chat assent alone cannot
  create launch authority, §3.2 step 6) (Approve/Decline bound to identity, app, scopes, scope of use and
  expiry): "Echo is using your Gemini seat under your Google account, first for one-off
  questions and spec reviews, later for full sessions that can edit files and run approved
  commands. Its use comes out of the same weekly allowance as yours. One line in Google's terms
  is not clearly limited to personal accounts; I read it as allowing this, and if you approve
  I'll ask Google in writing, but if Google read it the other way, the account at risk is yours (your Sagemind
  admin account). Approve this until the Dec 19 renewal?" The card also confirms the "Google
  Antigravity" grant on his identity (its `client_id` and recorded scopes), names the slot host
  machine (the Mama PC, by `machineId`), says Echo will file the written question to Google
  once he approves, and states the between-checks billing gap (§6.4). **Nothing
  touches Google under his identity before he approves** (FD-16; round 4, lessons N2,
  conformance): the build, the fake-binary tests and the census proceed; the setup checks
  (P1, P7), L1–L3 and Phase B wait. The card says "a few test runs to check it is locked
  down, then spec reviews". The authority for building at all is his request (message 145637) and the seat purchase
  for this purpose (145688). The 2026-12-17 dark-window review decides what happens if it is
  still unanswered. **Not cheap** (identity).
- **FD-5 Internal routing** excluded by default (§5.1); the agent arbitrates per-component
  overrides.
- **FD-6 No model fallback** on pool exhaustion (§7.2).
- **FD-7 Burst = capped overage, using the ask already outstanding.** The topic session asked
  in message 145713: "may I turn on pay-as-you-go for extra Gemini use with a monthly cap of
  $30?" It reads the Studio's topic history for his answer before anything else and applies
  it; it does not re-ask with a new number and does not push it again (round 4 conformance). If
  unanswered, the same $30 question is mirrored as a Work Board card on the Needs-you surface
  (no new message) after FD-4 is approved and L3 has measured a pass's cost, stating what a yes buys in this increment (in Phase A: about
  N more spec-review passes a week, N from L3's measured cost and the §5.2 share; later,
  Phase B sessions) and what P5 found about the limit. On yes: P5 must show a project-scoped
  hard stop settable at the cap with no other spend on the project (otherwise a new ask,
  §6.4), then the spend limit, then overage on — recorded as `approved` with the operator's
  bound approval snapshot as `approval` (§6.4). On no or no answer: overage stays off and a walled pool falls back
  to other frameworks with disclosure. **Not cheap** (money).
- **FD-8 Further identities and seats** are an operator purchase (Phase C); the build is
  seat-agnostic. One yes/no names the cost — a new Workspace user (checking for a spare seat
  first) plus a $35/month seat, or plus PAYG if P6 allows it — includes that identity's OAuth
  consent, and states the residual terms risk so the identity holder can accept it if Google
  has not answered. On yes the agent creates the user and assigns the licence. **Not cheap**
  (money, identity).
- **FD-9 No-internal-provider configurations are refused** (§5.4).
- **FD-10 The job brake counts primary-framework accounts only**, disclosed as a fleet-wide
  behaviour change (§9).
- **FD-11 Vendor confirmation.** The topic session `echo-topic-145625` files right after the
  FD-4 approval (filing is itself an external write under his identity, so it waits for it —
  round 6, decision-completeness (post-cap fix, round 6; not re-reviewed by a full round — see the convergence report's fix-verification pass); the FD-4 card says the case will be filed),
  quoting §1 and asking the single question, through this ladder: (1) a Google Cloud billing
  or account case from the project's billing account; (2) Workspace admin support (included
  with Business Standard); (3) if neither will answer without a paid support plan, a plainly
  worded blocker to the operator — never buying a support plan without its own money
  question. Whether (1) is available without a paid plan is checked first, not assumed.
  Tracked as an open commitment that re-surfaces weekly until the answer is recorded under
  `.instar/state/`. The answer gates Phase C only.
- **FD-12 Binary pinning:** 1.5.12 pinned as a private copy; upgrades are a deliberate,
  probe-verified step (including P7); current + one rollback kept.
- **FD-13 Billing state not matching an approval** (overage on without one, a different cap,
  a removed limit, other project spend, or unverifiable): never changed by the agent; the
  antigravity lane closes until it matches again (§6.4).
- **FD-16 Live actions wait for FD-4 (round 5, decision-completeness D1).** Nothing touches
  Google under the operator's identity before his approval — not a fresh sign-in, not
  `agy models`, not the banner probe, not P1, P7 or L1–L3. Before approval the build proceeds
  against the fake binary with **fail-closed defaults where P1 is not yet known**: the run
  archive moves the whole non-credential home tree; `total_tokens` is treated as excluding
  thinking tokens (the larger cost estimate); the plugin check assumes no disable switch; tool
  lanes stay closed. **The run's end state when FD-4 is pending is stated plainly:** "built
  and merged dark; P1, P7 and L1–L3 pending the operator's approval." The FD-4 card names
  these few test runs explicitly.
- **FD-17 Session placement.** `framework: antigravity-cli` is a travel blocker — one new branch
  in `travelBlocker()` (`src/core/agentSessionPlacement.ts`) returning
  `framework-does-not-travel`, tested both ways: an
  antigravity session never travels off the machine it was started on, and on a
  non-slot-host machine an antigravity pin falls back to the default framework with the
  standard notice (round 4, integration R3). An explicit forward to the slot host is a later
  build item, carried as a tracked commitment opened with the build PR (no silent deferral).
- **FD-14 Two homes per slot:** a tool-less home (Phase A) and a tool home (Phase B), each its
  own sign-in for the same identity (§3.1).
- **FD-15 One slot host per project in Phases A–B** (§3.1, §8.2); replicated project state is
  Phase C's own spec.

## Considered and declined

- **"Gate the first live run on Google's written answer" (codex, rounds 2–4).** Declined in
  that form, replaced by the operator's informed approval (FD-4, FD-16). The verdict (§1) rests
  on Google's own text: the only wrapping restriction names consumer plans, the headless docs
  document cached-login automation, and the quota docs describe agents using a seat. The
  residual ambiguity is real, and its exposure is the operator's own account. So the decision
  belongs to him, made knowing the risk: the FD-4 card states it plainly, and no live run
  under his identity starts before he approves. Waiting for Google instead would hold his
  decision hostage to a support queue. (An earlier draft said he had "accepted" this boundary
  by being told it in message 145713; that was wrong — being told is not accepting, and no
  reply was on record.) Google's answer still gates a second identity (§1).
- **Replicated project state, a remote reviewer pass, and a lease-holder identity service
  (rounds 2–3).** Declined for this increment in favour of the single slot host (FD-15):
  every replicated version reviewed had a soundness defect, and Phase A–B never need a second
  slot host.
- **ADC for headless lanes (round 2).** Reverted (§3.4).

## Decision points touched

- Admit or refuse a spawn on the env allowlist, the config-file and plugin schema and the per-run settings — invariant; basis: irreversible-consequence; evidence: a metered key, gateway, planted MCP server, plugin or allow-grant would bill outside the seat or run unreviewed code, and spend or tool side effects cannot be recalled (§3.2)
- Admit a home only on a business sign-in whose live licence banner shows an observed, listed tier — invariant; basis: external-constraint; evidence: the FAQ restricts wrapping agy under consumer plans (§1 quote), and only an observed tier is known to be an Enterprise licence
- Instar never reads agy credential contents — invariant; basis: external-constraint; evidence: the FAQ and Additional Terms item 6 forbid third-party use of the Antigravity login
- Never choose or change a Google identity on quota grounds (no switching) — invariant; basis: external-constraint; evidence: the FAQ names account rotation as unsupported on consumer plans and Google pools quota project-wide (§6.1), so switching cannot add capacity and only adds terms exposure
- One agent, one identity and one slot host per project in Phases A–B; a second identity requires the §1 predicate — judgment-candidate: floor is one agent and identity on one machine, refused fail-closed against the machine registry and duplicates disabled by the daily check; arbiter is Google's recorded affirmative answer, or, after 30 days of silence, the identity holder's recorded acceptance on the FD-8 card, with a Google refusal blocking both; basis for the floor is blast radius and Instar-state coherence
- Classify a CLI failure into the §7.2 classes — judgment-candidate: floor is the ordered table on failure diagnostics only (auth/licence/model rows first; unknown shapes are generic provider errors, never success; rate-limit wording stays a cooldown); arbiter is the session owning the adapter on the slot host, confirming fixtures by PR
- One immediate retry for a reset hint of 30 s or less — judgment-candidate: floor is the inherited Gemini policy default kept for parity, tool-less lane only; arbiter is the same fixture-driven tuning
- Pool-wall lift probe timing — judgment-candidate: floor is the slot host probing on a 1 h doubling backoff capped at 24 h, which a real call can only extend, with a 14-day breaker that escalates; arbiter is the window-start estimate from the ledger, which can only move the probe earlier toward the true reset
- Reviewer budget admission — judgment-candidate: floor is lock, reserve and settle against the rolling 7-day share with a conservative first-pass seed and crashed reservations charged at their estimate, stepping down the model ladder and refusing only when no listed, rate-tabled model fits; arbiter is the agent, which may change the default half fraction with a logged reason
- Exclude antigravity-cli from default internal routing — judgment-candidate: floor is excluded (no spend); arbiter is the agent, informed by the §6.3 estimate, via explicit per-component overrides
- Refuse enabledFrameworks sets with no internal provider — invariant; basis: irreversible-consequence; evidence: with no internal provider the outbound message gate is never constructed, so a message it would have held is delivered, and a delivered message cannot be recalled
- Refuse macOS slots until Keychain isolation is proven — invariant; basis: irreversible-consequence; evidence: two slots sharing one Keychain login would run one identity's work under another, which cannot be undone once spent or sent
- Tool-capable processes are never automatically retried or re-placed — invariant; basis: irreversible-consequence; evidence: a tool may have completed before its event was observed, and a replay re-executes edits and commands that cannot be undone
- Tool lanes refuse interpreter grants and apply the deny floor in both headless and interactive sessions; git config is copied, not linked — invariant; basis: irreversible-consequence; evidence: an interpreter grant bypasses any command-name floor and a writable link exposes host credentials, letting a model run or alter what it was never authorised to, which cannot be recalled
- Consent screens are checked deterministically against the recorded app, identity and scopes — invariant; basis: irreversible-consequence; evidence: an OAuth consent grants a third party access to the identity's data, which the operator reserves and which cannot be silently undone
- Overage console state is never changed by the agent without a bound approval, and the lane closes on any mismatch (on without approval, wrong cap, removed limit, new other spend while approved, unverifiable) — invariant; basis: irreversible-consequence; evidence: billable calls past the seat credit spend money that cannot be recovered, and turning off an overage the operator enabled disrupts his own work
- Overage is enabled only behind a project-scoped hard stop at the approved cap with no other project spend — invariant; basis: external-constraint; evidence: the operator approved a capped amount, and an alert-only, account-wide or shared limit cannot keep that cap
- Every launch requires a current, in-scope operator approval and no recorded vendor refusal — invariant; basis: irreversible-consequence; evidence: running under the operator's own account without his current authority, or after Google said no, risks his account and spends his allowance, which cannot be undone
- The ledger estimate may restrain spend and never permit it — invariant; basis: external-constraint; evidence: the estimate cannot see other users of the shared pool (§6.1), so it can only under-count remaining use

## Maturation plan

- **test-agent-live:** a throwaway agent home on the Mama PC temporarily holds the Phase A slot (Echo's slot unenrolled meanwhile) and runs P7, L1, L2 and the reviewer door; the same build refuses registration on a non-opted-in agent and on a non-slot-host machine.
- **dev-agent-live:** Echo runs the Gemini reviewer family on real spec-converge rounds with the reviewer store active for at least two convergence cycles, with no config-drift, identity or parser-drift refusal firing unexpectedly and per-pass cost recorded.
- **fleet:** Phase C, its own spec — replicated project state for a second slot host, gated on Google's written answer or the holder's acceptance (FD-11/FD-8), P9, and slot-metadata emission after all peers advertise support; fleet default-on is a separate, reviewed decision after that.
- **graduation criterion:** read from the reviewer store and iteration logs by the dark-window reviewer: recorded cost on every Gemini pass and zero mislabelled families across at least two convergence cycles, plus one real pool-exhaustion fixture captured or one full seat window observed without one.
- **dark-window:** owner echo (topic 145625 lane); review on 2026-12-17, two days before the seat renews on 2026-12-19, deciding renew / move to an Echo identity / cancel, using the recorded cost per pass and the FD-4/FD-7 answers.
- **ladder:** throwaway agent (Mama PC), then Echo dev agent, then Phase C spec (second slot host, second identity)

## Open questions

*(none)*

## Known unknowns (carried; none blocks Phase A beyond P1 and P7)

Exhaustion text/exit (fixture); macOS Keychain (P2); pooled-usage API, overage readability and
spend-limit enforcement (P5 — blocks enabling overage, not Phase A); PAYG coexistence and tier
string (P6); concurrency on one home (P8; locked meanwhile); licence-removal behaviour (P9);
workspace paths agy reads and whether it reloads them mid-run (P1, blocks Phase B tool lanes);
whether `agy` renews its own login (P1); Google's written answer (FD-11); the operator's answers
to FD-4 (blocks live runs) and FD-7.
