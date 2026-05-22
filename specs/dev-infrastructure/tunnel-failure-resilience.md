---
title: "Tunnel failure resilience — notify on failure + backup provider pool"
slug: "tunnel-failure-resilience"
author: "echo"
review-iterations: 4
review-convergence: "2026-05-22T20:30:00Z"
review-completed-at: "2026-05-22T20:30:00Z"
review-report: "docs/specs/reports/tunnel-failure-resilience-convergence.md"
review-status: "converged at iteration 4 (internal iter1 + GPT iter2 + GPT verification iter3 + GPT verification iter4 returned CONVERGED — no new material issues). External Gemini round skipped per operator (local OAuth not viable in this env; Grok unavailable). eli16-overview embedded as the ELI16 Overview section at the top of the convergence report."
eli16-overview: "specs/dev-infrastructure/tunnel-failure-resilience.eli16.md"
approved: true
---

# Tunnel failure resilience — notify on failure + backup provider pool

## Problem statement

instar exposes the local server (dashboard, private auth-gated views,
file API) to the internet through a Cloudflare tunnel by default. During
Codex install testing, a new agent ("codey") could not produce a
dashboard link: Cloudflare returned HTTP 429 / error 1015 (quick-tunnel
rate-limiting) and `cloudflared` exited code 1 in a retry loop. Two gaps:

**Gap A — the user is never told why the link is missing.** Today the
only user-facing signal is a single Telegram message to the **Lifeline**
topic, fired only after all startup retries exhaust
(`src/commands/server.ts`), reading "Tunnel failed after all retries.
Dashboard link is unavailable until the server is restarted." Nothing is
sent to the **Dashboard** topic (where the user looks for the link),
nothing explains the reason, and nothing fires during the long backoff —
so the user sees silence and assumes the agent is broken.

**Gap B — Cloudflare is a single point of failure.** `TunnelManager`
only runs `cloudflared`. When Cloudflare rate-limits the shared
quick-tunnel pool (transient, IP-reputation-driven, outside the user's
control), there is no alternative path to a public URL.

These are one coherent product story: a resilient tunnel layer that tries
alternatives when the primary fails AND keeps the user informed.

## Current behavior (baseline) — and what this spec REPLACES

- `TunnelManager` (`src/tunnel/TunnelManager.ts`): `start()` spawns
  `cloudflared`, resolves with URL or rejects on `error`/`exit`.
  `attemptReconnect()` does exponential backoff (5s → 5min, max 10
  attempts) on disconnect. `stop()`/`forceStop()` clear only
  `_reconnectTimer`.
- `server.ts` wraps `start()` in its OWN startup-retry ladder (5 retries,
  15s→120s) + background retries (5/10/20 min), calls
  `enableAutoReconnect()`, AND sends the single Lifeline message on final
  exhaustion. It also runs `ensureDashboardTopic()` AFTER the tunnel
  block.
- `TelegramAdapter.sendToTopic(topicId, text, opts?)` routes a message to
  a forum topic; `getDashboardTopicId()` returns the Dashboard topic id;
  `isAuthorized(userId)` accepts ANY user in `authorizedUserIds[]`.

