---
title: "Threadline Duplicate-Identity Silent-Drop — client resolves to the LIVE registration + stop minting orphan identities"
slug: threadline-duplicate-identity-resolution
eli16-overview: threadline-duplicate-identity-resolution.eli16.md
status: draft
supervision: tier0
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
approved: true
approval-context: "Approved by Justin 2026-06-09 (topic 23178) after reading the convergence report (view 770d4521). The 3-round convergence sharpened/redirected the design (relay-ordering → client-side resolver) but the operator approved the converged result explicitly with 'approved'."
lessons-engaged:
  - "L7/B12 Bug-fix evidence bar — v1 of this spec targeted the relay's RegistryStore.search() ORDER BY, but the instar send path resolves names in the CLIENT (ThreadlineClient.findAgentByName), which discards relay ordering, throws on same-name ambiguity, and has no online field. Convergence (5 reviewers, unanimous blocking) re-grounded the fix onto the exact user-facing path. This v2 is the on-path design."
  - "Sibling of #479 (threadline-identity-discovery-unification, converged+approved 2026-05-28). #479 fixed what an agent ADVERTISES; this fixes what a SENDER RESOLVES when a stale twin already exists, and stops the source that mints the twin. #479's Non-goal explicitly fenced off retiring identity-keys.json ('deleting risks the handshake path; needs its own spec') — this spec is that spec, and rebuts the risk with evidence (see §Relationship to #479)."
  - "P2 Signal vs Authority — the client resolver change is a selection-preference (prefer the live registration), and it NEVER silently picks among multiple live same-name rows (it surfaces ambiguity). No new blocking authority; no message is dropped or blocked."
  - "P10 Comprehensive-First — the on-path client fix ships in this PR (the recurrence-risking part is built now, not postponed); the only tracked remaining item is the inert-file housekeeping sweep."
review-convergence: "2026-06-09T23:11:09.522Z"
review-iterations: 3
review-completed-at: "2026-06-09T23:11:09.522Z"
review-report: "docs/specs/reports/threadline-duplicate-identity-resolution-convergence.md"
cross-model-review: "skipped (abbreviated)"
cross-model-review-reason: "Abbreviated internal-only convergence per skill allowance: 5 internal perspectives across 11 subagent passes (security, scalability, adversarial, integration, lessons-aware ×3 rounds). Lessons-aware (mandatory anti-circular check) ran every round and returned CONVERGED. External GPT/Gemini/Grok skipped to manage cost on a well-scoped client-side fix."
---

# Threadline Duplicate-Identity Silent-Drop

## Problem (observed 2026-06-09, topic 23178)

The Luna/SageMind agent reported: *"Echo's channel is wedged. His replies aren't reaching me
(the thread reads empty, and there are two 'echo' identities on the relay, one of which silently
drops)."* Luna and Echo run on the same Mac.

Grounded diagnosis against current `main` (v1.3.451) and the running agent (v1.3.450):

1. **Echo's own advertisements are already canonical.** PR #479 made `announcePresence` and
   `/threadline/health` advertise the canonical routing identity (`63b1dbb2…`) via
   `IdentityManager.get()`, plus `PostUpdateMigrator.migrateThreadlineAgentInfoIdentity`. Verified
   live: `agent-info.json` and `/threadline/health` both report `63b1dbb2…`. **No announce-side bug
   remains.**

2. **A stale duplicate registration survives on the relay.** The relay's persistent registry
   (`src/threadline/relay/RegistryStore.ts`) keys agents by `public_key` and survives deploys
   (`ConnectionManager.ts:291`). Before #479, an older Echo client registered the orphan key
   `64cab8bc…` — minted by `ThreadlineBootstrap.loadOrCreateIdentityKeys` independently of the
   canonical identity. That second "echo" row (same `name`, different `public_key`) is still present.

