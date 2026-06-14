---
title: "Live credential re-pointing — restartless subscription rebalancing"
slug: "live-credential-repointing-rebalancer"
author: "echo"
status: approved
approved: true
approved-by: "Justin (operator, telegram uid:7812716706, topic 20905, 2026-06-12T07:13Z) — 'approved!'"
approval-scope: "BUILD of Increment A, shipping dark (enabled:false + dryRun:true). Enabling the feature is a separate later decision."
review-convergence: live-cred-repoint-convergence-2026-06-12
review-convergence-detail: "5 grounded review rounds with a premise/challenge-the-mechanism reviewer (LRN-007 dogfood) + security, concurrency/crash-safety, code-grounding, adversarial, and instar-standards lenses, all grounded against canonical main v1.3.488. Material-findings trend 50→22→12→5→0. R1 settled the premise via live experiments E1–E4b (per-request store re-read PROVEN; rotation real; auth-status disqualified as oracle; profile endpoint adopted as identity oracle). R2 (4 blocking + ~22 material): dev-gate registry would have shipped live-with-writes (→ DARK_GATE_EXCLUSIONS destructive); source-slot client-write strand (→ §2.3.1a CAS); per-slot lock must be a structural funnel; oracle-unavailable→quarantine-never-repair; staging retained-until-re-verify; legacy Frankenstein-blob writer disposed at the manager. R3 (~12): the §0.g meta-pattern — every guard bypass must carry its own cap (wall-override, default eviction, restore-enrollment were uncapped); env-token gate must cover API keys + the live fleet; funnel must name both keychain write primitives. R4 (~5): all honesty-of-residual + one new teardown identity-coherence check; corrected a grounding error I introduced in §2.10 (interactive-pool token source). R5: CLEAN — premise + adversarial both CONVERGED, no new material breaks. Report: docs/specs/reports/live-credential-repointing-rebalancer-convergence.md"
eli16-overview: "live-credential-repointing-rebalancer.eli16.md"
parent-principle: "Structure beats Willpower — which account's credential sits in which config home is durable bookkeeping (the CredentialLocationLedger) enforcing the one-home-per-credential invariant structurally, not any of a dozen consumers remembering to track it"
lessons-engaged: "P2, P7, P14, P19, L5, L6, L7, B9, B12, Signal-vs-Authority, No-Silent-Degradation, Migration-Parity, Testing-Integrity, Observable-Intelligence, Token-Audit-Completeness, Close-the-Loop, Dev-Agent-Dogfood, LRN-007"
---

# Live credential re-pointing — restartless subscription rebalancing

**Status:** draft rev 5 (post round-4 panel: 4 grounded reviewers — standards + concurrency both
declared CONVERGED, premise sound, no architecture break. ~5 round-4 items folded: ALL
honesty-of-residual / prose-correction / one new teardown coherence-check — no mechanism change.
Trend: material findings ~50 → 22 → 12 → ~5. Round-3 meta-pattern §0.g "every guard bypass
carries its own cap" extended to the manual `force` lever. Round-1: ~50; round-2: ~22 + 4
blocking; premise experiments E1–E4 live 2026-06-11 — see §0.c)
**Supersedes:** the CORE MECHANISM of `reset-proximity-drain-rebalancer.md` rev 7 (restart-based
drain moves). That spec's observability scaffolding, containment posture, and rotation-constraint
analysis carry forward; its restart machinery does not.
**Merges:** the "reset-proximity rebalancer" work item (CMT-1335) and the "zero-touch
default-account flip" work item (CMT-1337) into ONE credential-management feature.
**Grounding base:** canonical JKHeadley/main `7526bb5ea` (v1.3.488), grounded 2026-06-11.

---

## 0. PREMISE REVIEW (mandatory; LRN-007 "Challenge the Mechanism, Not Just the Design")

This section exists because the predecessor spec spent 7 convergence rounds hardening a
mechanism that should not have existed. Convergence audits the design; THIS section audits the
premise, BEFORE any design detail is allowed to accrete. Round 1's premise reviewer found the
original §0.c evidence over-claimed ("proven" things that were merely consistent-with), so the
premise was settled the only honest way: **live experiments on this machine** (§0.c). Every
future revision must keep this section current.

### 0.a The goal, stripped of any mechanism

Maximize useful consumption of the org's pooled subscription quota and keep every session
working through quota walls — with **zero user involvement** and **zero work disruption**.
Concretely: (1) a weekly quota window about to reset with unused headroom gets used before
the headroom evaporates (use-it-or-lose-it); (2) a session whose current account approaches a
wall keeps working without dying or pausing; (3) the operator's "default" account can be
changed at any time without anyone logging in or touching a screen.

### 0.b The lightest mechanism that could achieve it

Change **which account's credential sits in the config home a session already reads** — and
nothing else. No session restart, no transcript copy, no idle-detection, no continuity
machinery. PROVEN (E3, §0.c): Claude Code re-reads its credential store **on the next request
whose in-memory access token fails auth** — and a credential swap produces exactly that 401 on
the now-stale in-memory token, so the swap takes effect on the very next API call of every
session in that home. (The literal "every request" is one notch stronger than E3 measured —
E3 forced the re-read with a 401; a swap forces the identical 401 — so for THIS mechanism the
distinction is immaterial, but it is stated honestly here so no downstream section over-relies
on it.)

**Applicability gate — when this feature is alive vs inert (round-2 premise re-check):** the
light mechanism holds ONLY for sessions whose credential COMES FROM the store. A session
launched with `CLAUDE_CODE_OAUTH_TOKEN` in its environment (set whenever
`config.anthropicApiKey` is an OAuth token — `SessionManager.ts:1724-1726`, `:1998-2000`,
`:3155-3157`) never reads the store, ignores any swap, and is invisible to this mechanism.
A round-2 reviewer correctly flagged that if that env-token launch were the norm, the entire
feature would be INERT. **Live evidence settles it for this deployment:** `config.anthropicApiKey`
is EMPTY (verified 2026-06-11), so claude-code sessions launch WITHOUT `CLAUDE_CODE_OAUTH_TOKEN`
and read the per-`CLAUDE_CONFIG_DIR` store — which is precisely why pinning already distributes
load across the five pool accounts today (an env-token fleet would all bill ONE account
regardless of pin). The mechanism is real for the actual config. §2.10 enforces the gate
structurally (refuse + named reason under an env-token config) AND now evaluates the LIVE
running fleet, not just the config field, so a mid-life flip to an OAuth token cannot silently
un-steer new spawns while freezing the steerable old ones.

### 0.c Evidence — live experiments, 2026-06-11, this machine (replacing rev-1's inferences)

Rev 1 cited an "hourly refresh proof" that does not exist (grounding correction: the only
production caller of `refreshClaudeToken` is QuotaPoller's 401-recovery path,
`QuotaPoller.ts:218`/`:292` — reactive, ~once per 8h access-token expiry per account, not
hourly) and an operator `/login` anecdote that proves non-disruption but not attribution
timing. Both were *consistent with* a session caching credentials until expiry — under which
this whole design mis-prices. So the premise was tested directly:

- **E1 — per-slot probe works, side-effect-free.** `CLAUDE_CONFIG_DIR=<slot> claude auth
  status` returns that slot's account email (verified against two slots + default), and the
  keychain blob hash is byte-identical before/after. (Resolves rev-1 open question 1.)
- **E2 — rotation is REAL.** One refresh-token exchange (the exact QuotaPoller 401-recovery
  operation) returned `rotated: true` with an 8h access token (`expires_in: 28800`). §0.d's
  constraint is confirmed fact, not assumption.
- **E3 — per-request store reads PROVEN.** A live interactive session pinned to an enrolled
  home answered message 1 normally. Its access token was then corrupted in the keychain
  (refresh token left intact). Message 2 succeeded anyway, and field-level hashes show a
  **fresh exchange**: new access token (≠ original, ≠ corrupted) and a ROTATED refresh token
  — the client re-read the store at request time, hit the 401, refreshed from the store's
  refresh token, wrote back, and continued. Repeated with identical results. Corollary: a
  swap that corrupts only an access token **self-heals**.
- **E4 — a real swap under a running session is non-disruptive (LIVENESS only).** Two
  enrolled homes' credentials were exchanged while a session ran in one of them; the session
  continued without interruption and both homes were verified restored afterward. NOTE
  (round-2 precision): E4 establishes liveness/non-crash, NOT per-request attribution timing —
  that claim rests on E3's corruption-and-self-heal probe alone. No downstream section cites
  "E4" for actuation timing.
- **E4a — `claude auth status` is a LYING verify-oracle.** After the swap, the slot's
  `auth status` still reported the OLD tenant: the command reads `.claude.json`
  `oauthAccount`, NOT the keychain credential. It is hereby disqualified as the
  verify/recovery oracle (it remains useful only as a config-metadata reader).
- **E4b — a true identity oracle EXISTS.** `GET https://api.anthropic.com/api/oauth/profile`
  (Bearer = the blob's access token) returns the owning account's email. Verified against
  all five enrolled homes — each returned its registry email. The keychain blob itself
  carries NO identity (fields: accessToken, refreshToken, expiresAt, scopes,
  subscriptionType, rateLimitTier — verified by shape inspection), so this endpoint is the
  ONLY way to verify which account a blob belongs to from the blob alone. §2.3's verify and
  §2.2's recovery are built on it.

**The one claim that remains unproven (stated honestly):** whether the client, hours after a
swap, can write the OLD tenant's lineage back from an in-memory refresh-token copy (the
"at-expiry write-back" hazard). E3 proves the client reads the access token from the store
per request; in E3 the store and memory refresh tokens were identical, so it cannot
discriminate where the refresh token came from. Settling it requires sacrificing a real
lineage (a forced re-login — operator involvement), so it is NOT settled pre-convergence.
The design treats it as live, and round 2 sharpened WHICH detector catches it: the §2.3.6
delayed re-verify (~90s) catches only a refresh that was IN FLIGHT during the swap (a
sub-2-minute window) — it does NOT catch an at-expiry write-back that lands hours later. The
actual detector for the long-tail case is the **always-on scheduled identity audit** (§2.4:
the canary cross-check now runs on EVERY slot every pass, not just quarantined slots). Blast
radius is bounded at one account re-auth, and the dogfood phase (§2.8) settles it empirically
with a deliberately-minted disposable second grant before any fleet rollout. (§6 splits the
two windows into separate risk rows so no section implies the 90s check closes the residual.)

- **Restart cost (alt-1 pricing, §0.e):** the incumbent swap kills the session, copies the
  transcript (`SessionRefresh.ts:61-91`), respawns with `--resume` under a new
  `CLAUDE_CONFIG_DIR` (`SessionManager.ts:1712-1716`) — wall-clock seconds, but the
  goal-relevant costs are the aborted in-flight turn, the full-transcript re-ingestion
  (prompt-cache miss = real tokens + latency on long conversations), and the wedge-risk an
  entire sentinel family exists to manage.

### 0.d The one real constraint the light mechanism inherits — now CONFIRMED