**Single-owner mandate (resolves the #1 review finding).** This spec
makes `TunnelManager` the SOLE owner of the detect → retry → fall-back →
notify → self-heal lifecycle. The existing `server.ts` startup ladder,
background-retry ladder, and the single Lifeline failure message are
**removed**; `server.ts` calls `tunnel.start()` once and registers the
notifier. `TunnelManager.attemptReconnect()` is folded into the new state
machine (one backoff engine, not two). Leaving the old ladders in place
alongside the new lifecycle is explicitly rejected — two owners of one
tunnel produce duplicate broadcasts and racing `start()` calls.

## Proposed design

### Part 1 — Tunnel provider abstraction (trust-tiered)

```ts
interface TunnelProvider {
  readonly name: string;            // 'cloudflare-named' | 'cloudflare-quick' | 'localtunnel' | 'bore'
  readonly tier: 1 | 2;             // 1 = auto/secure, 2 = consent-gated relay
  isAvailable(): Promise<boolean>;  // binary/dep present, token configured
  start(localPort: number): Promise<{ url: string; stop: () => Promise<void> }>;
}
```

**Tier 1 — automatic, secure (Cloudflare only).** Tried silently, in
order, with backoff. The user already trusts Cloudflare as primary:

1. **`cloudflare-named`** — existing named-tunnel path, extracted.
   Highest priority WHEN a token/configFile is present (persistent, not
   rate-limited). Skipped via `isAvailable()` when unconfigured.
2. **`cloudflare-quick`** — existing zero-config default.

**Tier 2 — consent-gated relays (third-party).** These route the user's
private dashboard/view traffic through third-party servers. NEVER
activated silently (see Part 3 consent gate):

3. **`localtunnel`** — npm `localtunnel`, *.loca.lt over HTTPS. Offered
   first on consent (more reliable; encrypted to the relay).
4. **`bore`** — `bore.pub`, a **plaintext TCP** relay. Operator and
   on-path observers see unencrypted content + credentials, so it is
   **disabled by default** (`isAvailable()` returns false unless the user
   explicitly opts it in) and offered only as the true last resort.

ngrok remains excluded (account friction); future opt-in.

Every provider that returns a URL must pass a **post-start reachability
probe** (HTTP GET of `/health` THROUGH the public URL) before it counts
as `active`. localtunnel's interstitial and a down `bore.pub` both return
a URL that doesn't actually serve — the probe prevents a false `active`
state and a broken link broadcast. Probe failure → next provider.

### Part 2 — State machine (single-writer, episode-scoped)

States: `idle` → `starting` → `active` | `retrying` (Tier-1 backoff) →
`awaiting-consent` → `relay-active` | `exhausted`; plus `self-healing`
with transitions `relay-active`/`exhausted` → `self-healing` → `active`.

**Single-writer guard (resolves a CRITICAL).** All transitions go
through one private `transition(expectedFrom, to)` guarded by a
compare-and-set (mirroring `CommitmentTracker.mutate()`), rejecting any
transition whose `expectedFrom` ≠ current state. The existing `error`,
`exit`, and `disconnect` handlers (which can fire together on one process
death) all route through it, so a single death cannot double-advance the
provider index or skip a Tier-1 provider. Each guarded transition carries
a monotonic `epoch`; notifications are emitted only inside `transition()`
and tagged with that epoch (Part 3 dedup).

**Episode model.** Each contiguous failure→recovery cycle is an
`episode` with a unique id and a one-time consent `nonce`. All consent
state is bound to `(episodeId, provider, ownerId)`.

**`awaiting-consent` is fully specified for every event:**
- Owner approves (matching nonce, see Part 3) → start the offered Tier-2
  provider (re-validate episode still open) → `relay-active`.
- Owner declines / `consentTimeoutMs` elapses → `exhausted`, then keep
  probing Tier 1 in the background (Part 5).
- **Tier 1 recovers during the consent window** → cancel pending consent,
  clear its timer, transition `awaiting-consent → active`; a later "yes"
  is a no-op (episode closed, nonce invalid) with an "already back
  online" reply.
- `stop()`/`forceStop()` → clear consent timer, abandon prompt, → `idle`.
- A second overlapping failure cannot reuse the first episode's consent
  (single-flight, episode-keyed).

`exhausted` is non-terminal: `exhausted → self-healing` is an explicit
transition.

### Part 3 — Notification + consent (Dashboard topic, owner-bound)

A `TunnelNotifier` consumes guarded transition events and routes
user-facing messages to the **Dashboard** topic. To resolve the
Dashboard-topic-race CRITICAL, `ensureDashboardTopic()` is moved AHEAD of
tunnel startup (or the notifier lazily ensures it before its first send),
so the Dashboard topic id exists during the failure window. Fallback
order if it still cannot be resolved: Lifeline → group General topic;
if NO messaging channel is confirmed up, the manager does NOT enter
`awaiting-consent` (no recipient for the prompt) — it goes straight to
`exhausted` + background retry.

Messages (all fixed-template, no LLM, tone-gate compliant — plain
English, no CLI/backticks). **Two delivery channels with strictly
separated content:**

- **Group topic (Dashboard / Lifeline fallback / General fallback):**
  STATUS TEXT ONLY — never the URL, never the PIN, never a signed view
  link. Group messages describe what happened (Cloudflare rate-limited,
  trying a backup, back online, etc.) and tell the owner to check their
  DM for the link.
- **Owner DM (private bot chat with the owner principal):** the actual
  link, PIN, signed view URLs. Telegram's bot DM channel is the only
  place credentials flow to the user, because anyone in the group topic
  could read a group-posted link and bypass the owner-only consent
  gate (GPT external review finding #1).

Per-event:

- **First Tier-1 failure** of an episode: group — "couldn't reach the
  usual Cloudflare tunnel (reason), still retrying." No DM.
- **Tier-1 recovered**: group — "back online; link sent to your DM."
  DM — restored URL + PIN.
- **Consent request** (entering `awaiting-consent`): delivered to the
  **owner DM only** — group gets a brief "Cloudflare is down; checking
  with you in DM about a backup." The DM message:
  - Honest about exposure: the relay's operator (and, for bore, anyone
    on the network path) would be able to open your dashboard and
    private views, because the link carries your access credentials.
  - Delivered as a **Telegram inline-keyboard button** with the one-time
    nonce in `callback_data` (NOT free-text yes/no).
  - **Nonce concretely specified** (GPT finding #4): ≥128-bit CSPRNG;
    persisted with `(episodeId, provider, ownerId, chatId, messageId,
    issuedAt)`; atomic compare-and-delete on use (no replay); the
    inline keyboard is `editMessageReplyMarkup`-cleared the instant
    any terminal decision fires (timeout, decline, approval, or
    Tier-1 self-heal) so a stale button cannot be clicked later.
  - Owner check: callback is rejected (with a fixed "only the owner can
    approve this") if `callback_query.from.id` ≠ owner principal id.
- **Relay activated**: group — "backup tunnel is up; link sent to your
  DM." DM — relay URL + (newly rotated) PIN.
- **Declined / timed out / all relays failed**: group — what was tried,
  the reason, and that the agent keeps retrying Cloudflare and switches
  back automatically (no restart). DM — nothing new.
- **Self-healed to Tier 1**: group — "your permanent link is back; new
  link in your DM." DM — restored URL + rotated PIN.

**Anti-spam, by notification class (resolves a HIGH from internal +
GPT finding #5).** The 15-min floor must NOT suppress control-plane
messages or the consent prompt, or fallback never activates. Messages
are classed:

- `action-required` (consent prompt; "your DM has the new link" pointer
  in group when a credential is delivered): **never throttled within an
  episode.** Cross-episode it is rate-limited (verification finding V2):
  if the owner declined or let consent timeout in the last N episodes
  (default 3), subsequent consent prompts are suppressed for an
  exponential cooldown (1h → 4h → 24h, capped at 24h) and the manager
  goes directly to `exhausted` + background retry. Cooldown releases
  when (a) the owner explicitly opts in again ("yes, use a backup"
  message in DM resets the counter) or (b) Tier-1 recovers and a fresh
  episode begins after the window expires. During cooldown, group
  notifications use the `state-change` class. This bounds alert-fatigue
  / abuse-amplification under sustained Cloudflare outage where the
  owner has already chosen not to relay around.
- `state-change` (first failure, recovered, declined/exhausted): light
  throttling — at most one per episode per state, and at most one per
  15 minutes within an episode if the same state is re-entered.
- `noise` (every flap, every backoff tick): heavy throttling — flapping
  episodes (≥3 connect/drop cycles) collapse into one "tunnel
  unstable" message, suppressed for the rest of the episode.

Self-heal "permanent link is back" is `state-change` (not throttled by
the noise quota) but the underlying probe still uses the
N-consecutive-success stability gate (Part 5) so the message itself can
only fire when migration genuinely happens.

**Consent-reply routing (resolves the spec's old open question).** The
inline-button callback is handled by a dedicated callback handler, NOT
the normal inbound message dispatcher, so it cannot race session-spawn.
There is no free-text consent path to intercept.

### Part 4 — Config (via ConfigDefaults, names reconciled)

New keys live under the existing `tunnel` block and are applied to
existing agents through `src/config/ConfigDefaults.ts`
(`MIGRATION_DEFAULTS.tunnel`, existence-checked deep-merge) — NOT
hand-written `migrateConfig` blocks. Field names are reconciled
(single set, used everywhere):

```ts
interface TunnelConfigType {
  enabled: boolean;
  type: 'quick' | 'named';
  token?: string; configFile?: string; hostname?: string;
  // NEW (all optional; deep-merge preserves existing values)
  relayProviders?: ('localtunnel' | 'bore')[];  // consent order; default ['localtunnel'] (bore opt-in)
  relaysEnabled?: boolean;                        // default true (still consent-gated)
  relayConsent?: 'ask' | 'never';                 // default 'ask'. 'always' DROPPED from v1
  consentTimeoutMs?: number;                      // default 900000 (15 min; staggered off the reconnect window)
  notifyTopic?: 'dashboard' | 'lifeline';         // default 'dashboard'
}
```

`relayConsent: 'always'` is intentionally NOT offered in v1 — it
contradicts the security-first decision and is a silent-exposure footgun.
`relayConsent: 'never'` = Cloudflare-only. `relaysEnabled: false` hard-
disables Tier 2. `bore` is excluded from the default `relayProviders`
list; a user adds it explicitly.

### Part 5 — Self-heal (background Tier-1 recovery)

A low-frequency, **unbounded** background probe (separate counter from
the bounded startup-reconnect, so it never goes silent after the 10-
attempt ceiling) tests Tier-1 availability while a relay is active or the
manager is exhausted. To resolve the URL-thrashing HIGH:
- Migrate back only after **N consecutive probe successes over a
  stability window** (default 3 successes / 5 min); a single success
  during Cloudflare flapping does not trigger a switch.
- **Atomic switch-back (new-then-old).** Bring Cloudflare fully up and
  verify via the reachability probe, set `_state.url` to the new URL in
  one synchronous assignment, THEN tear down the relay — so
  `getExternalUrl()` never returns a dead URL.
- **Relay teardown is forceful.** A relay provider's `stop()` must
  escalate SIGINT→SIGKILL with PID verification (mirroring the existing
  `forceStop()`); self-heal confirms the relay child is gone before
  emitting "permanent link is back," so private traffic cannot keep
  flowing through the third party.

### Part 6 — Security: credential handling

- **Credentials never reach the group topic** (GPT finding #1). The
  separation in Part 3 is the structural fix: group topics carry status
  text; URL/PIN/signed view links flow to the owner DM only.
- **Mandatory rotation on ANY terminal exit from `relay-active`** (GPT
  iteration 2 finding #2 + iteration 3 verification finding V1). PIN
  rotation alone does NOT mitigate replay of HMAC-signed view URLs whose
  `sig` is derived from `authToken`. The rotation trigger is broadened
  from "`relay-active → active | exhausted` only" to **every** path that
  ends a relay episode, including:
  - `relay-active → active` (self-heal)
  - `relay-active → exhausted` (decline / consent timeout while relay
    was already up)
  - `relay-active → idle` (operator-initiated `stop()` / `forceStop()`,
    SIGTERM/SIGINT to the agent, server shutdown)
  - **Boot-recovery path**: when the manager boots and the persisted
    `tunnel.json` shows the last state was `relay-active` (i.e., the
    agent died mid-relay-episode), rotation is performed before the
    server accepts ANY API traffic on the new boot. A
    `rotation-pending` flag is written to `tunnel.json` at the moment
    a relay episode starts and cleared only after rotation completes,
    so a crash between "episode started" and "rotation done" is safe
    and resumes correctly on next boot.

  Rotation always covers BOTH:
  1. `dashboardPin` — new 6-digit PIN surfaced to the owner DM.
  2. `authToken` — rotated; invalidates all previously-signed view URLs
     and the dashboard session. The owner DM message states explicitly
     that any prior dashboard tab will need to log in again with the new
     PIN, and that any previously-shared private view links are now
     invalid. This is the documented UX cost of the security guarantee.
- **No credentialed URL in logs or state.** A single redaction helper
  strips query strings / PIN at every LOG callsite and at every GROUP
  notification callsite; unit tests assert no provider path logs a raw
  credentialed URL and that `tunnel.json` (`saveState`) never persists
  one. The owner-DM path is the only exception (resolves the apparent
  Part 3 ↔ Part 6 inconsistency from GPT finding #7).
- **Consent is single-use**, bound to `(episodeId, provider, ownerId,
  chatId, messageId, issuedAt)` (chat/message binding per GPT #4),
  validated at relay-start, expired on `consentTimeoutMs`, never carried
  across episodes or providers (localtunnel→bore requires its own
  approval). The inline-keyboard is invalidated via
  `editMessageReplyMarkup` on every terminal transition.
- **`/tunnel` endpoint is auth-gated** (GPT finding #6). Same Bearer-
  token gate as the rest of the private API. Response is minimized for
  non-owner principals (provider name + boolean `active` only); full
  state (current provider, last-failure-reason, episode id) is
  owner-only. Failure-reason strings never leak credentials.

### Part 7 — Migration parity

- **Config**: `ConfigDefaults.ts` `MIGRATION_DEFAULTS.tunnel` (Part 4).
- **CLAUDE.md**: Agent Awareness update in BOTH `generateClaudeMd()`
  (`templates.ts`) and `migrateClaudeMd()` (`PostUpdateMigrator`) with a
  content-sniff guard — so existing agents can explain link issues
  conversationally.
- **Dependencies (supply-chain, GPT finding #3).** The consent gate is a
  privacy mitigation, NOT a supply-chain one — `localtunnel` runs as
  in-process code on every agent regardless of whether it's ever used.
  Therefore localtunnel integration is treated as privileged code:
  - **Exact-version pin** in `package.json` (no `^` range); lockfile
    enforced in CI; any version bump goes through a dependency-diff PR
    that is human-reviewed.
  - **Provenance check**: only versions with npm provenance attestations
    are accepted; install gate refuses a release without provenance.
  - **Fresh-release cooldown**: refuse to upgrade to a version released
    within the last 7 days, so a compromised publish can be caught
    before propagating.
  - **Runtime isolation**: the relay provider is spawned as a child
    process (mirror the `cloudflared` pattern) rather than imported in-
    process where feasible, so a compromised localtunnel cannot read
    instar state or the auth token. If keeping it in-process is
    necessary, document the broader transitive surface
    (axios/yargs/debug/openurl) and which versions are pinned.
  - **Alternative considered**: vendor a minimal audited client. Carried
    as an open question for the convergence-verification round; if the
    minimal client is feasible, prefer it over the npm dep.
- `bore` has **no generic binary downloader today**; v1 ships `bore`
  `isAvailable()=false` unless a checksum-verified install path is
  added — it is dropped from the offered list when absent rather than
  failing consent then leaving the user link-less.
- **Non-forum groups**: where the group is not a supergroup,
  `getDashboardTopicId()` is permanently undefined; notifications route to
  the group's General topic, and if even that is unavailable the manager
  skips `awaiting-consent`.

### Part 8 — Testability

- Inject a **clock/timer abstraction** and a `sendToTopic` seam so unit
  tests drive consent-timeout→decline and self-heal→migrate-back
  deterministically (no 15-min real waits).
- Expose tunnel state on `GET /tunnel` (Bearer-auth-gated; owner-only
  full response per Part 6): current provider, state, last-failure-
  reason, episode id — the assertable surface for Tier-2 (HTTP) and
  Tier-3 (E2E "feature is alive") tests, since this feature is event-
  driven and has no natural request route otherwise.
- All three test tiers required per the Testing Integrity Standard,
  including a wiring-integrity test that the notifier's `sendToTopic` dep
  is real and an E2E that a forced Tier-1 failure surfaces a Dashboard-
  topic message and a `/tunnel` state of `retrying`.

## Decision points touched

- New `Tier-1 → awaiting-consent` hard gate (no silent relay).
- New consent approval gate, bound to the owner principal via a nonce-
  carrying inline button.
- New self-heal switch-back decision (N-consecutive-success stability).
- **Removes** the `server.ts` retry-ladder + Lifeline-message decision
  points (consolidated into the manager).

## Resolved decisions (operator, 2026-05-22)

1. Default to secure: Cloudflare-only automatic chain; relays consent-
   gated.
2. On consent, localtunnel first, bore last (and bore disabled by default
   per the security review — plaintext TCP).
3. Self-heal ships in v1.

## Open questions (for the convergence-verification round)

1. **`localtunnel` minimal audited client vs. pinned npm dep.** The
   spec specifies a hardened npm-dep posture (exact pin, provenance,
   cooldown, child-process isolation) AND mentions vendoring a minimal
   client as an alternative. The verification round should pick one.
2. **`authToken` rotation UX.** Mandatory rotation kills the current
   dashboard session and any shared signed view URLs. v1 says do it
   anyway (security > convenience). Verify the user-facing recovery UX
   is acceptable, or accept a documented one-time prompt.
3. **Should v1 ship `bore` support at all** (given no install path +
   plaintext TCP), or land localtunnel-only and add `bore` in a follow-
   up once a checksum-verified binary path exists?

## Resolved external-round findings (GPT, iteration 2)

| # | Sev | Area | Finding | Resolution in v3 |
|---|-----|------|---------|------------------|
| 1 | CRIT | privacy | Group-posted URL+PIN defeats owner-only consent | Two-channel notify: group=status only, owner DM=credentials (Part 3, Part 6) |
| 2 | HIGH | crypto/replay | PIN rotation alone leaves signed-URL replay window | `authToken` rotation mandatory after every relay episode (Part 6) |
| 3 | HIGH | supply chain | Consent gate ≠ supply-chain mitigation for localtunnel | Hardened-dep posture: exact pin + provenance + cooldown + child-process isolation; minimal-client alternative carried (Part 7) |
| 4 | HIGH | telegram callback | Nonce binding under-specified | Concrete spec: ≥128-bit CSPRNG, atomic compare-and-delete, (episode,provider,owner,chat,message,issuedAt) binding, editMessageReplyMarkup on every terminal transition (Part 3, Part 6) |
| 5 | HIGH | UX integrity | 15-min floor could suppress consent prompt / control plane | Class-based throttling: `action-required` never throttled; `state-change` light; `noise` heavy (Part 3) |
| 6 | HIGH | api leak | `GET /tunnel` could leak ops state to non-owners | Bearer-auth-gated; minimized response for non-owner; failure-reason text scrubbed (Part 6, Part 8) |
| 7 | HIGH | inconsistency | Part 3 send URL+PIN vs. Part 6 redaction-everywhere conflict | Reconciled: redaction strict for logs + group; owner DM is the only credential path (Part 6) |

## Review status

Internal multi-angle iteration 1 (security, adversarial, integration,
state-machine) and external iteration 2 (GPT-5.3-codex via ChatGPT
subscription OAuth) completed. All material findings folded into v3.

**Still owed before `approved: true`:**
- External Gemini round (the local `gemini` CLI's OAuth flow is failing
  non-interactively in this environment — `selectedAuthType:
  oauth-personal` does not satisfy `GOOGLE_GENAI_USE_GCA`; OAuth creds
  are ~10 months old, possibly expired or scope-mismatched). Needs
  re-auth, or invoke via the instar dev context where it is wired.
- Convergence-verification round on v3 (no new material findings).
- Operator approval after reading the plain-English convergence
  summary.

No code is written until all remaining rounds pass and approval is
granted.