3. **The send path resolves names in the CLIENT, and the client cannot tell the live row from the
   dead one.** This is the corrected root (v1 of this spec misattributed it to the relay search
   ordering). The `threadline_send` path is: route `/threadline/relay-send`
   (`src/server/routes.ts:17533`) → `ThreadlineClient.resolveAgent(name)`
   (`src/threadline/client/ThreadlineClient.ts:346`) → `findAgentByName`
   (`ThreadlineClient.ts:393-446`). The client:
   - Ingests discovery into a `Map` keyed by **fingerprint** (`ThreadlineClient.ts:184-189`), so a
     live `63b1dbb2` and a dead `64cab8bc` coexist as two cache entries and the relay's result
     ordering is discarded.
   - Stores `KnownAgent` (`ThreadlineClient.ts:27-35`) with **no `online`/`status` field** — even
     though the relay's `discover_result` frame carries an accurate per-agent `status`
     (`relay/types.ts:139`; `RelayServer.ts:1182` derives it from **live presence**, not the stale DB
     `online` column).
   - In `findAgentByName`, with two same-name rows it **throws `Ambiguous agent name`**
     (`ThreadlineClient.ts:404-419`) with no liveness preference. With exactly one cached row (e.g.
     a stale `64cab8bc`-only cache from a pre-#479 discovery), it returns that one — the dead
     fingerprint — and the send goes to a fingerprint with no live socket.

4. **The drop itself.** Routing is sound — `MessageRouter` routes by fingerprint and requires an
   OPEN socket (`MessageRouter.ts:96,114-115`); a send to a dead fingerprint returns
   `RECIPIENT_OFFLINE` and is offline-queued for a fingerprint that never reconnects. So a resolution
   to `64cab8bc…` is accepted-for-queueing (soft success to the sender) but never delivered — Luna's
   "silently drops / thread reads empty." When two rows are cached instead, the failure is a loud
   ambiguity throw. **Both outcomes are the same root: the client cannot prefer the live registration.**

5. **The source keeps minting the twin.** `loadOrCreateIdentityKeys` still creates
   `threadline/identity-keys.json` on every agent, but its result (`identityKeys`) is consumed nowhere
   — verified: references are the type field (`ThreadlineBootstrap.ts:68`), the assignment (`:99`),
   and the returned field (`:339`); `grep '\.identityKeys' src/` outside that file = 0 hits;
   `src/commands/server.ts` does not destructure it. Dead code that still mints the exact artifact
   (a second, non-routable identity) that pollutes the registry.

## Goal

Make a SENDER resolve a name to the **live** registration whenever exactly one same-name registration
is live, refresh a stale cache so a dead twin can't win by being cached, and stop the source from ever
minting a second non-routable identity again — closing the duplicate-identity silent-drop class on the
exact path the user hits.

**Constitutional anchor — Cross-Machine Coherence ("One Agent, Robust Under Degraded Conditions").**
A single agent appearing on the relay as *two* "echo" registrations — one live, one a dead leftover —
is precisely the failure that standard forbids: "remains ONE coherent agent, never two." The standard
also governs how "cross-machine paths resolve peers," and the degraded condition here (a stale
registration left by a prior identity) is exactly the not-happy-path it demands robustness on. This
change makes a peer's name-resolution land on the single live identity under that degraded condition,
and surfaces a *genuine* multi-machine/impostor duplicate as ambiguity rather than silently guessing —
keeping the agent whole across the network instead of letting a ghost twin swallow its mail.

## Design — the fix is CLIENT-SIDE and single-deployable

The relay already does the right thing: `handleDiscover` derives each agent's `status` from **live
presence** and sends it in `discover_result` (`RelayServer.ts:1168-1207`). The fix is to **consume
that signal** in the client resolver. All changes ship in the agent package via the normal
auto-update path; **no relay deploy is required.**

### A. `KnownAgent` carries liveness — MERGE, never replace (`src/threadline/client/ThreadlineClient.ts`)

Add `online?: boolean` to `KnownAgent` (and retain `lastSeen`). In the `discover-result` handler
(`:184-189`), map the wire frame's per-agent `status` (`'online'|'offline'`) onto `KnownAgent.online`.
The frame already carries it (`relay/types.ts:139`); the client currently discards it by typing
`result.agents` as `KnownAgent[]`.

**Critical — merge, do not replace.** The `discover_result` frame's agents are **keyless** — they
carry `agentId/name/framework/capabilities/status/lastSeen` but NOT `publicKey`/`x25519PublicKey`
(`relay/types.ts:132-143`). Today's handler does `this.knownAgents.set(agentId, agent)` — a full
replace — which would strip the crypto keys from a previously-keyed cache entry (one populated by
`registerAgent` or a prior handshake), silently regressing any E2E `send()` for that peer to the
plaintext path. The handler MUST therefore **merge**: `{...existing, ...frame, online: status ===
'online'}`, preserving `publicKey`/`x25519PublicKey`/`lastSeen` when the frame omits them. Discovery
entries are keyless **by design**; name-resolved sends to discovered peers use the relay
plaintext-authenticated path (transport TLS + Ed25519 relay auth), not E2E — unchanged by this spec
(see §Security). A unit test must assert a pre-seeded keyed entry **retains its keys** after a keyless
`discover_result`, and that `online` is set.

### B. `findAgentByName` prefers the single live registration; surfaces genuine ambiguity (`ThreadlineClient.ts`)

Revised resolution rule, applied BEFORE the existing ambiguity throw, in BOTH the exact-match branch
(`:402-419`) AND the partial-match branch (`:422-443`) — the rule must be identical in both so a
same-name pair reachable only via substring match behaves the same:

- **Exactly one match → return it** (unchanged).
- **Multiple matches, exactly ONE is `online` → return the online one.** This is the core fix: a
  live-vs-dead pair resolves to the live registration instead of throwing.
- **Multiple matches, MORE THAN ONE is `online` (different keys) → throw the existing ambiguity error**
  (require `name:fingerprint`). This deliberately does NOT silently pick — it covers both the
  multi-machine-two-keys case and the same-name-impostor case safely (see §Security). The ambiguity
  error text should point the caller at BOTH the `name:fingerprint` syntax AND the user-curated
  nickname path, so a legitimate multi-machine user has a clear next step.
- **Multiple matches, NONE online → existing behavior** (ambiguity throw, or fingerprint-prefix
  disambiguation).

A `fingerprintPrefix` (the `name:fingerprint` syntax) always wins over the online preference, exactly
as today.

### C. Cache-freshness so a stale dead-only cache can't win (`ThreadlineClient.ts resolveAgent`)

`resolveAgent` already re-discovers on a cache MISS (`:358-364`). Extend it: when `findAgentByName`
resolves to an **offline** agent (the stale `64cab8bc`-only case), re-discover once and re-resolve
before returning. Effect: a cache holding only the dead `64cab8bc` is refreshed → the live `63b1dbb2`
appears (relay sends both with live status) → rule B picks the live one.

Three behaviors this change MUST specify (round-2 completeness):

- **Terminal when still-offline after re-discovery.** If, after one re-discovery, the best (and only)
  same-name match is *still* offline (the live twin genuinely isn't online), **return that offline
  fingerprint** — preserving today's offline-queue semantics (a legitimately-offline peer should still
  receive an offline-queued message; do NOT regress to a 404) — and emit a structured warning/log so
  the soft-success is observable. If re-discovery instead yields two now-online same-name rows, the
  ambiguity throw from rule B propagates (no silent pick, no retry loop). `resolveAgent` does not catch
  the throw — it surfaces to the route as an error, which is the correct safe outcome.
- **Rate-limit interaction.** Discovery is rate-limited at 10/min per agent; on limit the relay sends
  an `error` frame, but `discover()` today only resolves on a `discover_result` event or its 10s
  timeout (`ThreadlineClient.ts:324-337`) — so a re-discovery under throttle would silently hang ~10s.
  Change C must therefore (i) make `discover()` resolve early when a `RATE_LIMITED` error frame
  arrives, and (ii) gate the offline-triggered re-discovery behind a short per-name cooldown so a burst
  of sends to offline targets cannot exhaust the discovery budget. Worst-case added latency (one
  re-discovery, ≤ the discover timeout) is documented here rather than hidden.
  - **Early-resolve filter (precision):** the `'error'` event is shared by ALL error frames (e.g. a
    concurrent send's `RECIPIENT_OFFLINE`), and the rate-limit frame carries no correlation id. The
    early-resolve listener MUST therefore filter on `code === RELAY_ERROR_CODES.RATE_LIMITED` and ignore
    every other error frame, or `discover()` could spuriously resolve `[]` on an unrelated error and mask
    a real result. A unit test asserts a stray non-rate-limit error frame does NOT early-resolve
    `discover()`.
  - **Cooldown mechanism (precision):** implement the per-name cooldown as a process-local
    `lastRediscoverByName: Map<string, number>` on `ThreadlineClient` (mirroring the existing
    `lastThreadByPeer` affinity map and its `nowFn` test seam), consulted in `resolveAgent` before an
    offline-triggered re-discovery; default window ~30s. The `nowFn` seam keeps it unit-testable.
- **Freshness source is discovery only — presence-change is intentionally NOT used.** The resolver's
  `ThreadlineClient` never calls `subscribe()` (only the listener daemon's raw `RelayClient` does), so
  `presence-change` frames never reach the resolver's cache; wiring a `knownAgents.online` update into
  the presence-change handler would be dead code. This spec deliberately does NOT modify the
  presence-change handler; re-discovery (change C) is the sole freshness mechanism. (Real-time
  freshness via `subscribe()` + cache update is a larger change, out of scope.)

Bounds: at most one extra discovery per resolve, only when the best match is offline and the per-name
cooldown allows; no change when the cached match is already live.

### D. Stop minting the orphan identity (`src/threadline/ThreadlineBootstrap.ts`)

Remove `loadOrCreateIdentityKeys` and the dead `identityKeys` field from `ThreadlineBootstrapResult`
(and its construction site). Output consumed nowhere (verified). HandshakeManager and the relay client
source identity via `IdentityManager` / `identity.json` and are untouched. Existing `identity-keys.json`
files on disk become inert (already are); we stop creating new ones. A destructive fleet sweep of the
inert files is explicitly out of scope; it is tracked below. <!-- tracked: topic-23178 -->

## Relationship to #479 (rebutting its handshake-risk Non-goal)

#479's Non-goal stated: *"Retiring the now-unused `identity-keys.json` / consolidating the keypairs is
a separate cleanup… deleting risks the handshake path and needs its own spec."* This is that spec, and
the handshake risk does not apply to change D: `HandshakeManager.getOrCreateIdentity()` reads
`{stateDir}/identity.json` (the canonical file) via its own constructor — never
`threadline/identity-keys.json` (verified). The relay client's `MessageEncryptor` sources identity via
`IdentityManager` (canonical → legacy `threadline/identity.json`), also never `identity-keys.json`.
Removing `loadOrCreateIdentityKeys` therefore cannot touch the handshake or encryption path; it only
stops writing a file nothing reads.

## Security considerations

- **Name discovery is unauthenticated.** Registration binds the public key cryptographically
  (`ConnectionManager.ts:178-214`) but NOT the `name` (`:300` takes it verbatim). Anyone can register
  the name "echo". This is pre-existing and unchanged by this spec.
- **Prefer-online must never silently pick among multiple live same-name rows.** Rule B returns the
  online row ONLY when exactly one same-name row is online. When two are online (an impostor staying
  connected alongside the real Echo, or a genuine multi-machine pair), it throws the ambiguity error
  and requires a fingerprint — so online-preference cannot be gamed by an impostor merely staying up to
  silently capture a name-send. This is the key difference from v1 (which would have ranked a live
  impostor to the top of a relay search).
- **Future hardening (not depended on):** the registry has a `verified` column with no current writer.
  If/when verification lands, a verified fingerprint should tiebreak above raw liveness. Out of scope
  here; noted so the resolver's preference order leaves room for it.
- **Resolution is TOFU and the resolved fingerprint is PERSISTED as the thread trust anchor.** The send
  route writes the resolved fingerprint as the canonical thread owner (`routes.ts captureOrigin`). So a
  first-contact send while the real Echo is *genuinely offline* and only an impostor "echo" is online
  would deterministically resolve to — and pin — the impostor. This is a pre-existing TOFU property
  (current code already returns a single cached row), not introduced by this spec, but rule B makes the
  offline-victim wrong-pick more deterministic, so it is called out here. Mitigations: (a) the
  user-curated nickname path remains the authoritative anchor for known peers and is unaffected; (b) the
  future `verified`-tiebreak above; (c) change C's re-discovery runs *before* a pin, so a victim that is
  actually reachable is found. The exactly-one-online rule (never auto-pick when ≥2 are online) means an
  impostor cannot capture a name while the real agent is connected — only during a genuine outage of the
  real agent, which is a network-DoS precondition outside this spec.
- **Name-resolved sends use the relay plaintext-authenticated path, not E2E.** Because discovered
  `KnownAgent` entries are keyless (§A), `sendAuto` delivers via the relay plaintext path (transport TLS
  + Ed25519 relay auth), exactly as name-sends work today. This spec does not change that posture; E2E
  applies only when the caller already holds the peer's keys.

## Multi-machine

`identity.json` is NOT part of cross-machine secret sync (`SecretSync` replicates vault secrets like
`telegram.token`, not the identity file). So an agent running on two machines that each self-generated
an identity has **two same-name rows with different keys**, both potentially online. Rule B handles
this safely: two online same-name rows → ambiguity surfaced, the sender must address by fingerprint.
Auto-merging multi-machine identities is a **non-goal**. (The relay's displacement model
— `ConnectionManager.ts:228-238`, "another device connected with the same identity key" — only
collapses machines that share one key; that broader coherence question is tracked separately, not
solved here.)

## Non-goals (complete decisions, nothing left open)

- **No relay-side change.** The relay already sends live status; the client fix fully closes the
  instar→instar path. Re-ranking the relay's `RegistryStore.search()` (v1's approach) is dropped — it
  is off the send path, tears keyset pagination, and amplifies name-spoofing. Third-party/non-instar
  clients that take a relay top-result are out of scope.
- **No change to the 90-day stale-cron thresholds**, and **no default stale-exclusion** (v1's change B
  is dropped — it would hide legitimately-dormant agents from name search).

## Testing (all three tiers, on the REAL resolver — per the Testing Integrity Standard)

- **Unit (`tests/unit/threadline/`)** — drive `ThreadlineClient.resolveAgent` / `findAgentByName`
  directly:
  - two same-name known agents, one `online:true` (live `63b1dbb2`) + one `online:false`
    (dead `64cab8bc`) → resolves to the live fingerprint (NOT a throw). **This test fails on current
    `main` and after any relay-only change — it is the on-path regression guard.**
  - two same-name, BOTH online → still throws ambiguity (require fingerprint).
  - one cached offline-only match → `resolveAgent` re-discovers and resolves to the live row (mock the
    re-discovery to add the online row).
  - `KnownAgent.online` is populated from a `discover_result` whose agent `status:'online'`.
  - **Key-retention (merge, not replace):** a pre-seeded keyed `KnownAgent` retains its
    `publicKey`/`x25519PublicKey` after a keyless `discover_result` updates its `online` flag (§A).
  - **Change-C terminal cases:** re-discovery that adds the online row → resolves to it; re-discovery
    that yields two now-online rows → propagates the ambiguity throw (no silent pick, no loop);
    re-discovery that stays offline → returns the offline fingerprint with a structured warning (no
    404 regression).
  - **Partial-match parity:** the online-preference applies in the partial-match branch too.
  - `ThreadlineBootstrap`: no `identity-keys.json` is created; result type no longer carries
    `identityKeys`.
- **Integration test for change C** — seed a keyed entry, deliver a real keyless `discover_result`,
  assert `online` is set AND the keys survive, and that an offline-best-match resolve fires exactly one
  re-discovery (asserting the rate-limit early-resolve path does not hang).
- **Integration (`tests/integration/`)** — full client↔relay path: seed the registry with a live + a
  dead same-name registration, run discovery, resolve the name, assert the resolved fingerprint is the
  connected one and a message addressed via the name reaches the live socket.
- **E2E (`tests/e2e/threadline/`)** — wiring: stand up the relay with a live + stale same-name pair,
  perform a name resolution through the real client, assert resolved fingerprint == the connected
  registration's fingerprint (the dead twin never wins while a live twin exists).
- **Test parity for change D (Zero-Failure Standard)** — in `tests/unit/threadline/ThreadlineBootstrap.test.ts`:
  - **Delete whole tests** that are meaningless after D (they assert the orphan file's existence /
    persistence / perms / regeneration): "persists identity keys" (~:65-87), "creates …identity-keys.json"
    (~:89-100), "restrictive permissions" (~:102-116), and "handles corrupted identity key file" (~:257-274).
    These cannot be salvaged by line-edits — the behavior they test is removed.
  - **Update** the `result.identityKeys` assertions (~:57-59, 83-86, 272-273) and **keep** the
    canonical-identity-advertisement test (~:227, "advertises the canonical identity even when the orphan
    identity-keys.json is present"), which survives and is still valuable.
  - The removal also makes `ThreadlineBootstrapResult.identityKeys` a type error at the above sites — fix
    before tests run. The exported type is re-exported at `src/threadline/index.ts:174`; removing the
    field is non-breaking (verified: no importer reads it). The e2e `ThreadlineFullStack.test.ts` uses a
    LOCAL `identityKeys = generateIdentityKeyPair()` for an AgentCard — unrelated, leave it.
  - **CI guard (corrected):** gate on the **function name** — `grep -rE "loadOrCreateIdentityKeys" src/`
    returns zero hits after D, so re-introducing orphan minting fails CI. Do NOT also gate on the bare
    string `identity-keys.json`: `src/core/PostUpdateMigrator.ts` deliberately RETAINS an
    `identity-keys.json` mention in the #479 `migrateThreadlineAgentInfoIdentity` doc comment (it must
    not be removed by D), so that grep would false-positive on correct code. And do NOT gate on
    `generateIdentityKeyPair` — it has many legitimate callsites (`HandshakeManager`, `relay/A2ABridge`,
    `ThreadlineCrypto`, `IdentityManager`, `KeyRotation`, `RegistryAuth`, the index re-export).

## Deployment, migration, rollback

- **Single deployable:** all changes ship in the agent package via auto-update. No relay deploy.
- **Migration Parity:** change D needs no `PostUpdateMigrator` entry (it only stops writing an unused
  file; self-heals — the inert file is simply never recreated). The client resolver change (A–C) is
  in-process and reaches the fleet on the next **server/session restart** after the update activates —
  the in-memory `knownAgents` cache cannot be migrated, only refreshed on restart. Caveat: per the
  known AutoUpdater behavior, activation is held off while sessions are active, so "reaches the fleet
  via auto-update" lands only when the shadow install activates + the session restarts.
- **Agent Awareness:** no CLAUDE.md template change — transparent correctness fix, no new agent-facing
  endpoint/knob. (The routing-fingerprint awareness #479 added already covers the operator-facing
  guidance "address me by fingerprint.")
- **Supervision tier0:** no policy/LLM-judgment surface — deterministic resolution preference + dead-code
  removal.
- **Rollback:** revert the relevant PR. A–C are pure client logic (no persisted state); D reinstates a
  write-only function. No data migration either way.

## PR structure (no batched bundling)

- **PR 1 (Tier 2):** client resolver — A + B + C (`ThreadlineClient.ts` + `KnownAgent` + tests). The
  on-path fix.
- **PR 2 (Tier 1):** orphan-minting removal — D (`ThreadlineBootstrap.ts` + test parity). Small,
  low-risk, dead-code removal.

Each PR carries its own side-effects artifact and cites this spec.

## Tracked remaining items (Phase 4.5) <!-- tracked: topic-23178 -->

- Housekeeping sweep to remove inert `threadline/identity-keys.json` files fleet-wide is out of scope:
  the files are inert after D, and a destructive fleet file-sweep is a separate risk surface deserving
  its own review. <!-- tracked: topic-23178 -->
- A `verified`-fingerprint tiebreak in the resolver awaits a `verified`-column writer landing
  (none exists today). <!-- tracked: topic-23178 -->