Anthropic rotates refresh tokens on exchange (E2: `rotated: true`). The same **credential
blob** (one login's grant lineage) must therefore never be **readable from two config homes
at once** — whichever copy refreshes first rotates the token and strands the other copy.
The unit is the blob (grant lineage), NOT the account: two *separate logins* to the same
account are independent grants and coexist fine (why the same org account is enrolled on two
machines today without breakage). The bookkeeping core maintains: **each lineage lives in
exactly one config home at a time** — *by construction for every instar-originated write*
(§2.3 swaps exchange, never copy), and *by detect-and-heal* against the one writer instar
cannot lock: the Claude client's own keychain write (the §0.c residual + §2.3's source-slot
race). The phrase "by construction" is deliberately scoped to instar's writes; the exogenous
client write is NOT closed by construction — it is narrowed by the source-slot CAS re-read
(§2.3.1a) and detected by the identity audit, with bounded blast radius (one account re-auth).
Honest seam, not a guarantee.

### 0.e Alternatives weighed and rejected (the premise reviewer's missing table)

| Alternative | Verdict |
|---|---|
| **alt-1: keep restart-swaps, make them cheap** | Fails goal 3 outright (default-home flip is not a session problem); goal 1's aggressive drain stays restart-priced (aborted turns, cache-miss re-ingestion, wedge-risk — §0.c pricing). Rejected. |
| **alt-2: spawn-time routing only; session turnover rebalances** | Approximately the status quo (`QuotaAwareScheduler.selectAccount` already does reset-aware placement); instar sessions are long-lived (hours-days, reaper-protected), far too slow for a ≤24h weekly drain horizon. Fails goals 2 and 3. Rejected. |
| **alt-3: per-request token injection at a local proxy (`ANTHROPIC_BASE_URL`)** | Lighter bookkeeping (no §0.d hazard, no ledger) and guarantees per-request steering — but an always-on proxy is a fleet-wide availability SPOF, subscription-OAuth-through-proxy is unproven for this client, and it does nothing for goal 3 (manual `claude` runs outside it). Rejected — **contingency now void**: E3 proved per-request actuation, removing alt-3's one decisive advantage. |
| **alt-4: one slot (`~/.claude`), everything unpinned, flip its credential** | Genuinely lighter (one assignment record, no permutation) and goal 3 IS its primitive — but all sessions move together: cannot drain account B with sessions Y/Z while keeping hot session X on healthy A; every flip is fleet-wide; one bad blob walls the machine. Per-slot granularity is what lets drain and wall-avoidance act on different sessions at once. Rejected, with this explicit granularity justification. |
| **alt-5: ship the swap-primitive + ledger + oracle + manual levers FIRST (goals 2-reactive + 3), add the autonomous drain BALANCER (goal 1) as a SECOND increment** | The premise reviewer's decomposition challenge of the CMT-1335+CMT-1337 merge. The shared core — ledger (§2.2), staged-exchange swap primitive (§2.3), identity oracle (E4b), `set-default`/`swap`/`restore` levers (§2.4) — is genuinely indivisible bookkeeping and IS needed for goal 3's flip and goal 2's reactive rescue. The **balancer loop** (§2.4 objectives/hysteresis/breaker — ~40% of the design surface and ALL the autonomous-write risk) is NOT needed for goals 2/3. **Verdict: ADOPTED as the BUILD SEQUENCING, not as a spec split.** One spec, two shippable increments: Increment A = primitive+ledger+oracle+levers (the §2.8 dry-run→live ladder gates this first, delivering CMT-1337's zero-touch flip and operator-triggered rescue with the smallest authority surface); Increment B = the autonomous `CredentialRebalancer` (goal 1's drain), promoted only after Increment A is live-on-Echo and stable. This keeps the indivisible core whole (no two half-built ledgers — the merge's real justification) while refusing to bundle the autonomous loop's risk into the first ship. The LRN-007 catch: the merge was asserted ("into ONE feature") in rev 2; rev 3 records the lighter-first decomposition and adopts it as the rollout spine. |

### 0.f Complexity audit

Every remaining mechanism traces to the goal: ledger → §0.d invariant + correct quota/spawn
resolution; staging escrow + journal → crash-safety of a non-atomic two-write exchange;
identity-oracle verify → E4a (the obvious oracle lies); quarantine → fail-safe containment;
hysteresis → sensor lag (controller theory, not disruption budgets). Rev-1's sentinel-marker
registration was identified as mechanism-momentum from rev-7 and is REPLACED by the real
trace: a slot-keyed double-mover interlock (§2.7) — a credential swap touches no session, so
the restart-oriented sentinel markers don't apply. **Honesty note (round-2):** the
1-swap-per-pass actuation cap (§2.4) is NOT pure controller-theory hysteresis — it is also a
rate limit, the very thing the operator's "no restart-style movement budgets" directive pushed
against. It survives that directive because its justification is sensor-noise (acting twice on
one 15-min reading is acting on noise), not disruption-cost (a swap is non-disruptive). It is
named here as a noise-derived rate limit, not laundered as pure hysteresis — and the genuine
wall-emergency case is given an explicit override (§2.4) so the cap can never starve a rescue.

---

### 0.g Design principle — every guard bypass carries its own cap (round-3 meta-pattern)

Round 3 found that each of rev-3's three new *bypasses* — the wall-override (skips cooldowns
+ the 1-swap/pass cap), the dead/quarantined-default eviction (skips the quarantine exclusion),
and the restore-enrollment quarantine bypass (skips the quarantine precondition) — was correct
for its motivating case but left UNCAPPED for the adversarial case, re-introducing the very
churn/corruption the bypassed guard prevented. The shared fix is a standing rule, applied to
every bypass in this spec: **a bypass of a safety guard must (a) carry its own bounded budget
(a cap distinct from the guard it bypasses), (b) PRESERVE every precondition NOT specifically
named in the bypass (a quarantine bypass does not also drop the parse/refresh-token check), and
(c) make "no safe action available" a SURFACED terminal state (degradation report + attention
item), never an unbounded retry/loop.** §2.4 (wall-override + default eviction) and §2.8
(restore-enrollment) below each instantiate this rule explicitly.

## 1. Problem — what exists vs the gap (grounded against v1.3.488)

What exists today:

- **Per-account config homes.** Each enrolled account = a `SubscriptionPool` registry entry
  carrying `configHome` (`src/core/SubscriptionPool.ts:84-121`); credentials live ONLY in
  that home's credential store (macOS keychain service `Claude Code-credentials-<8hex>`,
  default home unsuffixed — `OAuthRefresher.ts:115-121`). The registry never stores tokens
  (FORBIDDEN_CREDENTIAL_FIELDS, `SubscriptionPool.ts:183-194`).
- **Spawn-time placement.** `QuotaAwareScheduler.selectAccount` scores accounts
  (`unusedHeadroom × 1/hoursUntilReset`, `QuotaAwareScheduler.ts:83-125`) and pins new
  sessions via `CLAUDE_CONFIG_DIR` (`SessionManager.ts:1712-1716`, `:1989-1990`).
- **Reactive + proactive swaps — both restart-based.** `onQuotaPressure`
  (`QuotaAwareScheduler.ts:178-212`) and `ProactiveSwapMonitor` (threshold 80% measured)
  move a session by kill → transcript-copy → respawn-with-`--resume` under the new home.
- **Quota truth.** `QuotaPoller` reads each account's 5h/7d windows + `resetsAt` from the
  OAuth usage endpoint every 15 min (`QuotaPoller.ts:212`), persists `lastQuota` onto the
  pool record, computes burn rates from snapshot pairs (`QuotaPoller.ts:354-387`).
- **A SECOND, legacy credential-writing pipeline** (round-1 discovery): `AccountSwitcher`
  writes cached, refresh-token-less blobs into the DEFAULT keychain entry
  (`CredentialProvider.ts:75`, `AccountSwitcher.ts:142-145`), reachable via the
  `/switch-account` Telegram command (`server.ts:946-956`) and the `config.autoMigrate`
  path (`QuotaManager.ts:567-580`). §2.7 disposes of it.

The gaps:

1. **Nothing drains a use-it-or-lose-it window.** Reset-proximity is consulted only at spawn
   and as swap TARGET selection; unused weekly allowance evaporates.
2. **Every existing move is a restart** — heavy, disruption-bounded, incompatible with the
   operator's stock-trader model.
3. **The default account can't be flipped without a human** (CMT-1337's forbidden path).
4. **A structural conflation blocks all of the above:** `configHome` means BOTH "where this
   account's credential lives" AND "which home sessions launch into." Re-pointing splits
   those meanings, so the split must be explicit (§2.2's consumer census) or every
   `configHome` consumer silently breaks.

## 2. Design

### 2.1 The inversion: sessions pick HOMES; the balancer deals ACCOUNTS to homes

- A **config home** is a stable session container (a "slot"). Sessions are pinned to a slot
  for their whole life; `CLAUDE_CONFIG_DIR` never changes post-launch.
- An **account credential** is a movable tenant. The balancer re-deals which credential
  occupies which slot; every session in the slot switches token sources on its next API call
  (E3-proven), with zero awareness.
- The slot set = the N enrolled claude-code homes + the default home (`~/.claude`). The
  default home is one more slot — the default-account flip (CMT-1337) is one swap.
- **Session→account attribution inverts too:** "which account is session S on?" is now a
  ledger read (`tenantOf(slotOf(S))`) at READ time — never the spawn-time
  `subscriptionAccountId` tag, which a swap silently invalidates. §2.2's census routes every
  attribution consumer through this.

### 2.2 The Credential Location Ledger (the bookkeeping core)

A machine-local durable ledger, `state/credential-locations.json`, owned by a new
`CredentialLocationLedger` module:

```jsonc
{
  "version": 3,                       // journal sequence (single-writer; see concurrency)
  "assignments": [
    { "slot": "~/.claude", "accountId": "justin-gmail", "since": "...",
      "lastVerifiedAt": "...", "quarantined": false }
  ],
  "journal": [ /* in-flight + last 50 completed; pruned at commit */ ]
}
```

- **Durability:** atomic tmp+rename writes (the `SubscriptionPool.save` pattern,
  `SubscriptionPool.ts:390-402`). **Corrupt-while-enabled is NOT silent fresh-start** (the
  pool's recovery posture would be catastrophic here): the ledger enters **unknown mode** —
  all swaps refuse (fail-closed for moves), consumers fall back to enrollment `configHome`
  reads WITH one HIGH attention item naming the degradation (fail-open for reads, loudly),
  and recovery is the §2.2 probe rebuild. Never a quiet fallback (No Silent Degradation).
- **Derived, never assumed — via the identity oracle.** Seeding, post-crash recovery, and
  divergence repair resolve each slot's tenant by reading the slot's keychain blob and
  calling `GET api.anthropic.com/api/oauth/profile` with its access token (E4b) — the ONLY
  oracle that reads credential reality (`claude auth status` is disqualified per E4a; config
  `oauthAccount` records are metadata, not truth). If the access token is expired, one
  refresh exchange (the standard funnel) precedes the profile call. Probe results map
  email→accountId via the pool; an **ambiguous match** (two pool records, one email — legal
  under multi-grant) or an **unknown email** REFUSES auto-assignment and raises an attention
  item rather than guessing.
- **RULE 3.1 state-detector registration** (L5): the profile oracle is a new acted-on
  detector — criticality HIGH (drives credential placement), stability good (a versioned
  HTTP JSON endpoint, no TUI scraping), fallback fail-closed (no oracle answer → slot
  treated as unverified, excluded from balancing, attention item; never guessed). A canary
  cross-checks oracle email vs ledger expectation on every scheduled audit probe (§2.4).
- **Single source of truth for location.** The complete consumer census (round-1's main
  haul — every place that treats `configHome` as live location), each re-routed through
  `ledger.slotOf(accountId)` / `ledger.tenantOf(slot)` when the feature is enabled:

  | # | Consumer | Today | Change |
  |---|---|---|---|
  | 1 | `QuotaPoller` token read (`defaultTokenResolver`, `QuotaPoller.ts:108-115`) | reads enrollment home | ledger-resolve accountId→slot |
  | 2 | `QuotaPoller` 401-refresh closure (`QuotaPoller.ts:218`) | refreshes enrollment home — would rotate the WRONG tenant's token and record its usage as this account's | ledger-resolve; plus per-slot write lock (§2.3) |
  | 3 | `QuotaPoller` email auto-patch (`pollAll`, `QuotaPoller.ts:349-356`) | patches account.email from enrollment home's `.claude.json` — after a swap this CROSS-CONTAMINATES pool emails and poisons the recovery probe's email→account mapping | while ledger active: SUPPRESSED; an observed slot-email ≠ expected-tenant-email is surfaced as a divergence signal (attention + re-probe), never written to the pool |
  | 4 | needs-reauth attribution (`QuotaPoller.ts:262-269`) | flags the account whose enrollment home failed | flag the LEDGER tenant of the slot that failed; on any reauth flag involving a re-pointed slot, re-probe via oracle BEFORE surfacing, so the right account is named |
  | 5 | Spawn placement (`SessionManager.ts:1712-1716`, `:1989-1990`, `:3083-3095`) | pins to account's enrollment home | pin to the account's CURRENT slot (sync in-memory ledger read — never disk/parse per spawn, never throws; ledger-unknown → today's behavior) |
  | 6 | Restart-swap family (`QuotaAwareScheduler.ts:195-199` `next.configHome` → `SessionRefresh` → respawn) | restarts into enrollment home — post-swap delivers the session to the WRONG account | one chokepoint: resolve target home through the ledger |
  | 7 | Session→account attribution (`ProactiveSwapMonitor.ts:287-292`, `server.ts:10527-10536` reading spawn-time `subscriptionAccountId`) | stale after any swap of the session's slot | attribution = `tenantOf(slotOf(session))` at read time |
  | 8 | `InUseAccountResolver` (default-home badge; 60s cache) | probes default home via `claude auth status` (E4a: a LYING oracle — reads `.claude.json` `oauthAccount`, stale during the keychain-first/config-second window) | resolve the default-tenant badge from `ledger.tenantOf('~/.claude')`, NOT a re-probe — and bust the cache on any swap touching `~/.claude`. Re-probing `auth status` would re-cache the wrong tenant for 60s during the metadata-repair window (round-2) |
  | 9 | `AccountSwitcher` + `/switch-account` + `QuotaManager.autoMigrate` (`server.ts:946-956`, `QuotaManager.ts:567-580`) | writes cached refresh-token-less blobs into the default keychain entry, outside any bookkeeping — would DESTROY the default slot's tenant lineage | while repointing is enabled: both paths refuse with a named reason pointing at `POST /credentials/set-default` (the correct replacement); their removal rides the deprecation note in §4 |
  | 10 | Enrollment / re-auth wizard (`EnrollmentWizard.ts:191-196` drives `/login` in `login.configHome`) | re-auths into the enrollment home — post-swap overwrites ANOTHER tenant's only blob | re-auth targets the account's CURRENT slot per ledger; a completed enrollment seeds/refreshes the ledger entry for its home |
  | 11 | Dashboard Subscriptions tab (`dashboard/subscriptions.js` — fetches `/subscription-pool`, `/pending-logins`, `/in-use`) | no slot concept | adds a `/credentials/locations` fetch; renders current slot per account + default-tenant badge; graceful when route 503s (dark) |
  | 12 | Pool `configHome` PATCH (`SubscriptionPool.update`, exposed via pool routes) | edits the field freely | refused (409) while repointing is enabled — the field is enrollment metadata, not location |

  Non-claude-code accounts (codex/gemini/pi) are excluded from the ledger, seeding, and
  restore entirely.
- The pool record's `configHome` is reinterpreted as the account's **enrollment slot**.
  No schema change to `subscription-pool.json`.
- **Concurrency model (named, not assumed):** the server process is the ledger's only
  writer; `version` is a journal sequence, not cross-process CAS. One in-process
  **per-slot write lock** serializes every instar credential write, plus one machine-local
  single-mover mutex for swaps (an in-process flag; crash-stale state is cleared by boot
  recovery). Lock order: slot locks (ordered by slot path) → ledger write.
- **The lock must wrap a SOLE FUNNEL, not just the swap executor (round-2 blocking find).**
  Today `refreshClaudeToken` (`OAuthRefresher.ts:205-285`) is a free function — `store.read`
  → `await fetch` (network) → `store.write` — holding NO lock, and `defaultCredentialStore.write`
  is a bare `execFileSync` with no timeout. A per-slot lock that wraps only `CredentialSwapExecutor`
  would leave the QuotaPoller 401-refresh path (census #2) still racing the client and the swap.
  So the lock is introduced as a **structural funnel**: every in-process keychain credential
  write goes through one `CredentialWriteFunnel.withSlotLock(slot, fn)` wrapper. The COMPLETE
  in-process caller set that must route through it (a `grep` for `defaultCredentialStore.write(`
  / `refreshClaudeToken(` callers gates this — enumerate at build, assert in test):
  (1) `CredentialSwapExecutor` (new); (2) QuotaPoller's 401-refresh closure (`QuotaPoller.ts:218`);
  (3) `OAuthRefresher` re-auth / `EnrollmentWizard` completion writes; (4) `AccountSwitcher`
  via `KeychainCredentialProvider.writeCredentials` (§2.7 refuses these while enabled, but the
  funnel still applies for the disabled case). **TWO distinct keychain-write primitives, both
  funnel-routed (round-3 — the enumeration missed one):** the `Claude Code-credentials` default
  entry is written by BOTH `defaultCredentialStore.write` (`OAuthRefresher.ts:150`, argv
  `add-generic-password`) AND `KeychainCredentialProvider.writeCredentials`
  (`CredentialProvider.ts:137`, the `security -i` STDIN-script form). The funnel set and the
  lint MUST name both. The **lint forbids, outside the funnel:** (a) `defaultCredentialStore.write`,
  (b) `KeychainCredentialProvider.writeCredentials`, and (c) a string-literal `add-generic-password`
  match SCOPED to the `Claude Code-credentials` service / the two credential-write primitives
  (catching the `security -i` stdin form an argv-only AST walk would miss — the
  SafeGitExecutor/SafeFsExecutor single-funnel precedent). Scoping avoids false-positives on the
  four UNRELATED keychain writers that use distinct services (`WorktreeKeyVault`,
  `SecretStore`, `GlobalSecretStore`, `RemediationKeyVault` — none touch Claude credentials). Otherwise a future direct
  `writeCredentials` caller re-opens the exact bypass §2.7 closes. The CLIENT (Claude Code itself) is the one writer
  the in-process lock CANNOT cover — it is handled by §2.3's source-slot CAS + identity-audit
  heal, never by the lock. This converts "FIXES the pre-existing race" from aspiration (rev 2)
  into a structurally-enforced funnel.
- **Bounded under the lock (round-3 — the funnel wraps an `await fetch`).** `refreshClaudeToken`
  is `read → await fetch → write` and the fetch hits the token endpoint over the network WHILE
  holding the slot lock; it has no timeout today, so a hung TLS connect would hold the lock
  indefinitely and starve a same-slot wall-rescue swap. The funnel therefore mandates (a) the
  refresh fetch carries a bounded `AbortSignal.timeout`, and (b) lock acquisition is a
  **try-lock-with-timeout** → on expiry the caller skips with a named reason rather than blocking
  forever. A slow network degrades to a skipped action, never a wedged slot. A lock-timeout skip
  on the QuotaPoller refresh path returns NO-SNAPSHOT (one missed quota reading this cycle),
  NEVER `markNeedsReauth` — a swap-in-progress on the slot is not a dead login, and the client
  refreshes its own credential independently (E3), so a skipped poller-refresh never leaves a
  session's credential stale.

### 2.3 The swap primitive — staged exchange, identity-verified, repair-safe

`CredentialSwapExecutor.swap(slotA, slotB)` exchanges the two slots' credentials. Exchange —
never copy — keeps the §0.d invariant by construction for the swap itself.

Steps (each audited; all `security` calls via async `execFile` with a 10s timeout — the
existing sync funnel can wedge the whole event loop on a locked keychain; a timeout before
the first destructive write aborts the swap untouched):

1. **Preconditions.** Slot/account params resolve by **exact membership** in the ledger's
   enumerated slot/account set BEFORE any path expansion (`expandHome`/`claudeCredentialService`/
   fs call) — a value not `===` a known slot/accountId is rejected 400 (without this, the route
   is an arbitrary keychain-service / filesystem-path write primitive, since
   `claudeCredentialService(home)` hashes whatever path it is handed); neither tenant
   `needs-reauth`/`disabled`/quarantined; no swap in flight (single-mover); per-slot locks
   acquired; both blobs re-read fresh, parse, and carry refresh tokens.
1a. **Source-slot CAS re-read immediately before the destructive write (round-2 blocking
   find — the source-slot client-write race).** The gap between step-1's fresh read and step-3's
   overwrite is a TOCTOU window: the live Claude client in either slot can hit a 401, refresh,
   and write a freshly-ROTATED blob back to that slot WITHIN the window (the in-process lock
   cannot stop the external client). If step 3 then writes the step-1 (pre-rotation) staged copy
   over it, the rotated lineage is stranded and identity-only verify (step 4) cannot see it (the
   stale blob's access token is still valid for ~8h). So: immediately before staging/overwriting
   each slot, RE-READ that slot's on-disk blob and compare to the step-1 read. If it changed and
   the new blob parses + identity-matches the SAME tenant, ADOPT the newer blob as the thing to
   stage/move (it is the client's rotated copy) — never carry a blob older than what is currently
   on disk. The window is narrowed to (final-re-read → write), not closable to zero against an
   external writer — §2.3.6's freshness-verify + audit catch the residual, honestly stated.
2. **Staging escrow (crash-proofing — round 1's top adversarial find).** Without escrow, a
   crash between the two destructive writes leaves blob A ONLY in dead process memory —
   destroyed, unrecoverable, plus a §0.d duplicate of blob B. So: **COPY** blob A (the step-1a
   re-read, freshest) to a staging keychain entry (`instar-credential-swap-staging-<swapId>`,
   `swapId` a random/sequence id deriving from NO token bytes) — a copy, NOT a move: slot A is
   left untouched until step 3's first write, which is what makes the crash-before-step-3 unwind
   a true no-op. THEN journal `{swapId, slotA, slotB, accountA, accountB, stagingRef,
   phase:"begin"}` (a location reference — never token material). The staging service namespace
   (`instar-credential-swap-staging-*`) is GUARANTEED disjoint from every `claudeCredentialService(home)`
   output (always `Claude Code-credentials[-<8hex>]`) — pinned as an invariant with a §5 test —
   so no `claude` client and no QuotaPoller ever reads a staged copy (staging is not a config
   home; §0.d's "readable from two config HOMES" hazard cannot trigger from staging). A single
   `security add-generic-password -U` is atomic at the keychain API (no torn/partial blob), so
   the only staging hazard is staleness, handled by step 6's adopt-on-newer recovery. **Staging
   is retained until step 6's delayed re-verify passes** (round-2: NOT deleted at commit — see
   step 5), and a boot-recovery sweep deletes any orphan staging entry with no matching journal
   row. **Sweep predicate (round-3):** a staging entry is protected by ANY journal phase that is
   not `done` — `begin` AND `committed` both keep their staging alive (staging is the step-6 heal
   source through commit); only a `done` row (or no row at all) makes its staging an orphan. A
   literal "in-flight = begin only" reading would let the sweep delete a `committed` row's staging
   and remove the heal source, re-opening the rev-2 lost-source bug step 5 fixed. Recovery decidability: staging present + journal in-flight → resolve via step 6's
   adopt-on-newer rule (never a blind staging overwrite); journal present but no staging →
   nothing destructive happened, unwind is a no-op.
3. **The exchange.** Write blob B → slot A's store; write blob A (from staging) → slot B's
   store. Then exchange the two homes' config `oauthAccount` blocks — **keychain first,
   config second** (the credential is the record of truth; metadata follows), config writes
   tmp+rename, and for the DEFAULT slot the canonical file is `~/.claude.json` (home-root —
   `readAccountEmail`'s default-home path, `QuotaPoller.ts:124-140`), not
   `~/.claude/.claude.json`. A config-write failure after a successful keychain exchange is
   a REPAIRABLE METADATA condition (retry, then attention item) — never quarantine.
   **Crash point between the two keychain writes (round-2 — enumerated explicitly):** if the
   process dies after `B→slotA` but before `A→slotB`, then slot A holds B, slot B still holds
   A, and staging also holds A — blob A is momentarily readable from slot B AND staging. This
   is NOT a §0.d violation (staging is not a config home; only slot B is, and it holds exactly
   one lineage) — but if the client refreshes slot B in this window it rotates A and strands
   staging's copy. Recovery therefore does NOT blind-write staging→slotB: it applies step 6's
   adopt-on-newer rule (re-read slot B first; if it already parses + identity-matches A, the
   client healed it — adopt, don't overwrite). The journal `begin` row + the two slots' on-disk
   reads make this crash point fully decidable.
4. **Verify — on ACCOUNT IDENTITY, never token bytes.** Round 1 killed rev-1's
   refresh-token-identity check: rotation makes token bytes unstable, and "repair from
   memory" on a byte mismatch would OVERWRITE a legitimately-rotated newer credential with a
   stale one — manufacturing the §0.d stranding it exists to prevent. Instead: read both
   stores back; each must parse and its **oracle identity (E4b profile call) must match the
   expected tenant**. Token-bytes-differ-but-identity-matches → ADOPT the on-disk blob (it
   is newer); never write a blob older than what was just read. Identity mismatch →
   re-read-compare-and-swap repair from staging/fresh-read (never from a stale memory copy),
   re-verify; still wrong → quarantine the slot (ledger-flagged, excluded from balancing,
   ONE attention item), leave the other slot consistent.
   **Oracle-UNAVAILABLE during verify is NOT the same as identity-MISMATCH (round-2 material —
   the single most dangerous ambiguity in rev 2).** An unreachable/slow/5xx/429 oracle MUST
   read as "unverified", NEVER as "doesn't match" — an oracle outage during a swap must never
   trigger a destructive repair (that path could cascade into repair-storms against healthy
   blobs). On oracle-unavailable at verify: do NOT repair, do NOT write; quarantine the slot
   (excluded from balancing, attention item), stop, and let the scheduled re-probe (§2.4) clear
   it when the oracle returns. Repair is reserved for a CONFIRMED identity mismatch with a
   reachable oracle.
   **Identity match is necessary but the residual strand (§2.3.1a) is identity-blind.** A blob
   carrying the RIGHT tenant identity but a STALE (server-rotated) refresh token passes the
   identity oracle yet is doomed at next expiry. Verify therefore also records each slot's
   freshness expectation; the always-on identity audit (§2.4) plus the §2.3.6 delayed re-verify
   are what catch a strand that identity alone cannot. The spec does not over-claim that
   identity-verify proves refreshability — it proves ownership only (stated honestly).
5. **Commit (staging RETAINED — round-2 material).** Journal phase → `"committed"`,
   assignments + `lastVerifiedAt` updated, completed entries pruned (keep in-flight + last 50;
   full history lives in `logs/credential-swaps.jsonl`, size-rotated). **Staging is NOT deleted
   here.** Rev 2 deleted staging at commit — but a client write-back landing between commit and
   the step-6 re-verify can clobber slot B's only on-disk copy, and "heal by re-running the
   move" then has NO non-stale source (the displaced blob is gone). Retaining staging through
   step 6 keeps a recovery source for exactly that window.
6. **Delayed re-verify, then staging delete.** A client whose refresh exchange was in flight
   DURING the swap lands its write after step 4 passes — the window is the client's full network
   round-trip (seconds), not milliseconds, and starts before the swap began. So: one re-verify
   of both slots ~90s after commit (oracle identity). **Scope honesty (round-2):** 90s covers
   only the sub-2-minute IN-FLIGHT refresh — it does NOT cover the §0.c at-expiry write-back
   (hours later); that long-tail case is the always-on identity audit's job (§2.4), not this
   check. A detected write-back (old tenant's lineage re-appeared) is healed by re-running the
   directed move with the CURRENT on-disk blobs and the adopt-on-newer rule (re-read each slot
   first; never overwrite a newer rotated blob with staging's older copy); the displaced rotated
   blob is parked and its account re-probed via the oracle before any needs-reauth is surfaced —
   so the RIGHT account gets flagged if one truly died. **Only after step 6 verify passes is
   staging deleted** and the journal phase set `"done"`. If the client genuinely clobbered slot
   B and the on-disk blob is unrecoverable, the honest outcome is "account B needs-reauth" with
   the correct account flagged (blast radius: one re-auth — §6) — the mechanism does not pretend
   this is always non-destructively healable.

**Boot-recovery window:** journal-in-flight slots are excluded from spawn placement, quota
polling, and balancing until recovery resolves them (fail-closed for the two slots in
question; every other slot unaffected). Recovery *probes* (read-only oracle calls) run outside
the single-mover mutex, but **recovery WRITES (step-6 heal, quarantine repair) acquire the
single-mover mutex AND the per-slot locks** like any swap (round-2 material: rev 2 ran recovery
writes "outside the mutex", racing a boot-time balancer pass on the shared ledger write). The
balancer's FIRST pass after boot is gated on a **recovery-complete barrier** so it cannot start
a swap on a different slot pair while recovery is still healing — eliminating the unmutexed
write-write race on the ledger. **Hang-safety (round-3 — crash-safe ≠ hang-safe):** the barrier
carries a bounded TIMEOUT. If a recovery write itself WEDGES (a keychain ACL prompt on the
default slot — the livetest-(b) hazard — or a hung funnel fetch), an in-process hang clears no
in-process flag, so the barrier would otherwise stay up forever and the balancer never starts.
On barrier-timeout: mark the unresolved in-flight slots quarantined/excluded and LIFT the barrier
so the balancer runs on the healthy remainder (fail-closed for the wedged slots only — quarantine
is set BEFORE the lift, so the post-lift balancer structurally cannot select a wedged slot,
§2.4 eligibility). Barrier-lift does NOT kill an in-process hung recovery WRITE — what actually
releases the held mutex/lock is the per-write execFile 10s timeout (the "all `security` calls via
async execFile with a 10s timeout" rule applies to RECOVERY writes too, not just swap writes), so
the keychain-ACL-prompt arm is bounded by that timeout, not by the barrier-lift alone. Note
recovery completion is independent of `dryRun`: a swap that
already journaled `begin`/`committed` is FINISHED for crash-safety regardless of the dryRun flag
(dryRun gates NEW decisions, never the completion of an already-begun exchange — stated so an
operator does not assume "dryRun = zero writes ever"; §2.8).

**Operator `/login` reconciliation (exogenous writes).** A probe/verify mismatch where the
on-disk blob is a VALID credential for a known pool account that the executor did not write
→ **ADOPT** (update the ledger to reality; info-level attention item "default login changed
externally; ledger reconciled") — never repair-over, never quarantine. The operator changing
their own login is legitimate reality, not corruption. Repair/quarantine is reserved for
unparseable blobs and expected-write-failure states. If adoption produces a duplicate
accountId (two slots claiming one account — possible iff the operator logged the same
account in twice = two grants), the most-recently-verified slot keeps the assignment and the
other is re-probed, refused auto-assignment on ambiguity, and surfaced.

### 2.4 The balancer — the stock-trader loop

A periodic pass (default every 5 min, clamp [1 min, 60 min]) in `CredentialRebalancer`:

- **Inputs** (read-only): per-account `lastQuota` + `measuredAt`, burn rates, per-slot live
  session count + recent activity (v1: tmux activity timestamps — ~5ms/slot; TokenLedger
  integration deferred <!-- tracked: CMT-1335 --> to Increment B, the autonomous drain balancer; v1 uses tmux activity, TokenLedger is a later refinement), ledger state. **A pass with no actuation performs zero keychain/CLI
  operations** (explicit invariant).
- **Objective**, in priority order:
  1. **Wall avoidance:** a slot whose tenant exceeds the high-water mark (default 85%
     measured on EITHER window, clamp [50,99]) gets the highest-headroom eligible account.
     **Wall-override (round-2 — rescue must not starve behind drain's anti-churn guards):** a
     distinct CRITICAL mark (default 95%, clamp [85,99]) marks an imminent wall, not noise. A
     rescue at the critical mark BYPASSES the per-pair cooldown, the per-tenant cooldown, AND
     the 1-swap-per-pass cap (a wall is a certain loss; the cooldowns exist to suppress noise,
     and a critical reading is not noise). The forced move is audited as `forced:wall-override`.
     Without this, a session burning between 15-min polls can cross 85%→100% while the only
     viable rescue account sits under a 30-min tenant cooldown it earned doing a low-priority
     drain — the priority-1 objective losing to a priority-2 guard.
     **Its own cap (round-3, §0.g — the bypass was uncapped).** Bypassing the cooldowns does NOT
     mean unbounded forced swaps: the override (i) still respects the **fresh-data gate** (one
     override per slot per sensor reading — it acts on a NEW critical reading, never re-fires on
     the same 15-min snapshot); (ii) is bounded by `maxForcedSwapsPerPass` (default 1, clamp
     [1,N-slots]) — with K>cap slots simultaneously critical, the worst is rescued this pass and
     the next-worst on the next pass (≤ one pass-interval, default 5 min, well inside the margin
     the 95% mark buys); and (iii) carries a `maxForcedOverridesPerWindow` ceiling — when hit
     (a thrashing slot the rescue can't durably help), it STOPS, opens a DegradationReporter
     entry + ONE attention item ("wall-override budget exhausted — no durable rescue available"),
     never loops. "No eligible non-walling target exists" is likewise a SURFACED terminal state,
     not an infinite retry. P19 only catches FAILED swaps; these succeed, so this ceiling is the
     loop-breaker the breaker can't be.
     **Target must be VERIFIED-recent, even on the skip-pre-verify wall path (round-3 material —
     a fresh quota reading does NOT imply a live credential).** Wall posture skips the *blocking*
     oracle pre-verify (§2.4 oracle-split) but MUST still gate rescue-target eligibility on the
     target's most-recent identity result: a slot whose `lastVerifiedAt` is within the audit
     cadence AND whose last audit did not flag divergence is a valid target; a target whose last
     verify is stale/unknown/failed is NOT eligible for a wall rescue. Without this, the balancer
     can deal a just-died account (quota-fresh, credential-dead) into the live slot it was trying
     to save — the next API call 401s into needs-reauth, and the post-commit verify then
     quarantines the VICTIM slot. "Act toward acting" weakens latency-tolerance, it does not
     abandon liveness: prefer the highest-headroom target that ALSO passed the most recent
     scheduled audit; never deal a target with no/failed recent identity check.
     **Honest residual (round-4): the recency gate NARROWS, it does not CLOSE.** A target that
     passed its last audit cleanly but DIED AFTER it (operator revoked the grant; a stranded
     refresh token) — within the audit-cadence window, on the wall path that skips the blocking
     pre-verify — can still be dealt into the live slot; the next API call 401s into needs-reauth
     and post-commit verify quarantines the VICTIM slot. The bounded blast radius is exactly
     that: the rescued slot quarantined + one account needs re-auth — NOT silent (§2.3.6
     re-verify + post-commit verify surface it), and the session was ALREADY walling, so the
     downside vs not-acting is "quarantined-and-flagged" vs "walled anyway." This is a §6 risk
     row, stated honestly — NOT a case the recency gate eliminates. (A blocking pre-verify would
     close it but re-introduces the oracle-outage-walls-a-session inversion the §2.4 split exists
     to avoid; the cost asymmetry still favors act-toward, and this residual is the accepted price.)
  2. **Use-it-or-lose-it drain:** an account whose WEEKLY window resets soon (default ≤24h,
     clamp [1,96]) with unused headroom ≥30% gets dealt to the busiest slot. Weekly only —
     5h windows regenerate all day (rev-7's hardest-won finding). A drain-placed tenant is
     EXEMPT from objective-1 eviction unless its weekly window is at risk (round 1 found the
     drain→5h-wall→evict→re-drain ping-pong; the exemption breaks it). **Symmetric exemption
     (round-2 — the 3-way drain rotation resurfacing inside objective 2):** with ≥3 accounts
     whose weekly windows reset within the same horizon, the "most-reset-proximate" drain
     target reorders across passes (X→Y→Z), and each re-deal is itself a DRAIN (not an
     objective-1 eviction), so rev 2's exemption — scoped only to objective-1 — did not stop
     it. Fix: a slot holding a drain-placed tenant carries a **per-slot "drain in progress"
     hold** and is exempt from being re-targeted as a drain DESTINATION until its drain
     completes or its window resets. Draining fragments the very window it means to use if the
     busiest slot's tenant changes every 30 min; the hold makes a drain commit to one tenant.
  3. **Default-slot preference:** keep the designated default account in `~/.claude` when
     neither (1) nor (2) overrides, so manual `claude` invocations land predictably. The
     swap-back must also clear `minScoreDelta` (no below-floor ping-pong).
- **Precedence note:** "busiest slot" (drain target selection) and the mid-burst avoidance
  preference pull the same signal opposite ways; precedence is explicit — drain targets the
  busiest slot, and avoidance only orders WHICH of multiple eligible candidates moves first.
  Avoidance is a preference, never a veto (this is NOT rev-7 idle-detection).
- **Hysteresis, not budgets** (operator directive: no restart-style movement caps). The
  floors any lag-sensored controller needs:
  - actuation cap: **1 swap per pass** (acting twice on one 15-min reading is noise);
  - per-PAIR cooldown derived from the configured poll interval (≥1× `pollIntervalMs`,
    default 15 min — rev-1's "10 min = one poll period" was numerically wrong);
  - per-TENANT cooldown (≥2× poll interval) — the rev-7 3-way-rotation attack defeats
    pairwise cooldowns (X,Y)→(Y,Z)→(Z,X); a tenant cooldown does not;
  - **fresh-data gate:** a pair may act only if both tenants' `measuredAt` is newer than
    their last actuation (one actuation per sensor reading, robust to retuned intervals);
  - minimum improvement: `minScoreDelta` (default 10, clamp [0,1000]) computed with urgency
    clamped at 4h-to-reset (raw `1/hoursUntilReset` explodes near reset and makes any delta
    floor meaningless in exactly the drain-active hours).
- **Eligibility:** `needs-reauth`/`disabled`/quarantined tenants and unverified slots never
  participate. Stale quota (>2 poll periods) → that account participates as a SOURCE only
  (its slot may be rescued), never as a swap-in TARGET (stale headroom may mask a wall —
  the anti-conservative direction).
- **Oracle posture split BY OBJECTIVE (round-2 material — fail-closed inverts the wall
  objective).** Pre-swap oracle verify behaves OPPOSITELY for the two objectives because the
  cost asymmetry is opposite: for a **drain** (objective 2), an unavailable/slow oracle →
  fail-CLOSED (skip — worst case is unused headroom, a soft loss; never move a lineage you
  can't verify). For **wall-avoidance** (objective 1, and especially a critical-mark override),
  the cost of NOT acting is the exact failure the objective prevents (a dead session), while
  the risk of acting on ledger+quota truth WITHOUT a blocking pre-verify is bounded — §2.3.6's
  post-commit delayed re-verify + identity repair still run and heal a rare misplacement. So a
  wall-avoidance swap **acts on ledger+quota truth without blocking on the oracle pre-verify**
  (the oracle call is best-effort with a short timeout that fails TOWARD acting), trusting the
  post-commit verify to catch the rare wrong placement. This is the concrete answer to
  open-question 2: degrade the verify posture per-objective, do not globally pause. Note this is
  consistent with step-4's "oracle-unavailable → quarantine, never repair": the wall path skips
  the PRE-verify but still runs the POST-commit verify, and an unreachable oracle there
  quarantines (never repairs) — it never manufactures a destructive write.
- **Dead/quarantined default tenant eviction** (the case preconditions would otherwise
  freeze): if the DEFAULT slot's tenant goes needs-reauth **OR the default slot is quarantined**
  (round-2: rev 2 keyed only on needs-reauth, leaving a quarantined `~/.claude` frozen — the one
  slot that must never be empty was also the one eligibility most aggressively excludes), a
  one-directional move deals a healthy VERIFIED tenant into `~/.claude` and parks the dead/
  quarantined blob in the vacated slot, with an attention item — goal 3's "manual `claude` keeps
  working" beats slot symmetry and beats the quarantine-exclusion rule for the default slot
  specifically. The displaced account still needs operator re-auth / re-probe eventually (the
  irreducible residual, stated honestly). **Bounded + fallback (round-3, §0.g):** (i) the
  eviction target is identity-verified THIS pass BEFORE the move (a "healthy per stale ledger"
  target that is actually dead would otherwise get dealt into `~/.claude` and re-quarantine it —
  a dead-default loop); (ii) consecutive forced default evictions are P19-capped — a dead-target
  loop opens a breaker + attention item instead of churning the one slot that must stay alive;
  (iii) **correlated-oracle-outage floor:** when NO slot is currently oracle-verifiable (an
  `api.anthropic.com` 5xx/429 storm quarantines every probed slot at once — §2.3.4 quarantines
  on *unavailable*, not just mismatch), the default slot is NOT left dead: it is served by its
  last-known-good tenant (the most-recently-previously-verified assignment), with an attention
  item, and NO further eviction fires until the oracle returns. An unreachable oracle must never
  empty `~/.claude` — losing manual `claude` because a probe endpoint is merely down is the
  wrong failure direction. **Honest bound (round-4): non-empty ≠ guaranteed-working.** A
  correlated outage ("no slot oracle-verifiable") is observationally identical to "every grant
  died at once", so last-known-good MIGHT itself be dead — the floor cannot distinguish them
  (the oracle is the only liveness signal and it is down, by construction). The floor's real
  guarantee is therefore "preserve the last KNOWN-GOOD assignment + surface an attention item",
  NOT "manual `claude` is working" — it avoids making things worse (never empties/churns the
  default during an outage) but cannot certify the credential is live. Stated as the floor's
  actual guarantee rather than over-claimed as continuity.
- **P19 breaker:** N consecutive failed swap attempts (default 3) opens a breaker — the
  balancer stops actuating, reports ONCE via DegradationReporter, and retries on the next
  quota-poll-fresh pass; the §5 sustained-failure test asserts attempt count + per-attempt
  cost against a permanently-failing keychain.
- **Quarantine exit:** a quarantined slot is re-probed (oracle) on each subsequent pass, off
  the critical path; a clean identity probe + parseable blob auto-clears quarantine and
  reconciles the ledger (adopt rule). The attention item notes auto-recovery is possible.
- **Supervision tier (P7):** Tier 0, justified — a deterministic policy over enumerable
  numeric thresholds (P2 shape), every decision audited (§2.9), no LLM in the loop, and the
  blast radius of a wrong decision is a reversible swap verified by the oracle.
- **Manual levers:** `POST /credentials/swap {slotA, slotB}` and
  `POST /credentials/set-default {accountId}` (= swap into `~/.claude`; CMT-1337's
  zero-touch flip) and `POST /credentials/restore-enrollment`. All Bearer-authenticated.
  **Authority posture (signal-vs-authority, decided):** the pool is single-operator and the
  operator's standing directive is maximum autonomy — so the levers stay agent-callable, and
  the control is DETECTIVE, structural, and non-suppressible: every manual-lever invocation
  emits an operator notification naming what flipped (set-default additionally posts to the
  Updates topic), every invocation is audited, slot/account params validate against
  known-ledger values (400 otherwise), manual swaps respect the per-pair cooldown by default
  (`force:true` overrides; the override itself is flagged in the audit + notification), and
  a rapid-loop guard raises ONE deduped attention item. **Per §0.g the `force:true` bypass
  carries its OWN budget (round-4 self-consistency):** a `maxForcedManualSwapsPerWindow` ceiling
  whose exhaustion refuses further forced manual swaps until the window rolls (the rapid-loop
  guard gave only detection §0.g(c), not a budget §0.g(a) — this makes `force` not the one
  uncapped bypass left in the spec; under single-operator autonomy the ceiling is generous, not
  restrictive). PIN-gating was considered (mandate
  precedent) and rejected as contradicting the operator's autonomy directive; revisit at
  fleet rollout where multi-operator pools exist. **Accepted risk, stated explicitly
  (round-2):** under single-operator, a compromised Bearer token + these levers lets an
  attacker reshuffle the operator's OWN accounts among the operator's OWN slots (a reversible,
  oracle-verified permutation — NOT exfiltration; no token material is ever returned) and flip
  the default account (the notification fires, but to the same operator's channel). This is an
  accepted residual of the autonomy posture; it is named here rather than left implicit, and
  it is the concrete reason PIN-gating returns on the multi-operator-fleet review.

### 2.5 Robustness comparison — one-account-for-all vs spread (the delegated decision)

- **(i) Single-account convergence** — impossible under §0.d (one lineage can't occupy
  multiple slots) and even approximated (all sessions one slot) it concentrates the fleet
  onto one wall. See also §0.e alt-4.
- **(ii) Spread-across-accounts** — each slot a distinct tenant; the balancer permutes;
  failure isolation (one dead credential = one slot degraded); per-window steering.

**Decision: (ii) spread** — structurally enforced by exchange-not-copy, more robust under
partial failure, and the only shape that can express the drain objective.

### 2.6 Multi-machine boundary

Entirely machine-local: keychains, slots, sessions, poller, ledger are all per-machine
(`SubscriptionPool` decision 1A — per-machine enrollment = independent grant lineages; §0.d
is never violated ACROSS machines by construction). The balancer runs on every machine over
its own slots. One grounding correction from round 1: the capacity heartbeat's `quotaState`
is NOT fed by the per-account QuotaPoller — it is `QuotaTracker` state written by
`QuotaCollector` reading the **default home's** credential (`server.ts:3915-3922`,
`:11138-11160`). A default-slot swap therefore changes which account the machine-level
tracker measures: the executor's commit step (default-slot swaps only) invalidates/refreshes
`quota-state.json` and busts the `InUseAccountResolver` cache so the discontinuity is
attributed, not mistaken for a quota cliff. `quotaState` carries no account identity across
machines (`types.ts:1878`), so no remote consumer is affected.

### 2.7 The legacy movers (explicitly disposed, not "untouched")

Rev 1 said the restart-swap family "remains untouched"; round 1 proved that false — after one
balancer swap, its enrollment-home targeting delivers sessions to wrong accounts and its
spawn-time attribution lies (census #6, #7). Disposition:

- **Restart-swap family** (`ProactiveSwapMonitor`, `onQuotaPressure`, `SessionRefresh`):
  KEPT as the fallback for what re-pointing can't fix (broken home, poisoned transcript) —
  but its home resolution and session attribution route through the ledger (census #6, #7).
- **Double-mover interlock (the REAL trace, replacing rev-1's vapor "machine-global marker"
  — no such marker exists in the tree; `SessionRefresh.inFlight` is a private per-session
  Set, `SessionRefresh.ts:177`):** a new slot-keyed in-flight registry; the swap executor
  AND any `SessionRefresh` carrying `accountSwap` acquire the involved slots before acting;
  acquisition order = slot-path order; second acquirer waits or skips with a named reason.
  A credential swap touches no session, so the restart-oriented sentinel markers are NOT
  registered (mechanism-momentum removed; §0.f).
- **AccountSwitcher / `/switch-account` / `autoMigrate`** (census #9): refuse with a named
  reason while repointing is enabled; deprecation path in §4. **Hazard corrected + refusal
  relocated (round-2 material):** rev 2 called these "refresh-token-less blobs", but
  `CredentialProvider.writeCredentials` does `{...existingData.claudeAiOauth, accessToken,
  expiresAt}` — it MERGES, PRESERVING the existing default entry's refreshToken. So switching
  to account B over a default entry holding account A produces a **Frankenstein blob: B's
  access token grafted onto A's refresh token**. On first refresh the client exchanges A's
  refresh token and writes A's lineage back into the default slot — silently resurrecting A and
  rotating/stranding A's grant from wherever the ledger placed it. This is a §0.d violation
  injected from OUTSIDE the swap protocol, and stealthier than "refresh-token-less" (which would
  just fail to refresh → visible needs-reauth). The refusal is therefore load-bearing AND must
  live INSIDE `AccountSwitcher.switchAccount` (or `CredentialProvider.writeCredentials` against
  the default service when the ledger owns that slot) — NOT only on the two known routes
  (`/switch-account`, `autoMigrate`). A route-level-only guard is exactly the "every item a
  unique source" dodge the flood-ceiling lesson warns against, applied to credential writes:
  any future caller of `AccountSwitcher` would bypass it. Manager-level refusal is the funnel
  (composes with §2.2's `CredentialWriteFunnel` lint).

### 2.8 Ships dark + dev-agent dogfood + rollback

- Config: `subscriptionPool.credentialRepointing` `{ enabled: false, dryRun: true,
  balancer: {...}, manualLeversEnabled }` — all five balancer knobs carry the clamps in §2.4;
  out-of-range values clamp-and-log at startup (never silently honored, never fatal).
- **Dev-gate mechanics (round-2 BLOCKING — rev 2's registry was wrong).** Rev 2 said register
  in `DEV_GATED_FEATURES` with `enabled` OMITTED. That is mechanically wrong and dangerous:
  `resolveDevAgentGate` is `explicitEnabled ?? !!config.developmentAgent` (`devAgentGate.ts:44`),
  so an omitted `enabled` resolves **LIVE on Echo with credential WRITES the instant it's wired**
  — defeating the entire dry-run-first posture — and `DEV_GATED_FEATURES`' own header explicitly
  EXCLUDES destructive/cost-bearing features. The real `agentWorktreeReaper` precedent lives in
  **`DARK_GATE_EXCLUSIONS`** (category `destructive`) with hardcoded `enabled: false` +
  `dryRun: true` for EVERYONE including dev. Corrected: this feature registers in
  **`DARK_GATE_EXCLUSIONS` as `destructive`**, config carries EXPLICIT `enabled: false` +
  `dryRun: true` defaults (which `scripts/lint-dev-agent-dark-gate.js` assertion C requires for
  any literal `enabled:false`). Going live-on-Echo then requires a DELIBERATE flip of BOTH
  `enabled:true` AND `dryRun:false` — exactly the staged dogfood the prose describes:
  **dry-run-first on Echo** (full decision loop, zero writes, decisions audited — Increment A's
  levers may go live before Increment B's autonomous balancer per §0.e alt-5), promoted to
  live-on-Echo only after the §5 livetest battery passes AND a dry-run observation window shows
  sane decisions; fleet stays dark. Registered on the Graduated Feature Rollout / maturation
  track as a DURABLE entry (named track artifact, not a private intention) with a
  promotion-review cadence (Close the Loop — dark features don't rot in the dark).
- **AMENDMENT 2026-06-13 (operator directive, topic 20905 — "NONE of this should be dark for
  development agents").** The R2 correction above conflated two SEPARATE flags: `enabled` (is the
  feature alive?) and `dryRun` (does it WRITE?). R2's fear — "omitted-enabled in DEV_GATED_FEATURES
  resolves LIVE on Echo with credential WRITES the instant it's wired" — is FALSE while `dryRun`
  defaults true: the executor's dry-run gate (`CredentialSwapExecutor`, outcome `dry-run`) returns
  BEFORE any keychain/config write, so live-on-dev runs the full decision loop + audits what it
  WOULD do but performs ZERO writes. Per the operator directive, the feature is therefore re-gated
  to the **developmentAgent gate**: `enabled` is OMITTED so `resolveDevAgentGate` resolves it LIVE
  on a dev agent + DARK on the fleet (the same dry-run-canary posture as `topicProfiles` /
  `threadline.singleNegotiator`). The destructive WRITE remains gated by the SEPARATE `dryRun:true`
  default; promotion to real writes (`dryRun:false`) still requires the §5 livetest + the operator's
  deliberate flip. This delivers the dogfooding R2's dark-for-everyone choice sacrificed, WITHOUT
  exposing real credential writes. (Migration: `PostUpdateMigrator.migrateConfigCredentialRepointingDevGate`
  strips a default-shaped `enabled:false` from existing agents so the gate resolves; an explicit
  operator `enabled:true` is preserved.)
- Rollback, ORDERED (round 1 caught the trap): `enabled: false` stops the balancer and
  levers (503) but the ledger REMAINS the read-resolution source whenever its assignments
  differ from enrollment ("disabled stops MOVES, never READS") — a dark-fallback to raw
  `configHome` reads after swaps have happened would silently re-create the wrong-tokens
  bug. Full teardown = `POST /credentials/restore-enrollment` (N ordinary §2.3 swaps back to
  enrollment layout; skips non-claude accounts; per-swap escrow applies) THEN dark, at which
  point ledger == enrollment and raw reads are truthful again. The disable path documents
  this ordering and the status route names the state (`dark-with-divergent-ledger`).
  **restore-enrollment must operate ON quarantined slots (round-2 material — open-question 4
  resolved).** rev 2's §2.3 step-1 preconditions refuse any swap whose tenant is quarantined —
  which would HARD-BLOCK restore-enrollment in exactly the degraded state that motivates
  rollback. restore-enrollment is a TEARDOWN, not a balancing move: it carries a quarantine
  BYPASS in its preconditions, moving the slot back to enrollment layout and parking any
  displaced quarantined blob with an attention item. It requires quiescence of the BALANCER
  (single-mover mutex serializes it against live swaps) but does NOT refuse on quarantine.
  **Bypass scoped to the `quarantined` FLAG ONLY (round-3, §0.g):** it RETAINS the §2.3.1
  parse + refresh-token-present precondition. An UNPARSEABLE quarantined blob (corrupt entry,
  truncated write, a Frankenstein blob from a legacy `AccountSwitcher` slip) is parked
  **one-directionally** — moved OUT / the slot vacated for operator re-auth — and is NEVER
  EXCHANGED into a healthy enrollment slot (a teardown that exchanges garbage into a good slot,
  then post-commit-verify quarantines THAT slot, would spread corruption during the exact
  degraded state rollback exists for). Quarantine-bypass drops the quarantine refusal; it drops
  nothing else. **Parseable-but-incoherent is ALSO parked one-directionally (round-4 — the
  Frankenstein gap).** "Parses + has a refresh token" is NOT sufficient: the §2.7 Frankenstein
  blob (B's access token grafted onto A's preserved refresh token) parses, carries a refresh
  token, and oracle-resolves (on B's still-valid access token) to B — yet is a §0.d violation
  waiting to resurrect A on first refresh. So restore-enrollment adds an IDENTITY-COHERENCE check
  before any exchange: the blob's access-token identity (oracle) must equal its refresh-token
  lineage's expected account. Cheap proxy when the oracle is down: compare against the ledger's
  expected tenant for the slot and flag any blob whose recorded provenance is inconsistent. A
  blob that fails coherence (Frankenstein, revoked-grant, access/refresh tenant mismatch) is
  parked ONE-DIRECTIONALLY exactly like an unparseable one — NEVER exchanged into a healthy slot.
  The retained precondition is "parses AND has a refresh token AND is identity-coherent", not
  just the first two.

### 2.9 Observability (Observable Intelligence + Token-Audit Completeness)

- `GET /credentials/locations` — ledger: slot ↔ account, since, lastVerifiedAt, quarantine,
  journal tail, mode (`active` / `unknown` / `dark-with-divergent-ledger`).
- `GET /credentials/rebalancer` — last pass: inputs, decision (or per-slot named no-op
  reason — structural-no-op surfacing), breaker state, next pass ETA.
- Every swap step, verify result, adopt/repair, quarantine enter/exit, breaker transition,
  and lever invocation → `logs/credential-swaps.jsonl` (size-rotated) + feature-metrics
  attribution (`attribution.component: 'credential-rebalancer'`). Oracle probes are
  metered (they are API calls — Token-Audit Completeness applies to count, not tokens).
- **No-token-material invariant:** no field of any persisted, audited, notified, or
  HTTP-served surface of this feature may contain token material; verify/repair diagnostics
  reference accounts by id only. Enforced by a §5 unit test scanning every emitted surface
  (FORBIDDEN_CREDENTIAL_FIELDS-style scan + `sk-ant-` literal match). **Error-string scrubbing
  (round-2 — the leak the field-name scan misses):** a malformed-blob `JSON.parse` error, a
  `security`/keychain stderr, or a fetch error can carry a token FRAGMENT inside a free-text
  `reason`/`error`/`message` string — which a field-name scan does not catch. So ALL error
  strings from swap/verify/probe/recovery are passed through a `redactToken`/`sk-ant-` scrubber
  (reuse `CredentialProvider.redactToken`) before reaching ANY persisted/served/notified surface.
  **Single emit chokepoint, not per-callsite discipline (round-3, the §0.g shape again):** every
  `logs/credential-swaps.jsonl` write, every `/credentials/*` response, and every attention-item
  construction routes through ONE `CredentialAuditEmit.scrub(record)` funnel that scrubs — so the
  invariant is structural, not "remember to scrub at each of N callsites" (Node's `JSON.parse`
  error is position-only and does not echo bytes, so the real leak vector is developer-authored
  interpolation like a `${raw}`-bearing log line or `security` stderr — exactly what a single
  chokepoint neutralizes). The §5 fuzz test INJECTS an `sk-ant-oat…`-bearing malformed blob
  through every error path and asserts THE FUNNEL emits nothing token-bearing (not just asserts
  on field names). The identity-oracle call MUST
  reuse `QuotaCollector.oauthGet`'s no-token-in-error discipline (errors built from
  `response.status` only — never the request, never the Bearer) rather than a fresh fetch
  wrapper that could re-introduce the token into a log line.
- Dashboard Subscriptions tab per census #11.

### 2.10 Env-token gate (the §0.b precondition, enforced)

At enable-time and per-pass the gate evaluates BOTH `config.anthropicApiKey` AND the LIVE
running fleet (round-2 — rev 2 checked only the config field). It refuses to run, with a named
reason on the status route, if ANY of:
- `config.anthropicApiKey` is **non-empty** — round-3 correction: NOT only an `sk-ant-oat`
  OAuth token. The code's launch predicate is binary (`SessionManager`): a `sk-ant-oat…` value
  sets `CLAUDE_CODE_OAUTH_TOKEN`, and ANY OTHER non-empty value (e.g. an `sk-ant-api03…` direct
  API key) sets `ANTHROPIC_API_KEY` — and both make claude-code ignore the per-`CLAUDE_CONFIG_DIR`
  store. So the gate predicate is "any non-empty `anthropicApiKey`", matching the code's
  `?? ''`-then-non-empty branch, not just the OAuth case.
- any running claude-code session was launched with an env credential (store-bypassing); OR
- any running session's `credentialSource` is `env` (round-3 material, GROUNDING CORRECTED in
  round-4). Rev 3 claimed the `launchLane:'rerouted-interactive'` interactive-pool lane sources
  `CLAUDE_CODE_OAUTH_TOKEN` from the server's process env / pool config — that is FALSE against
  the tree: all three claude-code launch lanes (`SessionManager.ts:1724`, `:1998`, `:3155`)
  build the Anthropic env from the IDENTICAL single expression keyed on `config.anthropicApiKey`,
  and the rerouted lane ALSO pins `CLAUDE_CONFIG_DIR`, so under an empty `anthropicApiKey` it
  reads the store and IS steerable. So env-vs-store is a pure function of one global config field,
  evaluated identically everywhere — not a per-lane distinction. The genuinely-mixed fleet is
  therefore reachable ONLY via a mid-run `anthropicApiKey` edit (some sessions spawned before,
  some after). That is exactly why the gate records a durable per-session
  `credentialSource: 'store' | 'env'` flag at spawn: NOT to distinguish lanes (they're
  identical), but so already-running store-sessions aren't mis-attributed when current config
  is re-read after a flip. **Single source of truth (round-4):** the flag MUST be derived from
  the IDENTICAL expression that selects the session's env block (`(config.anthropicApiKey ?? '')
  !== '' ? 'env' : 'store'` at spawn) — never an independent computation, or it re-creates the
  spawn-time-`subscriptionAccountId` staleness class this whole spec exists to kill. A spawn
  path that ever introduces a NON-`anthropicApiKey` env-token source MUST set the flag at that
  site (the default is `store`; an env-token launch that forgets the flag is a lint-caught bug,
  not a silent miss). The fleet scan reads the flag; the gate refuses (or, future work, steers
  only the `store` subset) whenever an `env` session exists. Checking the live fleet closes the
mid-life-flip hole: an operator setting `config.anthropicApiKey` to an OAuth token mid-run
would otherwise leave already-running store-reading sessions steerable while new env-token
spawns are silently un-steered — a genuinely mixed fleet the config-only check would freeze
incoherently. On refusal mid-life, the balancer also stops feeding `tenantOf(slot)` attribution
into QuotaPoller usage records for sessions that are now env-token. **Live applicability for
THIS deployment: confirmed alive** — `config.anthropicApiKey` is empty (§0.b), no running
session carries an env token, sessions read the per-`CLAUDE_CONFIG_DIR` store. Per-session
granularity (steering only the store-reading subset of a truly-mixed fleet) is deferred until a
real mixed deployment exists <!-- tracked: 20905 --> (future scope — no mixed env-token fleet exists today; revisit when one does).

### 2.11 Identity-oracle dependency — one place, per-consumer failure posture (round-2)

The oracle (`GET api.anthropic.com/api/oauth/profile`, E4b) is the trust root for placement,
verify, recovery, and divergence repair — the spec's largest single point of leverage and its
largest concentration of risk. Three reviewers asked "what happens when it's slow / wrong-shaped
/ rate-limited / spoofed?" and rev 2 answered differently per section. Consolidated, per
consumer:

| Consumer | Oracle slow / unavailable / 429 | Oracle wrong-shaped (schema change) |
|---|---|---|
| Pre-swap verify, DRAIN (§2.4) | fail-CLOSED — skip the drain (soft loss) | unparseable → treat as unavailable → skip |
| Pre-swap verify, WALL-avoidance (§2.4) | best-effort, fail TOWARD acting on ledger+quota truth; post-commit verify catches misplacement | same — act, rely on post-commit |
| Post-commit verify (§2.3.4) | quarantine the slot, NEVER repair; scheduled re-probe clears it | quarantine; surfaced |
| Seeding / boot recovery (§2.2) | refuse auto-assignment; attention item | refuse; attention item |
| Scheduled identity audit (§2.4) | skip this pass; no state change | degrade to config-metadata read + attention item (open-question 2) |

- **Integrity / MITM posture (round-2 material — rev 2 covered availability, not integrity).**
  The call is plain TLS via `fetch` with system CA trust and `AbortSignal.timeout` — no cert
  pinning. Because the oracle's answer DIRECTLY drives a credential write, a MITM returning an
  attacker-chosen `email` could suppress a real quarantine or steer a repair. Two cheap, always-on
  defenses: (1) any oracle email NOT in the pool → `unknown` → fail-closed (already specified);
  (2) **blob-unchanged-but-identity-changed cross-check** — if a slot's oracle identity flips
  between two probes while the slot's keychain blob bytes did NOT change, that is impossible under
  honest operation (identity is a function of the blob) and is surfaced as a divergence signal
  rather than acted on. This converts a silent spoof into a surfaced anomaly at zero cost.
- **Result classification — "identity-confirmed" is a NARROW predicate (round-3 material).**
  The oracle confirms identity ONLY when the 200 body's `email` is a non-empty STRING that maps
  to a known pool account. EVERY other outcome routes to the **unavailable** branch
  (quarantine-never-repair), never to "mismatch": a timeout / network error / 401 / 403 / 429 /
  5xx; a 200 whose body is unparseable; AND — the dangerous one — a 200 with a missing / null /
  empty / non-string `email`. A naive `body.email !== expected` treats `undefined !== expected`
  as `true` = mismatch = destructive repair, the exact inversion §2.3.4 forbids. The comparison
  must be "confirmed iff `isNonEmptyString(email) && poolHas(email) && email === expected`",
  with the negation explicitly classed as unavailable, not mismatch.
- **The cross-check defends blob-tamper-ALONE and identity-spoof-ALONE, not a COORDINATED
  blob+identity MITM (round-3 honesty).** A full MITM on the Anthropic TLS endpoint could change
  the blob (via the refresh exchange — also plain `fetch`) AND return a matching spoofed
  pool-member email, defeating the cross-check; the only remaining backstop is pool-membership.
  This residual is ACCEPTED, not closed: an attacker with full MITM on `api.anthropic.com`
  already defeats the Claude client itself and every refresh exchange, so cert-pinning HERE
  would not raise the floor while the client stays unpinned. Named as an inherited-from-client
  residual rather than implied-closed.
- The oracle endpoint is unversioned/undocumented; its schema-change failure mode is the
  fail-closed pause above, never a guess.

## 3. Signal-vs-authority decision points

| Decision | Authority | Notes |
|---|---|---|
| Execute a swap | `CredentialRebalancer` policy (code), Tier 0 (P7 justification §2.4) | autonomous; non-disruptive (E3/E4); verified by oracle |
| Quarantine / un-quarantine a slot | executor verify / scheduled re-probe | fail-safe direction both ways; auto-exit prevents pool shrinkage |
| Adopt vs repair on divergence | identity-oracle rule (§2.3): valid-known-account → adopt; else repair | "the world changed" ≠ "we broke it" |
| Trust the identity oracle's answer | system-TLS only + pool-membership filter + blob-unchanged-identity-changed cross-check (§2.11) | unversioned endpoint; integrity defended at zero cost, availability fails closed (drain) / toward-acting (wall) |
| Flip the default account | operator ask (conversational) → lever; detective controls (§2.4) | autonomy per operator directive; every flip loud + audited |
| Re-auth a dead credential | operator (irreducible) | targeted at the CURRENT slot per ledger (census #10) |
| Enable for the fleet | operator; maturation track | dev dry-run → dev live → fleet |

## 4. Migration parity

- New config block → `migrateConfig()` existence-checked defaults with EXPLICIT
  `enabled: false` + `dryRun: true` (round-2: NOT `enabled` omitted — this is a
  `DARK_GATE_EXCLUSIONS` `destructive` feature, §2.8; `migrateConfig`'s add-missing semantics
  install the explicit dark defaults on existing agents).
- New routes → CLAUDE.md template in BOTH sites: `src/scaffold/templates.ts`
  `generateClaudeMd()` (new agents) AND the `migrateClaudeMd()` content-sniffed section
  (existing agents). Proactive triggers: "flip my default account" → set-default lever;
  "which account is this session/slot on?" → `GET /credentials/locations`. Routes registered
  in `CapabilityIndex` (dev:preflight's new-route-prefix scan).
- `/switch-account` + `autoMigrate`: refusal-with-named-reason while enabled; deprecation
  noted in the template section that documents them.
- No `subscription-pool.json` schema change (reinterpretation documented in the pool's
  header comment). Ledger file created lazily on first enable; absence = dark.

## 5. Tests (all three tiers + the livetest battery)

- **Unit:** ledger journal recovery — crash simulated at EVERY phase boundary of the §2.3
  protocol (the staging escrow makes each decidable; rev-1's protocol fails this test by
  construction, which is the point); swap executor with fake stores + fake oracle —
  exchange, identity-verify, adopt-on-newer, repair-from-staging, quarantine,
  config-write-failure = metadata-repair path, keychain-then-config ordering,
  default-home `~/.claude.json` path; clobber-race interleavings (client write before/after
  verify; delayed re-verify heals; right account flagged); permutation property (no swap
  sequence duplicates a lineage); balancer policy — both sides of every boundary:
  wall beats drain, weekly-only drain, drain-exemption from eviction, per-pair + per-tenant
  cooldowns (incl. the 3-way rotation attack), fresh-data gate, urgency clamp, stale-quota
  source-only, dead-default eviction, 1-swap-per-pass, P19 sustained-failure (attempt count
  + cost), breaker reset; lever validation (unknown slot → 400, plus `../`/`~/evil`/absolute-path
  as slot → 400 with ZERO `security`/fs invocation); wall-override bypasses cooldowns at the
  critical mark; drain-destination hold (3-way rotation does not churn); source-slot CAS
  re-read adopts the client's rotated blob (the §2.3.1a strand-prevention path); staging
  RETAINED until delayed re-verify, deleted only after; recovery-from-staging applies
  adopt-on-newer (never blind-overwrites a newer on-disk blob); oracle-unavailable-at-verify
  quarantines NEVER repairs; oracle posture split by objective (drain fail-closed, wall acts);
  blob-unchanged-identity-changed cross-check surfaces; no-token-material scan over every
  emitted surface PLUS an `sk-ant-oat…`-bearing malformed blob fuzzed through every error path
  (asserts the `CredentialAuditEmit` funnel emits nothing token-bearing); config clamp behavior
  per knob. **Round-3 cases:** wall-override CAP — two slots ≥95% in one pass ⇒ exactly
  `maxForcedSwapsPerPass` forced swaps, remainder next pass; override budget exhausted ⇒ surfaced
  terminal state (degradation + attention), never loop; wall rescue REFUSES a target whose last
  identity verify is stale/failed (the dead-target-into-live-slot case) and prefers a recently
  audited target; default eviction caps consecutive forced evictions + serves last-known-good
  when NO slot is oracle-verifiable (correlated-outage floor); restore-enrollment over an
  UNPARSEABLE quarantined blob parks ONE-DIRECTIONALLY and leaves the healthy enrollment slot
  intact; oracle 200-with-missing/empty/non-string-email classes as UNAVAILABLE (quarantine),
  never mismatch; source-slot RESIDUAL window — a client write landing AFTER the final re-read
  creates a strand that §2.3.6 re-verify / the scheduled audit detect-and-flag (the residual's
  only test backstop); recovery-barrier HANG ⇒ bounded timeout quarantines the wedged slot +
  lifts the barrier; CredentialWriteFunnel lint catches both `defaultCredentialStore.write` AND
  the `security -i` stdin `add-generic-password` form.
- **Wiring-integrity (round-2 — required for every DI'd component):** `CredentialLocationLedger`,
  `CredentialSwapExecutor`, `CredentialRebalancer`, and the identity-oracle client are wired
  non-null and delegate to REAL implementations — especially the oracle (a no-op/stub oracle
  would silently green every identity check, the §2.3 worst case); a `CredentialWriteFunnel`
  lint test asserts no direct `defaultCredentialStore.write`/`add-generic-password` callsite
  exists outside the funnel.
- **Integration:** routes over the full HTTP pipeline (dark = 503, enabled = live,
  `dark-with-divergent-ledger` reported); QuotaPoller through the ledger — happy read AND
  the 401-refresh path AND email-patch suppression (the three poisoning regressions);
  spawn placement current-slot resolution; restart-swap family ledger resolution;
  `/switch-account` refusal (at the MANAGER, proving a non-route caller is also refused); pool
  configHome PATCH refusal; **Bounded-Notification-Surface burst test (round-2):** a single pass
  that quarantines / finds divergence on N slots at once, and boot recovery flagging multiple
  in-flight slots, each AGGREGATE into ONE summary attention item carrying the list — never N
  topics (the worktree-detector flood shape; asserts against the topic-creation budget);
  **env-token gate (round-3):** a non-empty `anthropicApiKey` (OAuth OR `sk-ant-api03` key)
  refuses; a live `launchLane:'rerouted-interactive'` / subscription-path pool session refuses
  (or steers only the `credentialSource:'store'` subset, explicitly) — proving the gate reads
  per-session provenance, not just the config field.
- **E2E:** server-startup wiring (alive when enabled, 503 dark); boot recovery from a
  journal mid-swap state INCLUDING the concurrent-consumer window (spawns + polls during
  recovery are fail-closed for the in-flight slots only).
- **Livetest battery (dev agent, gate for dry-run → live promotion):** (a) E3/E4 re-proven
  against the SHIPPED executor (swap under a running session; next-call actuation; zero
  interruption); (b) **default-slot swap + swap-back under a running default-home session**
  — the slot whose keychain ACL is NOT covered by the existing funnel's history (the
  refresher only ever wrote enrolled homes; the default entry was claude-created; ACL
  behavior is empirical) and the slot that IS the CMT-1337 payoff; (c) post-swap hourly
  refresher correctness on both slots; (d) the §0.c residual: a deliberately-minted
  disposable second grant, swapped under a live session past access-token expiry, settles
  the in-memory write-back question with zero risk to org lineages.

## 6. Risks + rollback

| Risk | Mitigation |
|---|---|
| Crash mid-exchange destroys a blob | staging escrow (§2.3.2, COPY-not-move; retained through §2.3.6) — every crash point decidable incl. between-the-two-keychain-writes; unit-tested at every boundary |
| Client refresh on SOURCE slot mid-swap strands a rotated lineage (§2.3.1a) | source-slot CAS re-read immediately before the destructive write (adopt the client's newer rotated blob); window narrowed not closed against an external writer; identity audit + delayed re-verify catch the residual; blast radius one re-auth |
| Client refresh IN FLIGHT during swap (sub-2-min) | delayed re-verify ~90s (§2.3.6); staging retained as heal source until it passes; adopt-on-newer; right-account flagging |
| Client at-expiry write-back (HOURS later, §0.c residual) | NOT the 90s check — the always-on scheduled identity audit (§2.4) is the detector; dogfood (d) settles it empirically; blast radius one re-auth |
| Oracle unavailable during a write decision | per-consumer posture (§2.11): verify quarantines never repairs; drain fail-closed; wall acts-toward; recovery refuses auto-assign |
| Oracle spoof / MITM | system-TLS + pool-membership filter + blob-unchanged-identity-changed cross-check (§2.11) surfaces it at zero cost |
| Dev-gate ships live-with-writes on Echo | `DARK_GATE_EXCLUSIONS` destructive, explicit `enabled:false`+`dryRun:true`; lint assertion C enforces; live needs a deliberate two-flag flip (§2.8) |
| Wall-rescue target died AFTER its last clean audit (wall path skips pre-verify) | recency gate NARROWS not closes; bounded blast radius = victim slot quarantined + one re-auth, surfaced (§2.3.6 + post-commit verify); accepted price of the oracle-split that avoids outage-walls-a-session (§2.4) |
| Correlated oracle outage: default last-known-good is itself dead | floor preserves last-known-good + attention item, never empties/churns the default; cannot CERTIFY liveness (oracle is the only signal, and it's down) — honest guarantee is "no worse", not "working" (§2.4) |
| Frankenstein / incoherent blob exchanged into a healthy slot during teardown | restore-enrollment identity-coherence check (access-tenant == refresh-lineage); incoherent → one-directional park, never exchanged (§2.8) |
| Repair overwrites a newer rotated credential | adopt-on-identity-match rule; never write older than on-disk; CAS re-read before repair |
| Ledger diverges from keychain reality | derived-not-assumed via profile oracle; adopt rule for exogenous change; ambiguity refuses + surfaces |
| QuotaPoller poisoning (tokens/refresh/email/reauth) | census #1-#4 conversions + three dedicated regression tests |
| Legacy writer destroys a lineage | census #9/#10 refusals; AccountSwitcher disposed |
| Keychain ACL prompt or hang | async execFile + 10s timeout; abort-clean before first write; default-slot ACL settled empirically in livetest (b) |
| Balancer thrash | 1-swap/pass, pair + tenant cooldowns, fresh-data gate, urgency clamp, drain exemption, stale-source-only |
| Sustained failure loop | P19 breaker + DegradationReporter + cost-bounding test |
| Wrong-slot reads after disable | ordered rollback: reads stay ledger-resolved until restore-enrollment completes |
| Feature misbehaves in the wild | dark fleet; Echo dry-run → live promotion gates; maturation track; restore-enrollment lever |

## 7. Open questions for convergence

1. ~~Does `claude auth status` honor `CLAUDE_CONFIG_DIR`?~~ ANSWERED (E1: yes,
   side-effect-free) — and superseded: E4a disqualified it as the verify oracle; the
   profile endpoint (E4b) replaced it.
2. ~~The `api/oauth/profile` endpoint is unversioned/undocumented — is a global pause the
   right degraded mode?~~ RESOLVED (round-2, §2.11): NOT a global pause — the posture splits
   per consumer. Drain verify fails CLOSED (skip); wall-avoidance verify acts TOWARD the rescue
   (post-commit verify catches a rare misplacement) because fail-closed there inverts the very
   objective; post-commit verify quarantines (never repairs) on an unreachable oracle; the
   scheduled audit degrades to config-metadata + attention-item. Integrity (MITM) defended by
   the pool-membership filter + blob-unchanged-identity-changed cross-check.
3. Per-model weekly windows (`seven_day_opus` etc.) — steer drain by the binding sub-window
   or treat the 7d aggregate as binding for v1?
4. ~~`restore-enrollment` semantics when a slot is quarantined?~~ RESOLVED (round-2, §2.8): it
   requires quiescence of the BALANCER only (single-mover mutex) and must NOT refuse on
   quarantine — it carries a quarantine BYPASS, since it is a teardown and refusing on
   quarantine would hard-block rollback in exactly the degraded state that motivates it.
   Displaced quarantined blobs are parked with an attention item.
5. (NEW, round-2) The §0.c at-expiry in-memory write-back remains the one empirically-unsettled
   premise; the design treats it as live (detect+heal via the scheduled audit) and §2.8 dogfood
   (d) settles it with a disposable grant. Re-confirm the audit's per-slot identity probe is
   genuinely always-on (not scoped to quarantined slots) in the build.
